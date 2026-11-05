'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { type RealtimeEvent, useRealtime } from './use-realtime'

/** Events that move a report number: new conversations, messages, status changes. */
const LIVE_EVENTS = new Set<RealtimeEvent['type']>([
  'ConversationCreated',
  'ConversationStatusChanged',
  'MessageCreated',
])

/**
 * Drives a "live" dashboard: `tick` advances shortly after a relevant realtime
 * event (a burst of messages coalesces into one refetch per `throttleMs`) and
 * on a fallback interval, which also covers a dropped WebSocket. Hidden tabs
 * skip the interval; the next event or tick after they return catches up.
 */
export function useLiveRefresh(
  token: string | null,
  { throttleMs = 2_000, intervalMs = 30_000 }: { throttleMs?: number; intervalMs?: number } = {},
): { tick: number; lastUpdated: Date | null; markUpdated: () => void } {
  const [tick, setTick] = useState(0)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  const bump = useCallback(() => {
    if (pending.current) return
    pending.current = setTimeout(() => {
      pending.current = null
      setTick((n) => n + 1)
    }, throttleMs)
  }, [throttleMs])

  useRealtime(token, (event) => {
    if (!LIVE_EVENTS.has(event.type)) return
    // An internal note changes no report number.
    if (event.type === 'MessageCreated' && event.isPrivate) return
    bump()
  })

  useEffect(() => {
    if (!token) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      setTick((n) => n + 1)
    }, intervalMs)
    return () => clearInterval(id)
  }, [token, intervalMs])

  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )

  const markUpdated = useCallback(() => setLastUpdated(new Date()), [])
  return { tick, lastUpdated, markUpdated }
}
