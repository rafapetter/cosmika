// A help desk reads timestamps in the ACCOUNT's zone, not the browser's:
// 21:00 in São Paulo is already tomorrow in UTC, and both operators must see
// the same day.
import { describe, expect, it } from 'vitest'

import { createDateTimeTools } from './format-datetime'

// 2026-09-17T23:30Z = 2026-09-17 20:30 in São Paulo, 2026-09-18 08:30 in Tokyo.
const ISO = '2026-09-17T23:30:00.000Z'

describe('createDateTimeTools', () => {
  it('formats in the account zone and the viewer language', () => {
    const sp = createDateTimeTools('pt-BR', 'America/Sao_Paulo')
    expect(sp.date(ISO)).toBe('17/09/2026')
    expect(sp.time(ISO)).toBe('20:30')
    expect(sp.dateTime(ISO)).toBe('17/09/2026, 20:30')
    expect(sp.dayKey(ISO)).toBe('2026-09-17')
    expect(sp.timeZone).toBe('America/Sao_Paulo')
  })

  it('puts the same instant on the next day for a zone that is already there', () => {
    const tokyo = createDateTimeTools('en', 'Asia/Tokyo')
    expect(tokyo.dayKey(ISO)).toBe('2026-09-18')
    expect(tokyo.date(ISO)).toBe('09/18/2026')
  })

  it('accepts a Date or a timestamp, and custom options', () => {
    const t = createDateTimeTools('pt-BR', 'UTC')
    expect(t.date(new Date(ISO))).toBe('17/09/2026')
    expect(t.date(Date.parse(ISO))).toBe('17/09/2026')
    expect(t.date(ISO, { year: 'numeric' })).toBe('2026')
    expect(t.dateShort(ISO)).toMatch(/17/)
  })

  it('groups numbers the way the language does', () => {
    expect(createDateTimeTools('pt-BR', 'UTC').number(1234567)).toBe('1.234.567')
    expect(createDateTimeTools('en', 'UTC').number(1234567)).toBe('1,234,567')
    expect(createDateTimeTools('en', 'UTC').number(0.5, { style: 'percent' })).toBe('50%')
  })

  it('falls back to UTC when the account carries a zone the runtime rejects', () => {
    const broken = createDateTimeTools('pt-BR', 'Mars/Olympus_Mons')
    expect(broken.timeZone).toBe('UTC')
    expect(broken.dayKey(ISO)).toBe('2026-09-17')
    expect(broken.time(ISO)).toBe('23:30')
  })

  it('defaults to UTC when no zone is given', () => {
    expect(createDateTimeTools('en').timeZone).toBe('UTC')
  })
})
