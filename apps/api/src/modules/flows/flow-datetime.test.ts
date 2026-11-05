import { describe, expect, it } from 'vitest'

import { compareFlowDates, formatFlowNow, parseFlowDate } from './flow-datetime'

const SP = 'America/Sao_Paulo' // UTC-3, no DST since 2019

describe('parseFlowDate', () => {
  it('reads ISO, space-separated and Brazilian moments in the account zone', () => {
    // 18:00 in São Paulo is 21:00 UTC.
    const expected = Date.UTC(2026, 9, 20, 21, 0) / 60_000
    for (const text of ['2026-10-20T18:00', '2026-10-20 18:00', '20/10/2026 18:00', '20/10/2026, 18:00', '2026-10-20 18:00:59']) {
      expect(parseFlowDate(text, SP)).toEqual({ kind: 'moment', minute: expected, dateOnly: false })
    }
  })

  it('reads a bare day as its first minute, flagged dateOnly', () => {
    expect(parseFlowDate('2026-10-20', SP)).toEqual({
      kind: 'moment',
      minute: Date.UTC(2026, 9, 20, 3, 0) / 60_000,
      dateOnly: true,
    })
    expect(parseFlowDate('20/10/2026', SP)).toMatchObject({ dateOnly: true })
  })

  it('takes an explicit offset or Z as an absolute instant', () => {
    expect(parseFlowDate('2026-10-20T18:00Z', SP)).toEqual({
      kind: 'moment',
      minute: Date.UTC(2026, 9, 20, 18, 0) / 60_000,
      dateOnly: false,
    })
    expect(parseFlowDate('2026-10-20T18:00:00-03:00', SP)).toMatchObject({
      minute: Date.UTC(2026, 9, 20, 21, 0) / 60_000,
    })
    // Shape matches but the calendar does not: month 13.
    expect(parseFlowDate('2026-13-20T18:00Z', SP)).toBeNull()
  })

  it('reads a time of day', () => {
    expect(parseFlowDate('9:05', SP)).toEqual({ kind: 'time', minuteOfDay: 545 })
    expect(parseFlowDate('24:00', SP)).toBeNull()
    expect(parseFlowDate('10:60', SP)).toBeNull()
  })

  it('accepts a Date', () => {
    expect(parseFlowDate(new Date(Date.UTC(2026, 0, 1, 12, 30, 45)), SP)).toEqual({
      kind: 'moment',
      minute: Date.UTC(2026, 0, 1, 12, 30) / 60_000,
      dateOnly: false,
    })
  })

  it('rejects what is not a date', () => {
    for (const v of [null, 42, '', '   ', 'amanhã', '2026-02-30', '2026-00-10', '2026-13-10', '2026-10-00', '31/04/2026 10:00', '2026-10-20 25:00', '2026-10-20 10:61']) {
      expect(parseFlowDate(v, SP)).toBeNull()
    }
  })

  it('falls back to UTC on a missing or unknown zone', () => {
    const utc = { kind: 'moment', minute: Date.UTC(2026, 9, 20, 18, 0) / 60_000, dateOnly: false }
    expect(parseFlowDate('2026-10-20 18:00', null)).toEqual(utc)
    expect(parseFlowDate('2026-10-20 18:00', 'Mars/Olympus')).toEqual(utc)
  })

  it('settles wall times across a DST change', () => {
    // New York leaves DST on 2026-11-01: 09:00 that day is UTC-5.
    expect(parseFlowDate('2026-11-01 09:00', 'America/New_York')).toMatchObject({
      minute: Date.UTC(2026, 10, 1, 14, 0) / 60_000,
    })
    expect(parseFlowDate('2026-07-01 09:00', 'America/New_York')).toMatchObject({
      minute: Date.UTC(2026, 6, 1, 13, 0) / 60_000,
    })
  })
})

describe('formatFlowNow', () => {
  it('prints the account clock at minute precision', () => {
    const now = new Date(Date.UTC(2026, 9, 20, 2, 7, 59))
    expect(formatFlowNow(now, SP)).toBe('2026-10-19 23:07')
    expect(formatFlowNow(now, undefined)).toBe('2026-10-20 02:07')
  })
})

describe('compareFlowDates', () => {
  const at = (text: string) => parseFlowDate(text, SP)

  it('before / after at the minute boundary', () => {
    const limit = at('2026-10-20 18:00')
    expect(compareFlowDates('is before', at('2026-10-20 17:59'), limit, null, SP)).toBe(true)
    expect(compareFlowDates('is before', at('2026-10-20 18:00'), limit, null, SP)).toBe(false)
    expect(compareFlowDates('is after', at('2026-10-20 18:00'), limit, null, SP)).toBe(true)
    expect(compareFlowDates('is after', at('2026-10-20 17:59'), limit, null, SP)).toBe(false)
  })

  it('between is start-inclusive, end-exclusive; a bare end day covers the day', () => {
    const from = at('2026-10-20 08:00')
    const to = at('2026-10-22')
    expect(compareFlowDates('is between', at('2026-10-20 07:59'), from, to, SP)).toBe(false)
    expect(compareFlowDates('is between', at('2026-10-20 08:00'), from, to, SP)).toBe(true)
    expect(compareFlowDates('is between', at('2026-10-22 23:59'), from, to, SP)).toBe(true)
    expect(compareFlowDates('is between', at('2026-10-23 00:00'), from, to, SP)).toBe(false)
    expect(
      compareFlowDates('is between', at('2026-10-21 10:00'), from, at('2026-10-21 10:00'), SP),
    ).toBe(false)
  })

  it('a time of day compares the clock only, including a window across midnight', () => {
    const evening = at('2026-10-20 23:30')
    const morning = at('2026-10-21 05:00')
    const noon = at('2026-10-21 12:00')
    expect(compareFlowDates('is after', evening, at('18:00'), null, SP)).toBe(true)
    expect(compareFlowDates('is before', noon, at('18:00'), null, SP)).toBe(true)
    expect(compareFlowDates('is between', noon, at('09:00'), at('18:00'), SP)).toBe(true)
    expect(compareFlowDates('is between', evening, at('22:00'), at('06:00'), SP)).toBe(true)
    expect(compareFlowDates('is between', morning, at('22:00'), at('06:00'), SP)).toBe(true)
    expect(compareFlowDates('is between', noon, at('22:00'), at('06:00'), SP)).toBe(false)
    // A time typed by the contact against a time rule also works.
    expect(compareFlowDates('is before', at('08:00'), at('09:00'), null, SP)).toBe(true)
  })

  it('never matches what it cannot compare', () => {
    const m = at('2026-10-20 18:00')
    expect(compareFlowDates('is before', null, m, null, SP)).toBe(false)
    expect(compareFlowDates('is before', m, null, null, SP)).toBe(false)
    // A bare time on the left against a moment on the right.
    expect(compareFlowDates('is before', at('08:00'), m, null, SP)).toBe(false)
    // Between with no end, or with mixed shapes.
    expect(compareFlowDates('is between', m, m, null, SP)).toBe(false)
    expect(compareFlowDates('is between', m, at('09:00'), m, SP)).toBe(false)
    expect(compareFlowDates('is between', m, m, at('09:00'), SP)).toBe(false)
    expect(compareFlowDates('is on', m, m, null, SP)).toBe(false)
  })
})
