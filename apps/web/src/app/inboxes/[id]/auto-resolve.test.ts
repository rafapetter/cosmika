// The auto-close window is a billing setting: the Terms allow 1 hour to 7
// days, and a contact who writes after the close opens a new, counted
// conversation. The screen must never offer or show a value outside it.
import { describe, expect, it } from 'vitest'

import {
  AUTO_RESOLVE_PRESETS,
  autoResolveChoices,
  autoResolveLabel,
  clampAutoResolve,
} from './auto-resolve'

const t = ((key: string, values?: { count: number }) =>
  values ? `${key}:${values.count}` : key) as never

describe('auto-resolve window', () => {
  it('offers steps from 1 hour to 7 days and nothing beyond', () => {
    expect(AUTO_RESOLVE_PRESETS[0]).toBe(60)
    expect(AUTO_RESOLVE_PRESETS[AUTO_RESOLVE_PRESETS.length - 1]).toBe(10080)
    expect([...AUTO_RESOLVE_PRESETS].sort((a, b) => a - b)).toEqual(AUTO_RESOLVE_PRESETS)
  })

  it('shows a stored value outside the window at the nearest edge', () => {
    expect(clampAutoResolve(5)).toBe(60)
    expect(clampAutoResolve(43200)).toBe(10080)
    expect(clampAutoResolve(240)).toBe(240)
  })

  it('keeps an odd current value selectable, in order, without duplicating a preset', () => {
    expect(autoResolveChoices(1440)).toEqual(AUTO_RESOLVE_PRESETS)
    const withOdd = autoResolveChoices(90)
    expect(withOdd).toHaveLength(AUTO_RESOLVE_PRESETS.length + 1)
    expect(withOdd.slice(0, 3)).toEqual([60, 90, 120])
  })

  it('labels whole days as days, whole hours as hours, and the rest in minutes', () => {
    expect(autoResolveLabel(t, 10080)).toBe('inboxes.auto_close_days:7')
    expect(autoResolveLabel(t, 1440)).toBe('inboxes.auto_close_days:1')
    expect(autoResolveLabel(t, 720)).toBe('inboxes.auto_close_hours:12')
    expect(autoResolveLabel(t, 60)).toBe('inboxes.auto_close_hours:1')
    expect(autoResolveLabel(t, 90)).toBe('inboxes.auto_close_minutes:90')
  })
})
