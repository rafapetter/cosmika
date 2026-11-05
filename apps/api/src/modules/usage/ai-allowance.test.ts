import { describe, expect, it } from 'vitest'

import { decideAllowance, isUpgradeCase } from './ai-allowance'

/** Spaceship: 1.000 included, R$ 0,50 each after that. */
const spaceship = {
  included: 1_000,
  overagePriceBrl: 0.5,
  capBrl: null as number | null,
  alreadyCounted: false,
}
/** Rocket: 300 included, no overage at all. */
const rocket = {
  included: 300,
  overagePriceBrl: null,
  capBrl: null as number | null,
  alreadyCounted: false,
}

describe('decideAllowance', () => {
  it('allows anything on a plan with no AI counter', () => {
    const d = decideAllowance({
      used: 500_000,
      included: Number.POSITIVE_INFINITY,
      overagePriceBrl: null,
      capBrl: null,
      alreadyCounted: false,
    })
    expect(d).toMatchObject({ allowed: true, reason: 'uncounted' })
  })

  it('allows a conversation the AI already answered this month, even out of allowance', () => {
    // This is what makes the unit a CONVERSATION rather than a message.
    // Without it a customer would be stranded mid-sentence the moment the
    // allowance ran out, and would still be billed for that conversation.
    const d = decideAllowance({ ...rocket, used: 5_000, alreadyCounted: true })
    expect(d).toMatchObject({ allowed: true, reason: 'already_counted' })
  })

  it('allows a new conversation inside the allowance', () => {
    expect(decideAllowance({ ...rocket, used: 299 })).toMatchObject({
      allowed: true,
      reason: 'included',
    })
  })

  it('blocks at exactly the allowance on a plan with no overage', () => {
    const d = decideAllowance({ ...rocket, used: 300 })
    expect(d).toMatchObject({ allowed: false, reason: 'allowance_reached' })
    // The only way out is a bigger plan, so this is the upgrade case.
    expect(isUpgradeCase(d)).toBe(true)
  })

  it('treats a zero overage price as no overage', () => {
    // A price of 0 would otherwise mean "infinite free conversations", which
    // is never what a pricing table means by it.
    expect(
      decideAllowance({ ...spaceship, used: 1_000, overagePriceBrl: 0 }),
    ).toMatchObject({ allowed: false, reason: 'allowance_reached' })
  })

  it('allows unlimited overage when the customer set no ceiling', () => {
    const d = decideAllowance({ ...spaceship, used: 4_000 })
    expect(d).toMatchObject({ allowed: true, reason: 'overage' })
    expect(d.remainingPaid).toBeNull()
  })

  it('allows overage inside the ceiling, and says how much is left', () => {
    // R$ 100 at R$ 0,50 buys 200 extra conversations; 1.150 used is 150 over.
    const d = decideAllowance({ ...spaceship, used: 1_150, capBrl: 100 })
    expect(d).toMatchObject({ allowed: true, reason: 'overage', remainingPaid: 50 })
  })

  it('blocks once the ceiling is spent', () => {
    const d = decideAllowance({ ...spaceship, used: 1_200, capBrl: 100 })
    expect(d).toMatchObject({ allowed: false, reason: 'cap_reached', remainingPaid: 0 })
    // Not an upgrade case: the customer asked to be stopped here, and a
    // bigger plan is not the answer to a ceiling they chose.
    expect(isUpgradeCase(d)).toBe(false)
  })

  it('rounds a ceiling down to whole conversations', () => {
    // R$ 10 at R$ 0,40 is 25 conversations, not 25,5. Rounding up would bill
    // a conversation past the ceiling the customer was promised.
    const at25 = decideAllowance({
      included: 3_000,
      overagePriceBrl: 0.4,
      capBrl: 10.2,
      alreadyCounted: false,
      used: 3_025,
    })
    expect(at25).toMatchObject({ allowed: false, reason: 'cap_reached' })
    const at24 = decideAllowance({
      included: 3_000,
      overagePriceBrl: 0.4,
      capBrl: 10.2,
      alreadyCounted: false,
      used: 3_024,
    })
    expect(at24.allowed).toBe(true)
  })

  it('blocks immediately on a ceiling of zero', () => {
    // "Never spend anything on AI overage" is a legitimate setting and has to
    // mean exactly that.
    expect(
      decideAllowance({ ...spaceship, used: 1_000, capBrl: 0 }),
    ).toMatchObject({ allowed: false, reason: 'cap_reached' })
  })

  it('carries the numbers through on every branch, for the logs and the UI', () => {
    const d = decideAllowance({ ...rocket, used: 42 })
    expect(d.used).toBe(42)
    expect(d.included).toBe(300)
  })

  it('handles a legacy EXPLORER allowance like any other capped plan', () => {
    // 34 abandoned EXPLORER accounts exist in production. Nothing bills them,
    // but the decision table still has to answer for them.
    expect(
      decideAllowance({
        used: 50,
        included: 50,
        overagePriceBrl: null,
        capBrl: null,
        alreadyCounted: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'allowance_reached' })
  })
})
