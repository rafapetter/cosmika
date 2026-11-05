import { Injectable, Logger } from '@nestjs/common'
import type { AiUsageSource, Plan, Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { computeCostUsd, type UsageBreakdown } from '../ai/anthropic-pricing'

import { billingMonthWindow, billingMonthOf } from './billing-month'
import { AI_ALLOWANCE } from './plan-limits'

/** What an allowance lookup resolved to, and where the number came from. */
export type ResolvedAllowance = {
  /** Conversations included this month. Infinity = uncounted. */
  included: number
  /** BRL per conversation above the allowance, null when the plan has none. */
  overagePriceBrl: number | null
  /** True when a per-account override is in force rather than the plan. */
  overridden: boolean
}

export type RecordInput = {
  accountId: string
  conversationId?: string | null
  agentBotId?: string | null
  source: AiUsageSource
  model: string
  usage: UsageBreakdown
  /** Did this call's output reach the contact? */
  replied: boolean
  ownKey?: boolean
  metadata?: Prisma.InputJsonValue
}

/** Which provider bills a model. Recorded so the ledger can be reconciled. */
export function providerFor(model: string): string {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.includes('/')) return 'openrouter'
  return 'openai'
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one LLM call to the ledger and fold it into the conversation's AI
   * session aggregate.
   *
   * Two writes, on purpose. The ledger row is the billing record: one line
   * per call, priced at the model's price that day, with `replied` deciding
   * whether the customer owes a conversation for it. The session aggregate is
   * what the per-bot daily guard reads, and it stays because it is keyed on
   * the conversation and cheap to read on every turn.
   *
   * NEVER THROWS. Metering is bookkeeping, and bookkeeping must not be able
   * to take down a customer's conversation — if the ledger write fails we log
   * it and the turn proceeds. That is the right trade: a missing row
   * under-bills us, a thrown error costs the customer an answer.
   */
  async record(input: RecordInput): Promise<number> {
    const costUsd = computeCostUsd(input.model, input.usage)
    try {
      await this.prisma.aiUsageEvent.create({
        data: {
          accountId: input.accountId,
          conversationId: input.conversationId ?? null,
          agentBotId: input.agentBotId ?? null,
          source: input.source,
          provider: providerFor(input.model),
          model: input.model,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          costUsd,
          replied: input.replied,
          ownKey: input.ownKey ?? false,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })
      if (input.conversationId) {
        await this.upsertSession(input, costUsd)
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`ai usage not recorded for ${input.accountId}: ${m}`)
    }
    return costUsd
  }

  private async upsertSession(input: RecordInput, costUsd: number): Promise<void> {
    const tokensIn =
      input.usage.inputTokens +
      input.usage.cacheReadTokens +
      input.usage.cacheWriteTokens
    const now = new Date()
    await this.prisma.aiAgentSession.upsert({
      where: { conversationId: input.conversationId as string },
      create: {
        accountId: input.accountId,
        conversationId: input.conversationId as string,
        agentBotId: input.agentBotId ?? null,
        state: { messages: [] } as unknown as Prisma.InputJsonValue,
        totalTokensIn: tokensIn,
        totalTokensOut: input.usage.outputTokens,
        totalCostUsd: costUsd,
        lastActiveAt: now,
      },
      update: {
        totalTokensIn: { increment: tokensIn },
        totalTokensOut: { increment: input.usage.outputTokens },
        totalCostUsd: { increment: costUsd },
        lastActiveAt: now,
      },
    })
  }

  /**
   * Conversations the AI answered in a billing month: the unit the allowance
   * is sold in.
   *
   * Distinct conversations with at least one `replied` call that was not
   * billed to a customer key. Counted once per month however many times the
   * AI answers, which is exactly what the terms promise ("conversa em que a
   * IA respondeu ao menos uma vez no mês"). Internal work (a summary, a
   * private draft, the administrative assistant, a silent classifier) writes
   * `replied = false` and is invisible here.
   */
  async aiConversationsCount(
    accountId: string,
    at: Date = new Date(),
  ): Promise<number> {
    const window = billingMonthWindow(billingMonthOf(at))
    /* c8 ignore next -- billingMonthOf always yields a parseable month */
    if (!window) return 0
    const rows = await this.prisma.aiUsageEvent.findMany({
      where: {
        accountId,
        replied: true,
        ownKey: false,
        conversationId: { not: null },
        createdAt: { gte: window.start, lt: window.end },
      },
      select: { conversationId: true },
      distinct: ['conversationId'],
    })
    return rows.length
  }

  /** Whether the AI has already answered THIS conversation this month. */
  async hasRepliedThisMonth(
    accountId: string,
    conversationId: string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const window = billingMonthWindow(billingMonthOf(at))
    /* c8 ignore next -- see aiConversationsCount */
    if (!window) return false
    const hit = await this.prisma.aiUsageEvent.findFirst({
      where: {
        accountId,
        conversationId,
        replied: true,
        ownKey: false,
        createdAt: { gte: window.start, lt: window.end },
      },
      select: { id: true },
    })
    return hit !== null
  }

  /**
   * AI spend for the billing month, in USD, read from the ledger.
   *
   * Replaces summing `AiAgentSession.totalCostUsd` over sessions active this
   * month, which added a conversation's WHOLE lifetime cost whenever it saw
   * any activity in the window — a conversation running since March counted
   * its March spend again in every later month. The ledger has one row per
   * call with its own timestamp, so the window means what it says.
   */
  async costThisMonth(accountId: string, at: Date = new Date()): Promise<number> {
    const window = billingMonthWindow(billingMonthOf(at))
    /* c8 ignore next -- see aiConversationsCount */
    if (!window) return 0
    const agg = await this.prisma.aiUsageEvent.aggregate({
      where: {
        accountId,
        createdAt: { gte: window.start, lt: window.end },
      },
      _sum: { costUsd: true },
    })
    const sum = agg._sum.costUsd
    return sum ? Number(sum) : 0
  }

  /**
   * What one agent spent in the last 24 hours, from the ledger.
   *
   * The session aggregate cannot answer this for an agent a flow called in:
   * a conversation has ONE session, opened by whichever AI spoke first, so
   * the spend of an "AI agent" block lands on a session that belongs to
   * another bot (or to none) and that agent's daily cap would never see it.
   * The ledger carries the agent on every row.
   */
  async botCostLast24h(agentBotId: string, at: Date = new Date()): Promise<number> {
    const agg = await this.prisma.aiUsageEvent.aggregate({
      where: { agentBotId, createdAt: { gte: new Date(at.getTime() - 24 * 60 * 60 * 1000) } },
      _sum: { costUsd: true },
    })
    const sum = agg._sum.costUsd
    return sum ? Number(sum) : 0
  }

  /**
   * The allowance in force for an account: the plan's, unless cosmo-admin
   * wrote an override that has not expired.
   *
   * A missing or past `aiAllowanceOverrideUntil` means the override is over,
   * so a pilot that nobody remembered to close reverts to the plan by itself
   * rather than staying unlimited forever (Nebula's 4451 lesson). `-1` is
   * "unlimited", matching `accounts.limits['ai_conversations']` in Nebula.
   */
  async allowanceFor(
    accountId: string,
    plan: Plan,
    at: Date = new Date(),
  ): Promise<ResolvedAllowance> {
    const base = AI_ALLOWANCE[plan]
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { aiAllowanceOverride: true, aiAllowanceOverrideUntil: true },
    })
    const override = account?.aiAllowanceOverride
    const until = account?.aiAllowanceOverrideUntil
    const live =
      override !== null &&
      override !== undefined &&
      until instanceof Date &&
      !Number.isNaN(until.getTime()) &&
      until.getTime() > at.getTime()
    if (!live) {
      return {
        included: base.included,
        overagePriceBrl: base.overagePriceBrl,
        overridden: false,
      }
    }
    return {
      included: override === -1 ? Number.POSITIVE_INFINITY : override,
      overagePriceBrl: base.overagePriceBrl,
      overridden: true,
    }
  }
}
