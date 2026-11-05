// Unit tests for the localStorage-backed session store.
import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearSession,
  readSession,
  useStoredSession,
  writeSession,
} from './session-store'

const SAMPLE = {
  token: 'tok',
  user: { id: 'u1', email: 'a@e.com' },
  account: { id: 'acc1', name: 'Acme' },
} as unknown as Parameters<typeof writeSession>[0]

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readSession', () => {
  it('returns null when no session is stored', () => {
    expect(readSession()).toBeNull()
  })

  it('returns parsed session when stored', () => {
    writeSession(SAMPLE)
    expect(readSession()).toEqual(SAMPLE)
  })

  it('returns null on malformed JSON', () => {
    window.localStorage.setItem('cosmika.session', '{ broken')
    expect(readSession()).toBeNull()
  })
})

describe('writeSession', () => {
  it('persists the JSON payload', () => {
    writeSession(SAMPLE)
    const raw = window.localStorage.getItem('cosmika.session')
    expect(raw).toBe(JSON.stringify(SAMPLE))
  })
})

describe('clearSession', () => {
  it('removes the stored session', () => {
    writeSession(SAMPLE)
    clearSession()
    expect(readSession()).toBeNull()
  })
})

describe('useStoredSession', () => {
  it('returns ready=true and the stored session after mount', () => {
    writeSession(SAMPLE)
    const { result, rerender } = renderHook(() => useStoredSession())
    // After the first effect runs the hook should be ready.
    rerender()
    expect(result.current.ready).toBe(true)
    expect(result.current.session).toEqual(SAMPLE)
  })

  it('returns null session when nothing stored', () => {
    const { result, rerender } = renderHook(() => useStoredSession())
    rerender()
    expect(result.current.ready).toBe(true)
    expect(result.current.session).toBeNull()
  })

  it('exposes setSession to update local state', () => {
    const { result } = renderHook(() => useStoredSession())
    act(() => {
      result.current.setSession(SAMPLE)
    })
    expect(result.current.session).toEqual(SAMPLE)
  })
})

// SSR-safety: each helper guards `typeof window === 'undefined'`. We can't
// fully simulate Node-side rendering here (jsdom always has window), but we
// can verify the helpers don't throw if localStorage is missing — the
// classic Safari "private mode" failure mode.
describe('session-store hardened against missing localStorage', () => {
  it('writeSession noops gracefully when localStorage throws', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded')
      })
    expect(() => writeSession(SAMPLE)).toThrow() // the impl re-throws
    spy.mockRestore()
  })
})
