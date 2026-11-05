import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLiveRefresh } from './use-live-refresh'

// Capture the realtime handler instead of opening a socket.
let handler: ((e: unknown) => void) | null = null
vi.mock('./use-realtime', () => ({
  useRealtime: (_token: string | null, onEvent: (e: unknown) => void) => {
    handler = onEvent
  },
}))

const msg = (isPrivate = false) => ({
  type: 'MessageCreated',
  accountId: 'a',
  conversationId: 'c',
  inboxId: 'i',
  messageId: 'm',
  senderType: 'CONTACT',
  content: 'x',
  isPrivate,
  createdAt: '',
})

beforeEach(() => {
  vi.useFakeTimers()
  handler = null
})
afterEach(() => vi.useRealTimers())

describe('useLiveRefresh', () => {
  it('coalesces a burst of events into one tick after the throttle window', () => {
    const { result } = renderHook(() => useLiveRefresh('tok', { throttleMs: 1000, intervalMs: 60_000 }))
    act(() => {
      handler!(msg())
      handler!({ type: 'ConversationStatusChanged' })
      handler!({ type: 'ConversationCreated' })
    })
    expect(result.current.tick).toBe(0)
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current.tick).toBe(1)
  })

  it('ignores events that change no number (private notes, delivery ticks)', () => {
    const { result } = renderHook(() => useLiveRefresh('tok', { throttleMs: 10, intervalMs: 60_000 }))
    act(() => {
      handler!(msg(true))
      handler!({ type: 'MessageStatusChanged' })
      handler!({ type: 'Connected' })
    })
    act(() => void vi.advanceTimersByTime(100))
    expect(result.current.tick).toBe(0)
  })

  it('also ticks on the fallback interval, and not without a session', () => {
    const { result } = renderHook(() => useLiveRefresh('tok', { intervalMs: 5000 }))
    act(() => void vi.advanceTimersByTime(10_000))
    expect(result.current.tick).toBe(2)
    const off = renderHook(() => useLiveRefresh(null, { intervalMs: 5000 }))
    act(() => void vi.advanceTimersByTime(10_000))
    expect(off.result.current.tick).toBe(0)
  })

  it('records when the data was last refreshed', () => {
    const { result } = renderHook(() => useLiveRefresh('tok'))
    expect(result.current.lastUpdated).toBeNull()
    act(() => result.current.markUpdated())
    expect(result.current.lastUpdated).toBeInstanceOf(Date)
  })
})
