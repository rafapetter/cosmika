import { describe, expect, it } from 'vitest'

import {
  type AvailabilitySlot,
  isWithinSchedule,
  localMoment,
} from './availability-window'

function slot(over: Partial<AvailabilitySlot> = {}): AvailabilitySlot {
  return {
    dayOfWeek: 1, // Monday
    openHour: 9,
    openMinute: 0,
    closeHour: 18,
    closeMinute: 0,
    closedAllDay: false,
    ...over,
  }
}

const at = (dayOfWeek: number, hh: number, mm = 0) => ({
  dayOfWeek,
  minuteOfDay: hh * 60 + mm,
})

describe('localMoment', () => {
  it('reads weekday and minute in UTC', () => {
    // 2026-05-04 is a Monday.
    expect(localMoment(new Date('2026-05-04T14:30:00Z'), 'UTC')).toEqual(at(1, 14, 30))
  })

  it('shifts into the account timezone, crossing midnight back a day', () => {
    // 02:15 UTC on Monday is 23:15 on Sunday in Sao Paulo (UTC-3).
    expect(
      localMoment(new Date('2026-05-04T02:15:00Z'), 'America/Sao_Paulo'),
    ).toEqual(at(0, 23, 15))
  })

  it('reports midnight as minute 0, not 24:00', () => {
    expect(localMoment(new Date('2026-05-05T00:00:00Z'), 'UTC')).toEqual(at(2, 0))
  })

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    expect(localMoment(new Date('2026-05-04T14:30:00Z'), 'Not/AZone')).toEqual(
      at(1, 14, 30),
    )
  })
})

describe('isWithinSchedule', () => {
  it('is off with no schedule at all', () => {
    expect(isWithinSchedule([], at(1, 10))).toBe(false)
  })

  it('covers a same-day window, open inclusive and close exclusive', () => {
    const s = [slot()]
    expect(isWithinSchedule(s, at(1, 9))).toBe(true)
    expect(isWithinSchedule(s, at(1, 17, 59))).toBe(true)
    expect(isWithinSchedule(s, at(1, 18))).toBe(false)
    expect(isWithinSchedule(s, at(1, 8, 59))).toBe(false)
  })

  it('honours minutes on both ends', () => {
    const s = [slot({ openHour: 8, openMinute: 30, closeHour: 12, closeMinute: 15 })]
    expect(isWithinSchedule(s, at(1, 8, 29))).toBe(false)
    expect(isWithinSchedule(s, at(1, 8, 30))).toBe(true)
    expect(isWithinSchedule(s, at(1, 12, 14))).toBe(true)
    expect(isWithinSchedule(s, at(1, 12, 15))).toBe(false)
  })

  it('only applies a window to its own weekday', () => {
    expect(isWithinSchedule([slot()], at(2, 10))).toBe(false)
  })

  it('never covers a day marked closed all day', () => {
    expect(isWithinSchedule([slot({ closedAllDay: true })], at(1, 10))).toBe(false)
  })

  it('treats open equal to close as an empty window', () => {
    expect(
      isWithinSchedule([slot({ openHour: 9, closeHour: 9 })], at(1, 9)),
    ).toBe(false)
  })

  it('an overnight window covers the evening of its day and the next early morning', () => {
    const s = [slot({ dayOfWeek: 5, openHour: 22, closeHour: 6 })] // Fri 22:00 to Sat 06:00
    expect(isWithinSchedule(s, at(5, 23))).toBe(true)
    expect(isWithinSchedule(s, at(5, 21, 59))).toBe(false)
    expect(isWithinSchedule(s, at(6, 5, 59))).toBe(true)
    expect(isWithinSchedule(s, at(6, 6))).toBe(false)
    // Not the morning of its own day, nor two days later.
    expect(isWithinSchedule(s, at(5, 3))).toBe(false)
    expect(isWithinSchedule(s, at(0, 3))).toBe(false)
  })

  it('an overnight Saturday window wraps into Sunday', () => {
    const s = [slot({ dayOfWeek: 6, openHour: 20, closeHour: 2 })]
    expect(isWithinSchedule(s, at(0, 1))).toBe(true)
  })

  it('is on when any of several slots covers the moment', () => {
    const s = [slot({ dayOfWeek: 1 }), slot({ dayOfWeek: 2, openHour: 13 })]
    expect(isWithinSchedule(s, at(2, 14))).toBe(true)
    expect(isWithinSchedule(s, at(2, 12))).toBe(false)
  })
})
