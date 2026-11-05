import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { Plan } from '@cosmika/db'
import type { ApiErrorCode } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

import { AiUsageService } from './ai-usage.service'
import {
  currentBillingMonthStart,
  nextBillingMonthStart,
} from './billing-month'
import {
  AI_ALLOWANCE,
  absoluteLimit,
  billableOverage,
  PLAN_CAPS,
  PlanCaps,
  PlanLimitDimension,
} from './plan-limits'

class PaymentRequiredException extends HttpException {
  constructor(body: { code: ApiErrorCode; message: string }) {
    super(body, HttpStatus.PAYMENT_REQUIRED)
  }
}

/**
 * Refusal for the one operation the terms DO say to reject over the limit: a
 * bulk import that would take the account past its absolute limit in a single
 * batch. 422 rather than 402 — the request is well-formed and the account is
 * paid up, the batch is simply too big for the plan.
 */
export class ImportTooLargeException extends HttpException {
  constructor(
    readonly detail: {
      current: number
      incoming: number
      limit: number
      plan: Plan
      suggestedPlan: Plan | null
    },
  ) {
    super(
      {
        // `code` so the web side can say this in the operator's own language,
        // and the numbers alongside it so the message can name the plan that
        // would fit instead of just refusing.
        ...errBody(
          'plan_limit_exceeded',
          `This import would take the account to ${detail.current + detail.incoming} contacts, ` +
            `past the ${detail.limit} allowed on ${detail.plan}.`,
        ),
        ...detail,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}

/** Percentage of a cap at which the customer is warned (published policy). */
export const WARN_AT_PERCENT = 90

export type MeterKey = 'newConversations' | 'totalConversations' | 'contacts'

export type UsageMeter = {
  key: MeterKey
  used: number
  /** The plan's cap, or null when the plan does not cap this dimension. */
  cap: number | null
  /** Cap plus the plan's tolerance, or null when there is none. */
  absoluteLimit: number | null
  /** Used as a percentage of the cap, or null when uncapped. */
  percent: number | null
  /** Usage above the cap that would actually be billed (decision 2). */
  billableOver: number
}

export type AiUsageSummary = {
  /** Conversations the AI answered in this billing month. */
  conversations: number
  /** Included in the plan, or null when the plan does not count them. */
  included: number | null
  /** BRL per extra conversation, or null when the plan has no AI overage. */
  overagePriceBrl: number | null
  /** The customer's own monthly ceiling in BRL, or null for none. */
  capBrl: number | null
  /** Conversations above the allowance. */
  overConversations: number
  /** What those extra conversations would cost this month, in BRL. */
  estimatedOverageBrl: number
  /** When the allowance goes back to zero, ISO date-time. */
  resetsAt: string
}

export type PlanUsage = {
  plan: Plan
  caps: PlanCaps
  newConversationsThisMonth: number
  totalConversations: number
  contacts: number
  ai: AiUsageSummary
}

/**
 * What the account should be told about its usage right now.
 *
 * `state` is the single thing the UI switches on:
 *   ok        nothing to say
 *   warn      90% of some meter, or 80% of the AI allowance
 *   upgrade   at or past a meter's absolute limit, or out of AI allowance on
 *             a plan with no overage — the case where an upgrade is the only
 *             way to get more
 *   overage   over a cap on a plan that bills overage: informational, with an
 *             estimate of what the month will cost
 */
export type UsageState = 'ok' | 'warn' | 'overage' | 'upgrade'

export type UsageEvaluation = PlanUsage & {
  state: UsageState
  meters: UsageMeter[]
  /** Meters at or above the warn threshold, worst first. */
  warning: MeterKey[]
  /** Estimated plan overage for the month, in BRL. */
  estimatedPlanOverageBrl: number
}

/**
 * Per-unit overage prices from the published terms. Display only: cosmo-admin
 * prices every invoice from `admin_plan_pricing`, and a number shown here can
 * never become a number charged. Kept so the customer sees an estimate
 * instead of a blank.
 */
export const OVERAGE_RATES_BRL = {
  /** Per new conversation above the cap. */
  newConversations: 0.2,
  /** Per 1.000 stored conversations above the cap. */
  totalConversationsPer1000: 10,
  /** Per 1.000 contacts above the cap. */
  contactsPer1000: 5,
} as const

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /**
   * The account's usage for the current billing month.
   *
   * Counts, in order: conversations that became billable this month, every
   * conversation stored, every contact, and the conversations the AI answered
   * this month. Cheap enough to call on a page load; nothing calls it per
   * message any more.
   */
  async getUsage(accountId: string): Promise<PlanUsage> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { plan: true, aiOverageCapBrl: true },
    })
    if (!account) {
      throw new PaymentRequiredException(errBody('account_not_found', 'Account not found'))
    }
    const now = new Date()
    const monthStart = currentBillingMonthStart(now)

    const [newConversationsThisMonth, totalConversations, contacts, aiConversations] =
      await Promise.all([
        this.prisma.conversation.count({
          where: { accountId, billableAt: { gte: monthStart } },
        }),
        this.prisma.conversation.count({ where: { accountId } }),
        this.prisma.contact.count({ where: { accountId } }),
        this.aiUsage.aiConversationsCount(accountId, now),
      ])

    const allowance = await this.aiUsage.allowanceFor(accountId, account.plan, now)
    const included = Number.isFinite(allowance.included) ? allowance.included : null
    const price = AI_ALLOWANCE[account.plan].overagePriceBrl
    const overConversations =
      included === null ? 0 : Math.max(0, aiConversations - included)
    const capBrl =
      account.aiOverageCapBrl === null ? null : Number(account.aiOverageCapBrl)
    const uncapped = round2(overConversations * (price ?? 0))
    return {
      plan: account.plan,
      caps: PLAN_CAPS[account.plan],
      newConversationsThisMonth,
      totalConversations,
      contacts,
      ai: {
        conversations: aiConversations,
        included,
        overagePriceBrl: price,
        capBrl,
        overConversations,
        // The customer's ceiling is a promise about the bill, so the estimate
        // respects it too: showing R$ 400 on an account that capped itself at
        // R$ 100 would be telling them something we will not charge.
        estimatedOverageBrl:
          capBrl === null ? uncapped : Math.min(uncapped, round2(capBrl)),
        resetsAt: nextBillingMonthStart(now).toISOString(),
      },
    }
  }

  /**
   * Usage plus the derived state the banners and the billing screen read.
   *
   * This replaced `assertWithinCap`, which threw 402 on conversation and
   * contact creation. That was backwards: sections 4.1 and 4.2 of the terms
   * promise that no conversation is ever blocked for being over a cap, and
   * the customer was getting "Payment Required" for typing a name into the
   * new-contact form while their invoice was paid. Nothing here refuses
   * anything; it describes the situation and the UI offers an upgrade
   * (decision 3).
   */
  async evaluate(accountId: string): Promise<UsageEvaluation> {
    const usage = await this.getUsage(accountId)
    const meters: UsageMeter[] = [
      this.meter('newConversations', usage.newConversationsThisMonth, usage.caps, 'newConversationsPerMonth'),
      this.meter('totalConversations', usage.totalConversations, usage.caps, 'totalConversations'),
      this.meter('contacts', usage.contacts, usage.caps, 'contacts'),
    ]

    // Worst first, so the banner names the meter that is actually about to
    // matter. Narrowed to a non-null percent before sorting, rather than
    // defaulting a null to 0 inside the comparator: an uncapped meter has no
    // percentage at all and does not belong in this list.
    const warning = meters
      .flatMap((m) =>
        m.percent !== null && m.percent >= WARN_AT_PERCENT
          ? [{ key: m.key, percent: m.percent }]
          : [],
      )
      .sort((a, b) => b.percent - a.percent)
      .map((m) => m.key)

    const atAbsolute = meters.some(
      (m) => m.absoluteLimit !== null && m.used >= m.absoluteLimit,
    )
    // "Out of AI allowance with nowhere to go": the plan has no AI overage,
    // so more conversations need a bigger plan, not a bigger bill.
    const aiExhausted =
      usage.ai.included !== null &&
      usage.ai.overagePriceBrl === null &&
      usage.ai.conversations >= usage.ai.included
    const overCap = meters.some((m) => m.billableOver > 0)
    const aiWarn =
      usage.ai.included !== null &&
      usage.ai.conversations >= usage.ai.included * 0.8

    const state: UsageState =
      atAbsolute || aiExhausted
        ? 'upgrade'
        : overCap || usage.ai.overConversations > 0
          ? 'overage'
          : warning.length > 0 || aiWarn
            ? 'warn'
            : 'ok'

    return {
      ...usage,
      meters,
      warning,
      state,
      estimatedPlanOverageBrl: estimatePlanOverageBrl(meters),
    }
  }

  private meter(
    key: MeterKey,
    used: number,
    caps: PlanCaps,
    dimension: PlanLimitDimension,
  ): UsageMeter {
    const base = caps[dimension]
    const limit = absoluteLimit(caps, dimension)
    return {
      key,
      used,
      cap: Number.isFinite(base) ? base : null,
      absoluteLimit: Number.isFinite(limit) ? limit : null,
      percent: Number.isFinite(base) ? Math.round((used / base) * 100) : null,
      billableOver: billableOverage(caps, dimension, used),
    }
  }

  /**
   * The only limit check that still refuses work: a bulk contact import that
   * would carry the account past its absolute limit.
   *
   * Counted before the first row is written, like Nebula's
   * `contact_hard_cap_for`, so a 50.000-row file on a Rocket plan is one
   * rejection instead of 5.000 contacts and then an error.
   */
  async assertImportWithinAbsoluteLimit(
    accountId: string,
    incoming: number,
  ): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { plan: true },
    })
    if (!account) {
      throw new PaymentRequiredException(
        errBody('account_not_found', 'Account not found'),
      )
    }
    const caps = PLAN_CAPS[account.plan]
    const limit = absoluteLimit(caps, 'contacts')
    if (!Number.isFinite(limit)) return
    const current = await this.prisma.contact.count({ where: { accountId } })
    if (current + incoming <= limit) return
    throw new ImportTooLargeException({
      current,
      incoming,
      limit,
      plan: account.plan,
      suggestedPlan: nextPlanUp(account.plan),
    })
  }
}

/** Round to cents. Money shown to a customer never carries float noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * What the month's plan overage would cost at the published rates. The stock
 * meters are priced per 1.000 units, and a part of a thousand is charged as a
 * thousand (same as cosmo-admin's `cosmikaOverage`).
 */
export function estimatePlanOverageBrl(meters: UsageMeter[]): number {
  let total = 0
  for (const m of meters) {
    if (m.billableOver <= 0) continue
    if (m.key === 'newConversations') {
      total += m.billableOver * OVERAGE_RATES_BRL.newConversations
    } else if (m.key === 'totalConversations') {
      total +=
        Math.ceil(m.billableOver / 1000) *
        OVERAGE_RATES_BRL.totalConversationsPer1000
    } else {
      total += Math.ceil(m.billableOver / 1000) * OVERAGE_RATES_BRL.contactsPer1000
    }
  }
  return round2(total)
}

/**
 * The plan to offer when this one runs out of room. Legacy signup tiers point
 * at Rocket, which is the only plan a new account is created on; Enterprise
 * and the internal plans have nothing above them, so there is nothing to
 * offer and the UI shows an informational banner instead.
 */
export function nextPlanUp(plan: Plan): Plan | null {
  switch (plan) {
    case 'EXPLORER':
    case 'JETPACK':
      return 'ROCKET'
    case 'ROCKET':
      return 'SPACESHIP'
    case 'SPACESHIP':
      return 'ENTERPRISE'
    default:
      return null
  }
}
