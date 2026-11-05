// ─── Date/time comparisons for the Condition block ──────────────────────
//
// Pure helpers behind the `now` system variable and the "Is before / Is
// after / Is between" operators. Everything is evaluated at MINUTE
// precision in the account's IANA timezone: an author who writes
// "2026-10-20 18:00" means 18:00 on the clock of the people answering, not
// UTC, and a notice set to expire at 18:00 must be gone at 18:00:00 sharp,
// not at 18:00:59.
//
// A value is one of three shapes:
//   - a moment ("2026-10-20 18:00", "20/10/2026 18:00", ISO with offset),
//   - a day ("2026-10-20", "20/10/2026"), read as 00:00 of that day,
//   - a time of day ("18:00"), which compares the clock only, every day.

export const DATE_OPERATORS = new Set(['is before', 'is after', 'is between'])

const FALLBACK_TZ = 'UTC'

export type FlowDateValue =
  // Minutes since the epoch. `dateOnly` marks a bare day, so "between" can
  // treat its end as the whole day rather than its first minute.
  | { kind: 'moment'; minute: number; dateOnly: boolean }
  // Minutes since local midnight, 0..1439.
  | { kind: 'time'; minuteOfDay: number }

type Wall = { year: number; month: number; day: number; hour: number; minute: number }

function validTz(tz: string | null | undefined): string {
  if (!tz) return FALLBACK_TZ
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return FALLBACK_TZ
  }
}

/** The wall clock in `tz` at instant `ms`. */
function wallAt(ms: number, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const by: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') by[p.type] = Number(p.value)
  return {
    year: by.year!,
    month: by.month!,
    day: by.day!,
    hour: by.hour! % 24,
    minute: by.minute!,
  }
}

/** The instant (ms) at which the clock in `tz` reads `w`. */
function instantOf(w: Wall, tz: string): number {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)
  // Offset of the zone near that moment; a second pass settles DST edges.
  const offset = (ms: number) => {
    const at = wallAt(ms, tz)
    return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute) - ms
  }
  const first = asUtc - offset(asUtc)
  return asUtc - offset(first)
}

function valid(w: Wall): boolean {
  // The patterns only let digits through, so nothing here can be negative.
  if (w.month < 1 || w.month > 12 || w.day < 1) return false
  if (w.hour > 23 || w.minute > 59) return false
  // Day past the end of its month ("2026-02-30") rolls over in Date.UTC.
  const probe = new Date(Date.UTC(w.year, w.month - 1, w.day))
  return probe.getUTCMonth() === w.month - 1
}

/** `now` as the account reads it: "YYYY-MM-DD HH:mm". */
export function formatFlowNow(now: Date, tz: string | null | undefined): string {
  const w = wallAt(now.getTime(), validTz(tz))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`
}

/** Parse what an author (or a date question) wrote. Null when it is not a date. */
export function parseFlowDate(raw: unknown, tz: string | null | undefined): FlowDateValue | null {
  if (raw instanceof Date) {
    return { kind: 'moment', minute: Math.floor(raw.getTime() / 60_000), dateOnly: false }
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  const zone = validTz(tz)

  const time = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (time) {
    const h = Number(time[1])
    const m = Number(time[2])
    if (h > 23 || m > 59) return null
    return { kind: 'time', minuteOfDay: h * 60 + m }
  }

  // An explicit offset or Z is an absolute instant; the account zone does not apply.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text)
    return Number.isNaN(ms) ? null : { kind: 'moment', minute: Math.floor(ms / 60_000), dateOnly: false }
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(text)
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(text)
  let w: Wall | null = null
  let dateOnly = false
  if (iso) {
    dateOnly = iso[4] === undefined
    w = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4] ?? 0),
      minute: Number(iso[5] ?? 0),
    }
  } else if (br) {
    dateOnly = br[4] === undefined
    w = {
      year: Number(br[3]),
      month: Number(br[2]),
      day: Number(br[1]),
      hour: Number(br[4] ?? 0),
      minute: Number(br[5] ?? 0),
    }
  }
  if (!w || !valid(w)) return null
  return { kind: 'moment', minute: Math.floor(instantOf(w, zone) / 60_000), dateOnly }
}

function minuteOfDay(minute: number, tz: string): number {
  const w = wallAt(minute * 60_000, tz)
  return w.hour * 60 + w.minute
}

/**
 * Evaluate one date comparison. `left` is the instant being tested (`now`, or
 * a date the contact typed); `from`/`to` are the author's values. A pair that
 * cannot be compared (unparseable, or a time of day against a bare time)
 * never matches: a broken rule must not show an expired notice.
 */
export function compareFlowDates(
  op: string,
  left: FlowDateValue | null,
  from: FlowDateValue | null,
  to: FlowDateValue | null,
  tz: string | null | undefined,
): boolean {
  if (!left || !from) return false
  const zone = validTz(tz)
  // A time-of-day rule compares the clock only; any other rule needs a moment.
  const timeOfDay = from.kind === 'time'
  const clockOf = (v: FlowDateValue): number =>
    v.kind === 'time' ? v.minuteOfDay : minuteOfDay(v.minute, zone)
  const valueOf = (v: FlowDateValue): number =>
    timeOfDay ? clockOf(v) : (v as { minute: number }).minute
  if (!timeOfDay && left.kind === 'time') return false
  const x = valueOf(left)
  const a = valueOf(from)
  switch (op) {
    case 'is before':
      return x < a
    case 'is after':
      return x >= a
    case 'is between': {
      if (!to || (to.kind === 'time') !== timeOfDay) return false
      // A bare end day includes the whole day: "between 20/10 and 22/10"
      // still shows the notice on the evening of the 22nd.
      const b = valueOf(to) + (to.kind === 'moment' && to.dateOnly ? 24 * 60 : 0)
      if (timeOfDay && a > b) return x >= a || x < b // crosses midnight: 22:00 to 06:00
      return x >= a && x < b
    }
    default:
      return false
  }
}
