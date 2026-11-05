import { describe, expect, it } from 'vitest'

import { isOverCap, PLAN_CAPS } from './plan-limits'

describe('PLAN_CAPS shape', () => {
  it('defines a caps row for every Plan enum value', () => {
    expect(Object.keys(PLAN_CAPS).sort()).toEqual(
      ['ENTERPRISE', 'EXPLORER', 'JETPACK', 'MASTER', 'PARTNER', 'ROCKET', 'SPACESHIP'].sort(),
    )
  })

  it('every row has the four required fields', () => {
    for (const [, row] of Object.entries(PLAN_CAPS)) {
      expect(typeof row.newConversationsPerMonth).toBe('number')
      expect(typeof row.totalConversations).toBe('number')
      expect(typeof row.contacts).toBe('number')
      expect(typeof row.overageFraction).toBe('number')
    }
  })

  it('caps scale up monotonically EXPLORER → JETPACK → ROCKET → SPACESHIP', () => {
    expect(PLAN_CAPS.JETPACK.newConversationsPerMonth).toBeGreaterThan(
      PLAN_CAPS.EXPLORER.newConversationsPerMonth,
    )
    expect(PLAN_CAPS.ROCKET.newConversationsPerMonth).toBeGreaterThan(
      PLAN_CAPS.JETPACK.newConversationsPerMonth,
    )
    expect(PLAN_CAPS.SPACESHIP.newConversationsPerMonth).toBeGreaterThan(
      PLAN_CAPS.ROCKET.newConversationsPerMonth,
    )
  })

  it('PARTNER + MASTER are uncapped (Infinity on all dimensions)', () => {
    for (const plan of ['PARTNER', 'MASTER'] as const) {
      expect(PLAN_CAPS[plan].newConversationsPerMonth).toBe(Infinity)
      expect(PLAN_CAPS[plan].totalConversations).toBe(Infinity)
      expect(PLAN_CAPS[plan].contacts).toBe(Infinity)
      expect(PLAN_CAPS[plan].overageFraction).toBe(Infinity)
    }
  })

  it('ENTERPRISE has finite caps but unlimited overage', () => {
    expect(Number.isFinite(PLAN_CAPS.ENTERPRISE.newConversationsPerMonth)).toBe(true)
    expect(PLAN_CAPS.ENTERPRISE.overageFraction).toBe(Infinity)
  })

  it('ROCKET is hard-capped (no overage)', () => {
    expect(PLAN_CAPS.ROCKET.overageFraction).toBe(0)
  })

  it('SPACESHIP allows 50% overage', () => {
    expect(PLAN_CAPS.SPACESHIP.overageFraction).toBe(0.5)
  })
})

describe('isOverCap', () => {
  it('returns false when usage is well below the cap', () => {
    expect(isOverCap(PLAN_CAPS.ROCKET, 'totalConversations', 100)).toBe(false)
    expect(isOverCap(PLAN_CAPS.ROCKET, 'contacts', 0)).toBe(false)
  })

  it('returns true when usage equals the hard cap exactly (ROCKET, overage=0)', () => {
    // effective = 5_000 * (1 + 0) = 5_000; 5_000 >= 5_000
    expect(isOverCap(PLAN_CAPS.ROCKET, 'totalConversations', 5_000)).toBe(true)
  })

  it('returns true when usage exceeds the hard cap (ROCKET)', () => {
    expect(isOverCap(PLAN_CAPS.ROCKET, 'totalConversations', 5_001)).toBe(true)
  })

  it('returns false for SPACESHIP usage at 149% (under 150% overage)', () => {
    // 15_000 * 1.5 = 22_500; 22_499 < 22_500
    expect(isOverCap(PLAN_CAPS.SPACESHIP, 'totalConversations', 22_499)).toBe(false)
  })

  it('returns true for SPACESHIP usage at exactly 150% (overage limit reached)', () => {
    expect(isOverCap(PLAN_CAPS.SPACESHIP, 'totalConversations', 22_500)).toBe(true)
  })

  it('returns false for ENTERPRISE regardless of usage (overage = Infinity)', () => {
    expect(isOverCap(PLAN_CAPS.ENTERPRISE, 'totalConversations', 1_000_000)).toBe(false)
    expect(isOverCap(PLAN_CAPS.ENTERPRISE, 'contacts', 999_999_999)).toBe(false)
  })

  it('returns false for PARTNER regardless of usage (caps = Infinity)', () => {
    expect(isOverCap(PLAN_CAPS.PARTNER, 'newConversationsPerMonth', 999_999)).toBe(false)
  })

  it('returns false for MASTER regardless of usage', () => {
    expect(isOverCap(PLAN_CAPS.MASTER, 'contacts', 1_000_000)).toBe(false)
  })

  it('treats infinite-base + finite-overage as uncapped (edge case)', () => {
    // Synthetic: a hypothetical plan with infinite base but finite overage.
    // Guard short-circuits on the first finite check.
    const odd = {
      newConversationsPerMonth: Infinity,
      totalConversations: Infinity,
      contacts: Infinity,
      overageFraction: 0,
    }
    expect(isOverCap(odd, 'newConversationsPerMonth', 999_999)).toBe(false)
  })

  it('treats finite-base + infinite-overage as uncapped', () => {
    const odd = {
      newConversationsPerMonth: 100,
      totalConversations: 100,
      contacts: 100,
      overageFraction: Infinity,
    }
    expect(isOverCap(odd, 'newConversationsPerMonth', 999_999)).toBe(false)
  })

  it('handles each PlanLimitDimension consistently', () => {
    // Spot-check that all three dimensions go through the same arithmetic.
    expect(isOverCap(PLAN_CAPS.ROCKET, 'newConversationsPerMonth', 500)).toBe(true)
    expect(isOverCap(PLAN_CAPS.ROCKET, 'newConversationsPerMonth', 499)).toBe(false)
    expect(isOverCap(PLAN_CAPS.ROCKET, 'contacts', 5_000)).toBe(true)
    expect(isOverCap(PLAN_CAPS.ROCKET, 'contacts', 4_999)).toBe(false)
  })
})
