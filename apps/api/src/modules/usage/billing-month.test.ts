import { describe, expect, it } from 'vitest'

import {
  BILLING_TIMEZONE,
  billingMonthOf,
  billingMonthWindow,
  currentBillingMonthStart,
  nextBillingMonthStart,
  previousBillingMonth,
} from './billing-month'

describe('billingMonthWindow', () => {
  it('opens and closes the month at local midnight in São Paulo', () => {
    const w = billingMonthWindow('2026-08')!
    // Brazil is UTC-3 with no daylight saving since 2019, so local midnight
    // is 03:00 UTC. A UTC window put the last three hours of July into
    // August's invoice, which is enough to make a bill unreconcilable
    // against what the customer sees on their own screen.
    expect(w.start.toISOString()).toBe('2026-08-01T03:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('crosses the year boundary in December', () => {
    const w = billingMonthWindow('2026-12')!
    expect(w.start.toISOString()).toBe('2026-12-01T03:00:00.000Z')
    expect(w.end.toISOString()).toBe('2027-01-01T03:00:00.000Z')
  })

  it('rejects anything that is not YYYY-MM', () => {
    expect(billingMonthWindow('2026-13')).toBeNull()
    expect(billingMonthWindow('2026-00')).toBeNull()
    expect(billingMonthWindow('26-08')).toBeNull()
    expect(billingMonthWindow('2026-08-01')).toBeNull()
    expect(billingMonthWindow('')).toBeNull()
  })

  it('still works for a timezone that DOES observe daylight saving', () => {
    // Not a configuration we use, but the offset is derived rather than
    // hard-coded at -3h precisely so a DST transition inside the month, or a
    // return of Brazilian summer time, cannot silently shift a boundary.
    const w = billingMonthWindow('2026-03', 'America/New_York')!
    expect(w.start.toISOString()).toBe('2026-03-01T05:00:00.000Z') // EST
    expect(w.end.toISOString()).toBe('2026-04-01T04:00:00.000Z') // EDT
  })

  it('lands on local midnight even when the month opens in the DST gap', () => {
    // Lord Howe changes by 30 minutes; a naive single-pass offset lookup gets
    // this half an hour wrong.
    const w = billingMonthWindow('2026-04', 'Australia/Lord_Howe')!
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Australia/Lord_Howe',
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
      }).format(w.start),
    ).toBe('01, 00:00')
  })
})

describe('billingMonthOf', () => {
  it('reads the month from the Brazilian wall clock, not UTC', () => {
    // 01:30 UTC on 1 September is still 22:30 on 31 August in São Paulo, so
    // this usage belongs to August's invoice.
    expect(billingMonthOf(new Date('2026-09-01T01:30:00Z'))).toBe('2026-08')
    expect(billingMonthOf(new Date('2026-09-01T03:30:00Z'))).toBe('2026-09')
  })

  it('defaults to the billing timezone', () => {
    expect(BILLING_TIMEZONE).toBe('America/Sao_Paulo')
    const now = new Date('2026-05-15T12:00:00Z')
    expect(billingMonthOf(now)).toBe(billingMonthOf(now, BILLING_TIMEZONE))
  })
})

describe('previousBillingMonth', () => {
  it('steps back one month', () => {
    expect(previousBillingMonth(new Date('2026-08-02T09:10:00Z'))).toBe('2026-07')
  })

  it('crosses the year boundary', () => {
    expect(previousBillingMonth(new Date('2026-01-15T12:00:00Z'))).toBe('2025-12')
  })

  it('uses the Brazilian month, so the 1st before 03:00 UTC looks back two', () => {
    // 01:00 UTC on 1 September is 31 August locally, so "the previous month"
    // from there is July. The month-end cron runs on the 2nd at 06:10 UTC
    // precisely to stay clear of this edge.
    expect(previousBillingMonth(new Date('2026-09-01T01:00:00Z'))).toBe('2026-07')
  })
})

describe('currentBillingMonthStart / nextBillingMonthStart', () => {
  it('brackets the month the instant falls in', () => {
    const at = new Date('2026-08-17T13:00:00Z')
    expect(currentBillingMonthStart(at).toISOString()).toBe('2026-08-01T03:00:00.000Z')
    expect(nextBillingMonthStart(at).toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('puts the small hours of the 1st in the month that is still running locally', () => {
    const at = new Date('2026-09-01T02:00:00Z') // 23:00 on 31 August in SP
    expect(currentBillingMonthStart(at).toISOString()).toBe('2026-08-01T03:00:00.000Z')
  })

  it('defaults to now without throwing', () => {
    expect(currentBillingMonthStart().getTime()).toBeLessThanOrEqual(Date.now())
    expect(nextBillingMonthStart().getTime()).toBeGreaterThan(Date.now())
  })
})
