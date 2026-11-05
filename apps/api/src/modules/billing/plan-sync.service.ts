import { Injectable, Logger } from '@nestjs/common'
import type { Plan } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'

/**
 * Plan names cosmo-admin can report, mapped onto Cosmika's enum.
 *
 * cosmo-admin numbers its plans (2 = Rocket, 3 = Spaceship, 4 = Enterprise,
 * the same integers Nebula's `accounts.plan` uses) and also has the names in
 * its pricing table, so accept either spelling rather than making the
 * contract depend on which one the endpoint happens to send.
 */
const PLAN_BY_CODE: Record<string, Plan> = {
  '2': 'ROCKET',
  '3': 'SPACESHIP',
  '4': 'ENTERPRISE',
  rocket: 'ROCKET',
  spaceship: 'SPACESHIP',
  enterprise: 'ENTERPRISE',
  partner: 'PARTNER',
  master: 'MASTER',
  // Accepted so an old row can still be echoed back without being refused,
  // never assigned to a new account.
  explorer: 'EXPLORER',
  jetpack: 'JETPACK',
}

/** Parse whatever the billing API reported into a Plan, or null. */
export function parseReportedPlan(raw: unknown): Plan | null {
  if (typeof raw === 'number') return PLAN_BY_CODE[String(raw)] ?? null
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  return PLAN_BY_CODE[key] ?? null
}

/**
 * Keep `Account.plan` equal to the plan the customer is billed on.
 *
 * cosmo-admin is the authority: it holds the subscription, the price and the
 * change-plan flow, and it is the only system that knows what was actually
 * charged. Cosmika mirrors. Before this existed the two disagreed by
 * construction — signup wrote EXPLORER while cosmo-admin registered Rocket,
 * and the Nebula migration wrote ENTERPRISE by default — so the caps the
 * product enforced and the plan on the invoice were unrelated numbers.
 *
 * Deliberately one-directional and deliberately quiet:
 *  - an account cosmo-admin has never heard of (404, internal account 4,
 *    everything migrated before billing existed) keeps its local plan;
 *  - a plan name we do not recognise is logged and ignored, never guessed;
 *  - a failure here is logged and swallowed. Access checks run on every
 *    authenticated request, and a plan mirror must never be able to turn a
 *    billing hiccup into a locked-out customer.
 */
@Injectable()
export class PlanSyncService {
  private readonly logger = new Logger(PlanSyncService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Returns the plan now in force locally, or null when nothing changed. */
  async mirror(accountId: string, reported: unknown): Promise<Plan | null> {
    const plan = parseReportedPlan(reported)
    if (plan === null) {
      if (reported !== undefined && reported !== null) {
        this.logger.warn(
          `billing reported an unknown plan for ${accountId}: ${String(reported)}`,
        )
      }
      return null
    }
    try {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
        select: { plan: true },
      })
      if (!account || account.plan === plan) return null
      await this.prisma.account.update({
        where: { id: accountId },
        data: { plan },
      })
      // Audited: a plan change moves every cap and the AI allowance, so
      // "why did my limits change on the 14th" has to have an answer.
      await this.prisma.auditLog.create({
        data: {
          accountId,
          actorId: null,
          action: 'account.plan.mirrored',
          target: `account:${accountId}`,
          metadata: { from: account.plan, to: plan, source: 'cosmo-admin' },
        },
      })
      this.logger.log(`account ${accountId} plan mirrored ${account.plan} → ${plan}`)
      return plan
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`plan mirror failed for ${accountId}: ${m}`)
      return null
    }
  }
}
