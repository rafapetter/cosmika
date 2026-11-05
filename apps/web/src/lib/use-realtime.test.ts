// Tests for the WebSocket realtime hook. WebSocket is mocked at the global
// level so we can drive the connection lifecycle deterministically.
import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRealtime, type RealtimeEvent, resolveRealtimeUrl } from './use-realtime'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  url: string
  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  close = vi.fn()
  // Test helpers — not part of the WebSocket API.
  triggerOpen() {
    this.onopen?.()
  }
  triggerMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
  triggerRawMessage(raw: string) {
    this.onmessage?.({ data: raw })
  }
  triggerClose() {
    this.onclose?.()
  }
  triggerError() {
    this.onerror?.()
  }
}

const ORIGINAL_WS = globalThis.WebSocket

beforeEach(() => {
  MockWebSocket.instances = []
  ;(globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket
  vi.useFakeTimers()
})

afterEach(() => {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = ORIGINAL_WS
  vi.useRealTimers()
})

describe('resolveRealtimeUrl', () => {
  const loc = { protocol: 'https:', host: 'app.cliente.com' }
  it('passes absolute ws(s) URLs through untouched', () => {
    expect(resolveRealtimeUrl('wss://rt.example.com/ws', loc)).toBe('wss://rt.example.com/ws')
    expect(resolveRealtimeUrl('ws://localhost:3120/ws', loc)).toBe('ws://localhost:3120/ws')
  })
  it('maps http(s) to ws(s)', () => {
    expect(resolveRealtimeUrl('https://rt.example.com/ws', loc)).toBe('wss://rt.example.com/ws')
    expect(resolveRealtimeUrl('http://rt.example.com/ws', loc)).toBe('ws://rt.example.com/ws')
  })
  it('resolves a path against the page origin, matching its scheme', () => {
    expect(resolveRealtimeUrl('/ws', loc)).toBe('wss://app.cliente.com/ws')
    expect(resolveRealtimeUrl('ws', { protocol: 'http:', host: 'localhost:3100' })).toBe('ws://localhost:3100/ws')
  })
  it('leaves a path alone when there is no location to resolve against', () => {
    expect(resolveRealtimeUrl('/ws', undefined)).toBe('/ws')
  })
})

describe('useRealtime', () => {
  it('opens a WebSocket to the configured URL with the token query', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok123', onEvent))
    expect(MockWebSocket.instances).toHaveLength(1)
    const ws = MockWebSocket.instances[0]!
    expect(ws.url).toContain('token=tok123')
  })

  it('skips connecting when token is null', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime(null, onEvent))
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('parses JSON messages and forwards them to the handler', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    const ws = MockWebSocket.instances[0]!
    ws.triggerOpen()
    const event: RealtimeEvent = { type: 'Connected', accountId: 'acc1' }
    ws.triggerMessage(event)
    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('ignores unparseable messages without crashing', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    const ws = MockWebSocket.instances[0]!
    ws.triggerRawMessage('not-json')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reconnects with backoff after close (1s → 2s → 4s → …)', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]!.triggerClose()
    // Backoff was 1000ms initially.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    MockWebSocket.instances[1]!.triggerClose()
    // Next backoff is 2000ms.
    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('resets backoff to 1s after a successful open', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    MockWebSocket.instances[0]!.triggerClose()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    MockWebSocket.instances[1]!.triggerOpen() // resets backoff
    MockWebSocket.instances[1]!.triggerClose()
    // Backoff should be 1s again, not 2s.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('caps backoff at 30s', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    // Trigger enough close cycles for backoff to saturate (need ≥ 6 doublings).
    let backoff = 1000
    for (let i = 0; i < 10; i++) {
      MockWebSocket.instances[i]!.triggerClose()
      act(() => {
        vi.advanceTimersByTime(backoff)
      })
      backoff = Math.min(backoff * 2, 30_000)
    }
    // After saturation, advancing exactly 30s creates one more connection.
    const before = MockWebSocket.instances.length
    MockWebSocket.instances[before - 1]!.triggerClose()
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(MockWebSocket.instances.length).toBeGreaterThan(before)
  })

  it('does NOT reconnect after unmount', () => {
    const onEvent = vi.fn()
    const { unmount } = renderHook(() => useRealtime('tok', onEvent))
    expect(MockWebSocket.instances).toHaveLength(1)
    const ws = MockWebSocket.instances[0]!
    unmount()
    ws.triggerClose()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(MockWebSocket.instances).toHaveLength(1) // still 1
    expect(ws.close).toHaveBeenCalled()
  })

  it('error handler is wired (no-op, close drives the reconnect)', () => {
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    const ws = MockWebSocket.instances[0]!
    // Should not throw.
    expect(() => ws.triggerError()).not.toThrow()
  })

  it('handler ref tracks the latest onEvent without resubscribing', () => {
    const firstHandler = vi.fn()
    const secondHandler = vi.fn()
    const { rerender } = renderHook(
      ({ h }: { h: (e: RealtimeEvent) => void }) => useRealtime('tok', h),
      { initialProps: { h: firstHandler } },
    )
    expect(MockWebSocket.instances).toHaveLength(1)
    // Rerender with a new handler — should NOT open a new ws.
    rerender({ h: secondHandler })
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0]!.triggerMessage({ type: 'Connected', accountId: 'a' })
    expect(firstHandler).not.toHaveBeenCalled()
    expect(secondHandler).toHaveBeenCalled()
  })
})

describe('useRealtime SSR-safety', () => {
  it('noops when WebSocket is unavailable', () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = undefined
    const onEvent = vi.fn()
    renderHook(() => useRealtime('tok', onEvent))
    expect(MockWebSocket.instances).toHaveLength(0)
  })
})
