import type { Plan } from '@cosmika/db'

export type PlanCaps = {
  /** New conversations that became billable in the current billing month. */
  newConversationsPerMonth: number
  /**
   * Every conversation stored in the account — the cumulative pool the
   * published terms call "conversas armazenadas", not a window. The old
   * comment here said "open + recently-closed", which was never what the
   * query counted and made the meter look like a bug rather than a policy.
   */
  totalConversations: number
  /** Total contacts in the account. */
  contacts: number
  /**
   * How much usage the plan tolerates above a cap before the absolute limit.
   * 0 = the cap is the absolute limit; Infinity = no absolute limit.
   *
   * This is NOT a blocking threshold for day-to-day work. Nothing a customer
   * or a contact does is refused for being over a cap (the terms forbid it);
   * the only thing the absolute limit governs is a bulk contact import.
   */
  overageFraction: number
}

const UNLIMITED = Number.POSITIVE_INFINITY

/**
 * Caps for the billing model v3.1 (see cosmika/docs/roadmap.md and project
 * memory). Enforcement here is intentionally lenient — Spaceship gets 50%
 * overage; Enterprise/Partner/Master are effectively uncapped. Free-tier
 * Explorer + Jetpack get small caps for the trial / demo flows.
 */
export const PLAN_CAPS: Record<Plan, PlanCaps> = {
  EXPLORER: {
    newConversationsPerMonth: 50,
    totalConversations: 200,
    contacts: 500,
    overageFraction: 0,
  },
  JETPACK: {
    newConversationsPerMonth: 200,
    totalConversations: 1_000,
    contacts: 2_000,
    overageFraction: 0,
  },
  ROCKET: {
    newConversationsPerMonth: 500,
    totalConversations: 5_000,
    contacts: 5_000,
    overageFraction: 0,
  },
  SPACESHIP: {
    newConversationsPerMonth: 1_500,
    totalConversations: 15_000,
    contacts: 15_000,
    overageFraction: 0.5,
  },
  ENTERPRISE: {
    newConversationsPerMonth: 5_000,
    totalConversations: 50_000,
    contacts: 50_000,
    overageFraction: UNLIMITED,
  },
  PARTNER: {
    newConversationsPerMonth: UNLIMITED,
    totalConversations: UNLIMITED,
    contacts: UNLIMITED,
    overageFraction: UNLIMITED,
  },
  MASTER: {
    newConversationsPerMonth: UNLIMITED,
    totalConversations: UNLIMITED,
    contacts: UNLIMITED,
    overageFraction: UNLIMITED,
  },
}

export type PlanLimitDimension =
  | 'newConversationsPerMonth'
  | 'totalConversations'
  | 'contacts'

/**
 * Apply overage tolerance: returns true when `current` is at or above the
 * effective cap (base * (1 + overage)).
 */
export function isOverCap(
  caps: PlanCaps,
  dimension: PlanLimitDimension,
  current: number,
): boolean {
  const base = caps[dimension]
  if (!Number.isFinite(base)) return false
  if (!Number.isFinite(caps.overageFraction)) return false
  const effective = base * (1 + caps.overageFraction)
  return current >= effective
}

/**
 * The absolute limit for a dimension: the cap plus whatever overage the plan
 * tolerates. Rocket's is its cap (100%), Spaceship's is 150% of it,
 * Enterprise and above have none.
 *
 * The one thing this governs is a bulk contact import, which the terms say to
 * reject above it. Everything else keeps working over the limit and is billed
 * as overage (decision 3).
 */
export function absoluteLimit(
  caps: PlanCaps,
  dimension: PlanLimitDimension,
): number {
  const base = caps[dimension]
  if (!Number.isFinite(base)) return Number.POSITIVE_INFINITY
  if (!Number.isFinite(caps.overageFraction)) return Number.POSITIVE_INFINITY
  return base * (1 + caps.overageFraction)
}

/**
 * How much overage of a dimension the plan will actually bill, capped at the
 * absolute limit.
 *
 * Spaceship's published terms bill "between 100% and 150%" and offer an
 * assisted upgrade above that, so a customer who doubles their plan is not
 * handed an open-ended bill they never agreed to (decision 2). Enterprise has
 * no ceiling; its young-account protection lives in cosmo-admin.
 */
export function billableOverage(
  caps: PlanCaps,
  dimension: PlanLimitDimension,
  current: number,
): number {
  const base = caps[dimension]
  if (!Number.isFinite(base)) return 0
  const limit = absoluteLimit(caps, dimension)
  const billed = Number.isFinite(limit) ? Math.min(current, limit) : current
  return Math.max(0, billed - base)
}

/**
 * Conversations the AI may answer in a billing month, per plan, and what each
 * extra one costs.
 *
 * The unit is a CONVERSATION the AI replied to at least once in the month,
 * counted once however many times it answers (see `AiUsageService`), not a
 * token and not a message. `overagePriceBrl = null` means the plan has no
 * overage at all: above the allowance the AI stands down and the conversation
 * goes to the team until the month turns over.
 *
 * ⚠ These four numbers exist in four places: the landing page, Nebula's
 * `V3PlanLimits::AI_ALLOWANCE`, cosmo-admin's pricing table, and here. Keep
 * them in sync, and remember that cosmo-admin — not this table — is the
 * authority when an invoice is priced.
 */
export type AiAllowance = {
  /** Conversations included in the plan. Infinity = uncounted. */
  included: number
  /** BRL per conversation above the allowance, or null for no overage. */
  overagePriceBrl: number | null
}

export const AI_ALLOWANCE: Record<Plan, AiAllowance> = {
  // Legacy signup tiers. No new account is created on either one (all new
  // signups are ROCKET since 2026-09-17), and neither is billed, so the
  // allowance here only has to stop a dormant account from running up a bill.
  EXPLORER: { included: 50, overagePriceBrl: null },
  JETPACK: { included: 100, overagePriceBrl: null },
  ROCKET: { included: 300, overagePriceBrl: null },
  SPACESHIP: { included: 1_000, overagePriceBrl: 0.5 },
  ENTERPRISE: { included: 3_000, overagePriceBrl: 0.4 },
  PARTNER: { included: UNLIMITED, overagePriceBrl: null },
  MASTER: { included: UNLIMITED, overagePriceBrl: null },
}
