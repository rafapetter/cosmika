'use client'

import { useEffect, useRef } from 'react'

export type RealtimeEvent =
  | {
      type: 'Connected'
      accountId: string
    }
  | {
      type: 'MessageCreated'
      accountId: string
      conversationId: string
      inboxId: string
      messageId: string
      senderType: string
      content: string | null
      isPrivate: boolean
      createdAt: string
    }
  | {
      type: 'ConversationStatusChanged'
      accountId: string
      conversationId: string
      status: string
      changedAt: string
    }
  | {
      type: 'MessageStatusChanged'
      accountId: string
      conversationId: string
      inboxId: string
      messageId: string
      status: string
    }
  | {
      // A reaction went on or off a message; `reactions` is its whole set.
      type: 'MessageReactionChanged'
      accountId: string
      conversationId: string
      inboxId: string
      messageId: string
      reactions: Record<string, unknown>
    }
  | {
      type: 'ConversationCreated'
      accountId: string
      conversationId: string
      inboxId: string
      contactId: string | null
      createdAt: string
    }
  | {
      // A conversation crossed its SLA; `userIds` are who the alarm is for.
      type: 'SlaBreached'
      accountId: string
      conversationId: string
      displayId: number
      inboxId: string
      teamId: string | null
      assigneeId: string | null
      dimension: 'firstResponse' | 'resolution' | null
      targetAt: string | null
      userIds: string[]
    }

const REALTIME_URL =
  process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:3120/ws'

/**
 * Turn the configured realtime URL into something `new WebSocket()` accepts
 * everywhere. Absolute ws(s):// values pass through; http(s):// is mapped to
 * ws(s)://; a path-only value (`/ws`) is resolved against the page origin so
 * one image can serve any domain behind a same-origin proxy. Older browsers
 * reject relative WebSocket URLs outright, hence the explicit resolution.
 */
export function resolveRealtimeUrl(
  configured: string,
  loc: { protocol: string; host: string } | undefined,
): string {
  if (/^wss?:\/\//i.test(configured)) return configured
  if (/^https?:\/\//i.test(configured)) return configured.replace(/^http/i, 'ws')
  if (!loc) return configured
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = configured.startsWith('/') ? configured : `/${configured}`
  return `${scheme}//${loc.host}${path}`
}

/**
 * Open a WebSocket to the realtime gateway and dispatch every received event
 * into the supplied handler. Reconnects with exponential backoff (capped at
 * 30s). Tracks a "shouldRun" ref to suppress reconnects after unmount.
 */
export function useRealtime(
  token: string | null,
  onEvent: (event: RealtimeEvent) => void,
): void {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    if (!token || typeof window === 'undefined') return
    if (typeof WebSocket === 'undefined') return

    let shouldRun = true
    let ws: WebSocket | null = null
    let backoff = 1000
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      const base = resolveRealtimeUrl(REALTIME_URL, window.location)
      const url = `${base}?token=${encodeURIComponent(token)}`
      ws = new WebSocket(url)
      ws.onopen = () => {
        backoff = 1000
      }
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as RealtimeEvent
          handlerRef.current(parsed)
        } catch {
          // Ignore unparseable payloads.
        }
      }
      ws.onclose = () => {
        if (!shouldRun) return
        timer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
      ws.onerror = () => {
        // Let onclose handle the reconnect path.
      }
    }

    connect()

    return () => {
      shouldRun = false
      if (timer) clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // ignore
      }
    }
  }, [token])
}
