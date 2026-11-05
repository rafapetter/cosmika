import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'

import {
  type AllowanceDecision,
  decideAllowance,
} from './ai-allowance'
import { AiUsageService } from './ai-usage.service'

/**
 * Whether the AI may answer one more conversation on this account.
 *
 * Two modes, chosen by `COSMIKA_AI_ALLOWANCE_ENFORCE`:
 *
 *   unset / "0"  OBSERVE. The decision is computed and logged, and `allowed`
 *                comes back true no matter what. This is how the feature
 *                ships: for two weeks the logs say what WOULD have been
 *                blocked, and that gets compared against the ledger before
 *                anyone's bot is allowed to go quiet.
 *   "1"          ENFORCE. The decision is applied.
 *
 * Enforcing before the allowance is published and customers are told would
 * mean a bot that stops mid-month for a reason the customer never agreed to,
 * so the default is the harmless one and turning it on is its own approval.
 */
@Injectable()
export class AiAllowanceService {
  private readonly logger = new Logger(AiAllowanceService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /** True when the gate is allowed to actually stop a reply. */
  enforcing(): boolean {
    return process.env.COSMIKA_AI_ALLOWANCE_ENFORCE === '1'
  }

  /**
   * Evaluate the gate for one conversation.
   *
   * Called BEFORE the model, so a blocked turn costs nothing — the point of
   * an allowance is not to spend the tokens and then decline to use them.
   *
   * Fails OPEN. If the account is gone or the count query throws, the AI
   * answers: an outage in the meter must never look to a customer like their
   * bot broke.
   */
  async check(
    accountId: string,
    conversationId: string,
  ): Promise<AllowanceDecision & { enforced: boolean }> {
    const open = {
      allowed: true,
      reason: 'uncounted' as const,
      used: 0,
      included: Number.POSITIVE_INFINITY,
      remainingPaid: null,
      enforced: false,
    }
    try {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        select: { plan: true, aiOverageCapBrl: true },
      })
      if (!account) return open

      const now = new Date()
      const allowance = await this.aiUsage.allowanceFor(accountId, account.plan, now)
      // Short-circuit: an uncounted plan needs neither of the two queries
      // below, and this runs on every inbound message of every conversation.
      if (!Number.isFinite(allowance.included)) return open

      const [used, alreadyCounted] = await Promise.all([
        this.aiUsage.aiConversationsCount(accountId, now),
        this.aiUsage.hasRepliedThisMonth(accountId, conversationId, now),
      ])
      const decision = decideAllowance({
        used,
        included: allowance.included,
        overagePriceBrl: allowance.overagePriceBrl,
        capBrl:
          account.aiOverageCapBrl === null
            ? null
            : Number(account.aiOverageCapBrl),
        alreadyCounted,
      })
      if (decision.allowed) return { ...decision, enforced: false }

      const enforced = this.enforcing()
      this.logger.warn(
        `ai allowance ${enforced ? 'blocked' : 'would_block'} account=${accountId} ` +
          `conversation=${conversationId} reason=${decision.reason} ` +
          `used=${decision.used} included=${decision.included}`,
      )
      return { ...decision, allowed: !enforced, enforced }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`ai allowance check failed for ${accountId}: ${m}`)
      return open
    }
  }
}
