import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import * as Sentry from '@sentry/node'

import { PrismaService } from '../../prisma/prisma.service'
import { AiUsageService } from '../usage/ai-usage.service'
import {
  billingMonthWindow,
  previousBillingMonth,
} from '../usage/billing-month'
import { AI_ALLOWANCE, billableOverage, PLAN_CAPS } from '../usage/plan-limits'

import { BillingService } from './billing.service'

/**
 * Month-end usage metering (roadmap P10, extended for the AI allowance).
 *
 * The published terms bill usage above each plan's BASE cap on the following
 * month's invoice. This service meters a CLOSED billing month per account and
 * reports QUANTITIES to the admin billing API, which owns all pricing (fees,
 * the young-account 2×-plan-value cap, the minimum charge) and creates DRAFT
 * invoices. Cosmika never sends a price and never decides that money is owed.
 *
 * Two reports go out, because the terms promise the AI allowance its own
 * invoice: the plan meters and the AI conversations.
 *
 * EVERY account is reported, on every plan, whether or not it is over
 * anything. cosmo-admin's preview screen has to show each account's position
 * against its own limit before anyone decides to send a charge, and an
 * account that silently drops out of the report is indistinguishable from a
 * broken cron. What is INVOICEABLE is decided there, not here: only Spaceship
 * and Enterprise have overage in their terms, Rocket is offered an upgrade
 * instead, and the legacy tiers are never billed at all.
 */

/**
 * The plans whose terms allow paid overage. Exported for the preview screen
 * and kept here as documentation; the report itself no longer filters on it,
 * because cosmo-admin prices from its own tables and needs the full picture.
 */
export const BILLABLE_PLANS = ['SPACESHIP', 'ENTERPRISE'] as const

export type OverageMeter = { used: number; cap: number; over: number }

export type AccountOverage = {
  accountId: string
  accountName: string
  plan: string
  accountCreatedAt: string
  /** True when this plan's terms allow paid overage at all. */
  billablePlan: boolean
  meters: {
    newConversations: OverageMeter
    totalConversations: OverageMeter
    contacts: OverageMeter
  }
}

export type AccountAiOverage = {
  accountId: string
  accountName: string
  plan: string
  /** True when this plan has an AI overage price at all. */
  billablePlan: boolean
  /** Conversations the AI answered in the metered month. */
  aiConversations: number
  /** The allowance in force, or null when the plan does not count. */
  aiIncluded: number | null
  /** The customer's own ceiling in BRL, or null for none. */
  capBrl: number | null
  /** Ledger cost of the month in USD. Operational, not billed. */
  costUsd: number
}

/**
 * `YYYY-MM` → the [start, end) UTC interval of that month in the billing
 * timezone. Re-exported from the usage module so the billing side has one
 * import; the implementation lives with the other month helpers.
 */
export function monthWindow(month: string): { start: Date; end: Date } | null {
  return billingMonthWindow(month)
}

/** The billing month before the given instant, as `YYYY-MM`. */
export function previousMonth(now: Date): string {
  return previousBillingMonth(now)
}

@Injectable()
export class OverageService {
  private readonly logger = new Logger(OverageService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /**
   * Meter one closed month's plan usage.
   *
   * "New conversations" counts the ones that BECAME BILLABLE inside the
   * window (`billableAt`), not the ones created in it: an unanswered
   * broadcast, a forward and an imported history are rows the customer did
   * not generate as new work, and the terms exclude them (decision 16).
   *
   * The stock meters (total conversations, contacts) count rows created
   * before the window's end that still exist, so deletions since are
   * forgiven, which can only under-bill.
   *
   * ⚠ `totalConversations.over` is reported and NOT charged. The pool is
   * cumulative and Cosmika has no retention yet, so a customer who imported
   * five years of Nebula history would start paying for it on month one and
   * would have no way to reduce it. cosmo-admin prices it at zero until
   * retention ships (decision 1, phase 7); the number is still reported so
   * the size of the problem is visible before anyone is billed for it.
   */
  async computeMonth(month: string): Promise<AccountOverage[]> {
    const window = monthWindow(month)
    if (!window) throw new Error(`invalid month: ${month}`)
    // Every account, on every plan. A Rocket or a legacy EXPLORER account is
    // never invoiced for overage, and still belongs in the preview: the
    // panel's job is to show where each account stands.
    const accounts = await this.prisma.account.findMany({
      select: { id: true, name: true, plan: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    const out: AccountOverage[] = []
    for (const account of accounts) {
      const caps = PLAN_CAPS[account.plan]
      const [newConv, totalConv, contacts] = await Promise.all([
        this.prisma.conversation.count({
          where: {
            accountId: account.id,
            billableAt: { gte: window.start, lt: window.end },
          },
        }),
        this.prisma.conversation.count({
          where: { accountId: account.id, createdAt: { lt: window.end } },
        }),
        this.prisma.contact.count({
          where: { accountId: account.id, createdAt: { lt: window.end } },
        }),
      ])
      const meters = {
        newConversations: meter(newConv, caps.newConversationsPerMonth, caps, 'newConversationsPerMonth'),
        totalConversations: meter(totalConv, caps.totalConversations, caps, 'totalConversations'),
        contacts: meter(contacts, caps.contacts, caps, 'contacts'),
      }
      out.push({
        accountId: account.id,
        accountName: account.name,
        plan: account.plan,
        accountCreatedAt: account.createdAt.toISOString(),
        billablePlan: (BILLABLE_PLANS as readonly string[]).includes(account.plan),
        meters,
      })
    }
    return out
  }

  /**
   * Meter one closed month's AI usage, for every account.
   *
   * Includes accounts inside their allowance and accounts on plans that are
   * never billed for AI, because the preview screen shows each account's
   * position against its own allowance. `billablePlan` says which ones could
   * owe anything; `aiIncluded` is the allowance actually in force, override
   * and all.
   */
  async computeAiMonth(month: string): Promise<AccountAiOverage[]> {
    const window = monthWindow(month)
    if (!window) throw new Error(`invalid month: ${month}`)
    // Metered at an instant inside the window, so the allowance override and
    // the counts are the ones that applied to the month being billed.
    const at = new Date(window.end.getTime() - 1)
    const accounts = await this.prisma.account.findMany({
      select: { id: true, name: true, plan: true, aiOverageCapBrl: true },
      orderBy: { createdAt: 'asc' },
    })
    const out: AccountAiOverage[] = []
    for (const account of accounts) {
      const [aiConversations, costUsd, allowance] = await Promise.all([
        this.aiUsage.aiConversationsCount(account.id, at),
        this.aiUsage.costThisMonth(account.id, at),
        this.aiUsage.allowanceFor(account.id, account.plan, at),
      ])
      out.push({
        accountId: account.id,
        accountName: account.name,
        plan: account.plan,
        billablePlan: AI_ALLOWANCE[account.plan].overagePriceBrl !== null,
        aiConversations,
        aiIncluded: Number.isFinite(allowance.included) ? allowance.included : null,
        capBrl:
          account.aiOverageCapBrl === null ? null : Number(account.aiOverageCapBrl),
        costUsd,
      })
    }
    return out
  }

  /**
   * Meter `month` (or the previous billing month) and report it to the admin
   * billing API. Safe to re-run: the admin side is idempotent per
   * account+month, so a retried report can never double-invoice.
   */
  async report(
    month?: string,
    dry = false,
  ): Promise<{
    month: string
    accounts: number
    posted: boolean
    aiAccounts: number
    aiPosted: boolean
  }> {
    const target = month ?? previousMonth(new Date())
    const rows = await this.computeMonth(target)
    let posted = false
    if (rows.length === 0) {
      this.logger.log(`overage ${target}: no accounts to report`)
    } else {
      posted = await this.billing.postOverageReport({
        month: target,
        dry,
        accounts: rows,
      })
      this.logger.log(
        `overage ${target}: ${rows.length} account(s) reported, posted=${posted}`,
      )
    }

    const aiRows = await this.computeAiMonth(target)
    let aiPosted = false
    if (aiRows.length === 0) {
      this.logger.log(`ai overage ${target}: no accounts to report`)
    } else {
      aiPosted = await this.billing.postAiOverageReport({
        month: target,
        dry,
        accounts: aiRows,
      })
      this.logger.log(
        `ai overage ${target}: ${aiRows.length} account(s) reported, posted=${aiPosted}`,
      )
    }
    return {
      month: target,
      accounts: rows.length,
      posted,
      aiAccounts: aiRows.length,
      aiPosted,
    }
  }

  /**
   * 06:10 UTC on the 2nd: the previous billing month is definitively closed
   * before metering (same reasoning as admin's whatsapp-usage cron at 06:00,
   * and 06:10 UTC is 03:10 in São Paulo, comfortably inside day 2 there).
   */
  @Cron('10 6 2 * *')
  async reportPreviousMonth(): Promise<void> {
    try {
      await this.report()
    } catch (err) {
      // A failed report must not crash the scheduler; the admin side is
      // idempotent so the next manual or monthly run simply covers it.
      this.logger.error(
        `monthly overage report failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      Sentry.captureException(err)
    }
  }
}

/**
 * One meter. `over` is what would actually be billed, which on Spaceship
 * stops at 150% of the cap: the terms bill "between 100% and 150%" and offer
 * an assisted upgrade above that, so an account that tripled its plan gets a
 * conversation about a bigger plan, not a surprise invoice for 3× the usage
 * (decision 2). Enterprise has no ceiling.
 */
function meter(
  used: number,
  cap: number,
  caps: (typeof PLAN_CAPS)[keyof typeof PLAN_CAPS],
  dimension: 'newConversationsPerMonth' | 'totalConversations' | 'contacts',
): OverageMeter {
  return {
    used,
    cap,
    over: billableOverage(caps, dimension, used),
  }
}
