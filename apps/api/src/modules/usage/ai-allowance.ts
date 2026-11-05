/**
 * The AI allowance decision, as a pure function.
 *
 * This is the rule that decides whether the AI is allowed to answer one more
 * conversation this month. It is deliberately separate from anything that
 * touches the database or the conversation, because it is the one piece of
 * this feature that must be inspectable, exhaustively testable, and identical
 * to Nebula's `AiUsage::Allowance.check` (live since 11/09) — a divergence
 * between the two products here shows up as a customer being billed for
 * something the other product gave away.
 *
 * The order of the clauses matters and follows Nebula's:
 *
 *   1. The plan does not count AI conversations         -> allow
 *   2. The AI already answered THIS conversation this
 *      month                                           -> allow
 *   3. Still inside the included allowance              -> allow
 *   4. The plan has no AI overage at all                -> block, allowance_reached
 *   5. The customer set no ceiling                      -> allow (billed)
 *   6. Inside the customer's ceiling                    -> allow (billed)
 *   7. otherwise                                        -> block, cap_reached
 *
 * Clause 2 is what makes the unit a CONVERSATION rather than a message: once
 * a conversation is counted, the AI keeps working it to the end of the month.
 * Dropping it would strand a customer mid-sentence the moment the allowance
 * ran out, and would still bill them for the conversation.
 */

export type AllowanceReason =
  /** The plan has no AI counter (internal plans). */
  | 'uncounted'
  /** This conversation is already counted this month. */
  | 'already_counted'
  /** Inside the plan's included conversations. */
  | 'included'
  /** Above the allowance, billed as overage. */
  | 'overage'
  /** Above the allowance on a plan with no overage. */
  | 'allowance_reached'
  /** Above the ceiling the customer set for themselves. */
  | 'cap_reached'

export type AllowanceDecision = {
  allowed: boolean
  reason: AllowanceReason
  /** Conversations already counted this month. */
  used: number
  /** Included in the plan (Infinity when uncounted). */
  included: number
  /** Extra conversations the customer's ceiling still pays for, if any. */
  remainingPaid: number | null
}

export type AllowanceInputs = {
  /** Conversations the AI answered this month. */
  used: number
  /** Included in the plan, or Infinity. */
  included: number
  /** BRL per extra conversation, or null when the plan has no overage. */
  overagePriceBrl: number | null
  /** The customer's monthly ceiling in BRL, or null for none. */
  capBrl: number | null
  /** Has the AI already answered this conversation this month? */
  alreadyCounted: boolean
}

export function decideAllowance(input: AllowanceInputs): AllowanceDecision {
  const { used, included, overagePriceBrl, capBrl, alreadyCounted } = input
  const base = { used, included, remainingPaid: null }

  if (!Number.isFinite(included)) {
    return { ...base, allowed: true, reason: 'uncounted' }
  }
  if (alreadyCounted) {
    return { ...base, allowed: true, reason: 'already_counted' }
  }
  if (used < included) {
    return { ...base, allowed: true, reason: 'included' }
  }
  if (overagePriceBrl === null || overagePriceBrl <= 0) {
    return { ...base, allowed: false, reason: 'allowance_reached' }
  }
  if (capBrl === null) {
    return { ...base, allowed: true, reason: 'overage' }
  }
  // A ceiling in reais buys a whole number of conversations. Rounding down is
  // the honest direction: a customer who caps at R$ 10 with conversations at
  // R$ 0,40 gets 25, never 26 charged as 25.
  const paidFor = Math.floor(capBrl / overagePriceBrl)
  const usedOverage = used - included
  if (usedOverage < paidFor) {
    return {
      ...base,
      allowed: true,
      reason: 'overage',
      remainingPaid: paidFor - usedOverage,
    }
  }
  return { ...base, allowed: false, reason: 'cap_reached', remainingPaid: 0 }
}

/** Whether a blocked decision means "the plan is the limit" (offer upgrade). */
export function isUpgradeCase(decision: AllowanceDecision): boolean {
  return decision.reason === 'allowance_reached'
}
