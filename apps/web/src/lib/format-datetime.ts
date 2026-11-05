'use client'

// Dates, times and numbers in the viewer's language and the ACCOUNT's time
// zone.
//
// The browser's zone is the wrong answer for a help desk: an operator
// travelling, or a team spread across zones, must read the same timestamp as
// everyone else on the account, and "today" has to mean the account's day.
// The account carries `defaultTimezone`; the language comes from next-intl.

import { useMemo } from 'react'
import { useLocale } from 'next-intl'

import { useStoredSession } from './session-store'

type DateLike = string | number | Date

export type DateTimeTools = {
  /** IANA zone every method formats in. */
  timeZone: string
  /** Calendar date, e.g. 17/09/2026. */
  date: (value: DateLike, options?: Intl.DateTimeFormatOptions) => string
  /** Day and month, e.g. 17 de set. */
  dateShort: (value: DateLike) => string
  /** Clock time, e.g. 14:35. */
  time: (value: DateLike) => string
  /** Date and time together. */
  dateTime: (value: DateLike) => string
  /** `YYYY-MM-DD` in the account's zone, for "is this today?" comparisons. */
  dayKey: (value: DateLike) => string
  /** Grouped number, e.g. 1.234. */
  number: (value: number, options?: Intl.NumberFormatOptions) => string
}

const FALLBACK_TIMEZONE = 'UTC'

/** Pure builder: the hook below only supplies locale and zone. */
export function createDateTimeTools(
  locale: string,
  timeZone: string = FALLBACK_TIMEZONE,
): DateTimeTools {
  // An account with a zone the runtime rejects must not break every screen
  // that shows a timestamp, so fall back instead of throwing.
  const zone = safeZone(timeZone)
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: zone, ...options })
  const dateFmt = fmt({ day: '2-digit', month: '2-digit', year: 'numeric' })
  const shortFmt = fmt({ day: 'numeric', month: 'short' })
  const timeFmt = fmt({ hour: '2-digit', minute: '2-digit' })
  const dateTimeFmt = fmt({
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  // en-CA gives ISO-ordered parts, which compare as strings.
  const keyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const numberFmt = new Intl.NumberFormat(locale)

  return {
    timeZone: zone,
    date: (value, options) =>
      options ? fmt(options).format(new Date(value)) : dateFmt.format(new Date(value)),
    dateShort: (value) => shortFmt.format(new Date(value)),
    time: (value) => timeFmt.format(new Date(value)),
    dateTime: (value) => dateTimeFmt.format(new Date(value)),
    dayKey: (value) => keyFmt.format(new Date(value)),
    number: (value, options) =>
      options ? new Intl.NumberFormat(locale, options).format(value) : numberFmt.format(value),
  }
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0)
    return timeZone
  } catch {
    return FALLBACK_TIMEZONE
  }
}

export function useDateTime(): DateTimeTools {
  const locale = useLocale()
  const { session } = useStoredSession()
  const timeZone = session?.account.defaultTimezone ?? FALLBACK_TIMEZONE
  return useMemo(() => createDateTimeTools(locale, timeZone), [locale, timeZone])
}
