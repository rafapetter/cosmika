'use client'

import * as React from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { AlertTriangle, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRealtime, type RealtimeEvent } from '../lib/use-realtime'
import { useStoredSession } from '../lib/session-store'

type Breach = Extract<RealtimeEvent, { type: 'SlaBreached' }>

/** How long an alarm stays on screen unless dismissed. */
const VISIBLE_MS = 60_000

/** A short two-tone beep, so an agent looking elsewhere hears it. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const tones = [880, 660]
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      gain.gain.value = 0.08
      osc.connect(gain)
      gain.connect(ctx.destination)
      const at = ctx.currentTime + i * 0.18
      osc.start(at)
      osc.stop(at + 0.15)
    })
    window.setTimeout(() => void ctx.close().catch(() => undefined), 800)
  } catch {
    /* no audio: the banner still shows */
  }
}

/**
 * The SLA alarm: when the server says a conversation crossed its SLA and the
 * signed-in person is one of those it is for, a red banner names the
 * conversation, links to it, and beeps once. It also nudges the bell.
 */
export function SlaAlarm() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [alarms, setAlarms] = React.useState<Breach[]>([])
  const me = session?.user.id ?? null

  useRealtime(session?.session.token ?? null, (event) => {
    if (event.type !== 'SlaBreached' || !me || !event.userIds.includes(me)) return
    setAlarms((prev) => [event, ...prev.filter((a) => a.conversationId !== event.conversationId)].slice(0, 3))
    beep()
    window.dispatchEvent(new Event('cosmika:notifications-refresh'))
    window.setTimeout(() => {
      setAlarms((prev) => prev.filter((a) => a.conversationId !== event.conversationId))
    }, VISIBLE_MS)
  })

  if (alarms.length === 0) return null
  return (
    <div className="fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2" role="alert" aria-live="assertive">
      {alarms.map((a) => (
        <div
          key={a.conversationId}
          data-testid="sla-alarm"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive text-destructive-foreground p-3 shadow-lg"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold">{t('slaAlarm.title')}</p>
            <p>
              {t('slaAlarm.body', { displayId: a.displayId })}{' '}
              <Link
                href={`/conversations/${a.conversationId}` as Route}
                className="underline"
                onClick={() => setAlarms((prev) => prev.filter((x) => x !== a))}
              >
                {t('slaAlarm.open')}
              </Link>
            </p>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            className="shrink-0 opacity-80 hover:opacity-100"
            onClick={() => setAlarms((prev) => prev.filter((x) => x !== a))}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
