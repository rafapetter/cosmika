import { describe, expect, it } from 'vitest'

import { dayBoundary } from './day-boundary'

describe('dayBoundary', () => {
  it('maps a day to its local start, and to the next day start when closing a range', () => {
    expect(dayBoundary('2026-10-16')).toBe(new Date(2026, 9, 16).toISOString())
    expect(dayBoundary('2026-10-16', true)).toBe(new Date(2026, 9, 17).toISOString())
  })

  it('rolls the end of a month over', () => {
    expect(dayBoundary('2026-10-31', true)).toBe(new Date(2026, 10, 1).toISOString())
  })

  it('ignores anything that is not a date input value', () => {
    expect(dayBoundary('')).toBeUndefined()
    expect(dayBoundary('16/10/2026')).toBeUndefined()
  })
})
