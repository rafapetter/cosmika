// The hook's whole job: take the language from next-intl and the zone from
// the signed-in account, and keep working when there is no session yet.
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const localeMock = vi.fn(() => 'pt-BR')
vi.mock('next-intl', () => ({ useLocale: () => localeMock() }))

let stored: unknown = { account: { defaultTimezone: 'America/Sao_Paulo' } }
vi.mock('./session-store', () => ({
  useStoredSession: () => ({ session: stored }),
}))

import { useDateTime } from './format-datetime'

describe('useDateTime', () => {
  it("uses the account's zone", () => {
    stored = { account: { defaultTimezone: 'America/Sao_Paulo' } }
    const { result } = renderHook(() => useDateTime())
    expect(result.current.timeZone).toBe('America/Sao_Paulo')
    expect(result.current.dateTime('2026-09-17T23:30:00.000Z')).toBe('17/09/2026, 20:30')
  })

  it('falls back to UTC before a session exists', () => {
    stored = null
    const { result } = renderHook(() => useDateTime())
    expect(result.current.timeZone).toBe('UTC')
  })
})
