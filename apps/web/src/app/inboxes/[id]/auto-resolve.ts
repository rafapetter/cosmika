// How long a conversation may sit idle before it is resolved on its own.
//
// The published Terms allow 1 hour to 7 days per inbox. A contact who writes
// after the conversation was resolved starts a new one, which counts on the
// plan's monthly limit, so this is a billing setting as much as a tidiness one.

import { AUTO_RESOLVE_MAX_MINUTES, AUTO_RESOLVE_MIN_MINUTES } from '@cosmika/shared'
import type { useTranslations } from 'next-intl'

type T = ReturnType<typeof useTranslations>

/** The steps offered between the two edges of the allowed window. */
export const AUTO_RESOLVE_PRESETS = [
  AUTO_RESOLVE_MIN_MINUTES,
  120,
  240,
  480,
  720,
  1440,
  2880,
  4320,
  7200,
  AUTO_RESOLVE_MAX_MINUTES,
]

/** A stored value outside the allowed window is shown at the nearest edge. */
export function clampAutoResolve(minutes: number): number {
  return Math.min(Math.max(minutes, AUTO_RESOLVE_MIN_MINUTES), AUTO_RESOLVE_MAX_MINUTES)
}

/** The presets, plus the inbox's current value when it is not one of them. */
export function autoResolveChoices(current: number): number[] {
  return AUTO_RESOLVE_PRESETS.includes(current)
    ? AUTO_RESOLVE_PRESETS
    : [...AUTO_RESOLVE_PRESETS, current].sort((a, b) => a - b)
}

export function autoResolveLabel(t: T, minutes: number): string {
  if (minutes % 1440 === 0) return t('inboxes.auto_close_days', { count: minutes / 1440 })
  if (minutes % 60 === 0) return t('inboxes.auto_close_hours', { count: minutes / 60 })
  return t('inboxes.auto_close_minutes', { count: minutes })
}
