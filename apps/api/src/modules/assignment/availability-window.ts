// Pure time math for "is this agent on shift right now?". Kept free of Nest
// and Prisma so the rules are testable with plain values.
//
// An agent's schedule is the set of `AgentAvailability` rows saved on the
// "Minha disponibilidade" screen: at most one window per weekday, in the
// account's timezone. A weekday with no row, or marked closedAllDay, is off.

export type AvailabilitySlot = {
  dayOfWeek: number // 0 = Sunday, 6 = Saturday
  openHour: number
  openMinute: number
  closeHour: number
  closeMinute: number
  closedAllDay: boolean
}

export type LocalMoment = { dayOfWeek: number; minuteOfDay: number }

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function partsIn(now: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(now)
}

/**
 * Weekday and minute of the day of `now` as seen in `timeZone`. An unknown
 * timezone name falls back to UTC instead of throwing: a bad account setting
 * must not stop conversations from being distributed.
 */
export function localMoment(now: Date, timeZone: string): LocalMoment {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = partsIn(now, timeZone)
  } catch {
    parts = partsIn(now, 'UTC')
  }
  // hour, minute and weekday are always present with the options above.
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const hour = Number(map.hour) % 24
  const minute = Number(map.minute)
  return {
    dayOfWeek: WEEKDAYS[map.weekday!]!,
    minuteOfDay: hour * 60 + minute,
  }
}

/**
 * True when one of the slots covers the moment.
 *
 * - Same-day window (close after open): covers [open, close).
 * - Overnight window (close before open, e.g. 22:00 to 06:00): covers from
 *   open until midnight on its own weekday, and from midnight until close on
 *   the following weekday.
 * - open equal to close is an empty window, and closedAllDay is never on.
 */
export function isWithinSchedule(
  slots: AvailabilitySlot[],
  at: LocalMoment,
): boolean {
  const previousDay = (at.dayOfWeek + 6) % 7
  return slots.some((slot) => {
    if (slot.closedAllDay) return false
    const open = slot.openHour * 60 + slot.openMinute
    const close = slot.closeHour * 60 + slot.closeMinute
    if (close > open) {
      return (
        slot.dayOfWeek === at.dayOfWeek &&
        at.minuteOfDay >= open &&
        at.minuteOfDay < close
      )
    }
    if (close === open) return false
    if (slot.dayOfWeek === at.dayOfWeek) return at.minuteOfDay >= open
    return slot.dayOfWeek === previousDay && at.minuteOfDay < close
  })
}
