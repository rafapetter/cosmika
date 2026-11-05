'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type {
  AgentAvailabilityDTO,
  SetAgentAvailabilityInput,
} from '@cosmika/shared'
import {
  Button,
  Checkbox,
  Input,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

// i18n keys in DB order (0 = Sunday).
const DAY_KEYS = [
  'availability.day_sun',
  'availability.day_mon',
  'availability.day_tue',
  'availability.day_wed',
  'availability.day_thu',
  'availability.day_fri',
  'availability.day_sat',
] as const

type DayRow = {
  enabled: boolean
  open: string
  close: string
  closedAllDay: boolean
}

const DEFAULT_ROW: DayRow = {
  enabled: false,
  open: '09:00',
  close: '18:00',
  closedAllDay: false,
}

function parseTime(s: string): { hour: number; minute: number } {
  const [h = '0', m = '0'] = s.split(':')
  return { hour: parseInt(h, 10) || 0, minute: parseInt(m, 10) || 0 }
}

function formatTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export default function AgentAvailabilityPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [rows, setRows] = React.useState<DayRow[]>(
    Array(7).fill(0).map(() => ({ ...DEFAULT_ROW })),
  )
  const [memberId, setMemberId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!session) return
    setMemberId(session.membership.id)
    void (async () => {
      try {
        const list = await api.listAgentAvailability(
          session.session.token,
          session.account.id,
          session.membership.id,
        )
        setRows(rowsFromDTO(list))
      } catch (err) {
        setError(apiErrorText(t, err))
      }
    })()
  }, [session, t])

  function rowsFromDTO(list: AgentAvailabilityDTO[]): DayRow[] {
    const out: DayRow[] = Array(7).fill(0).map(() => ({ ...DEFAULT_ROW }))
    list.forEach((a) => {
      out[a.dayOfWeek] = {
        enabled: true,
        open: formatTime(a.openHour, a.openMinute),
        close: formatTime(a.closeHour, a.closeMinute),
        closedAllDay: a.closedAllDay,
      }
    })
    return out
  }

  async function onSave() {
    if (!session || !memberId) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const schedule: SetAgentAvailabilityInput[] = rows
        .map((r, dayOfWeek) => ({ row: r, dayOfWeek }))
        .filter(({ row }) => row.enabled)
        .map(({ row, dayOfWeek }) => {
          const open = parseTime(row.open)
          const close = parseTime(row.close)
          return {
            dayOfWeek,
            openHour: open.hour,
            openMinute: open.minute,
            closeHour: close.hour,
            closeMinute: close.minute,
            closedAllDay: row.closedAllDay,
          }
        })
      await api.replaceAgentAvailability(
        session.session.token,
        session.account.id,
        memberId,
        { schedule },
      )
      setSaved(true)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSaving(false)
    }
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('availability.title')}
        subtitle={t('availability.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('availability.saved')}</p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
        <p className="text-sm font-medium text-foreground">{t('availability.how_title')}</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>{t('availability.how_who')}</li>
          <li>{t('availability.how_rotation')}</li>
          <li>{t('availability.how_nobody')}</li>
          <li>{t('availability.how_no_schedule')}</li>
          <li>{t('availability.how_overnight')}</li>
        </ul>
        <p>{t('availability.timezone_hint', { timezone: session.account.defaultTimezone })}</p>
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        {rows.map((row, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[100px_60px_1fr_1fr_120px] items-center gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0"
          >
            <span className="text-sm font-medium">{t(DAY_KEYS[idx]!)}</span>
            <label className="inline-flex items-center gap-2 text-xs">
              <Checkbox
                checked={row.enabled}
                onCheckedChange={(v) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === idx ? { ...r, enabled: v === true } : r,
                    ),
                  )
                }
                aria-label={t('availability.aria_enabled', { day: t(DAY_KEYS[idx]!) })}
              />
              {t('availability.on')}
            </label>
            <Input
              type="time"
              value={row.open}
              disabled={!row.enabled || row.closedAllDay}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === idx ? { ...r, open: e.target.value } : r,
                  ),
                )
              }
              aria-label={t('availability.aria_open', { day: t(DAY_KEYS[idx]!) })}
            />
            <Input
              type="time"
              value={row.close}
              disabled={!row.enabled || row.closedAllDay}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, i) =>
                    i === idx ? { ...r, close: e.target.value } : r,
                  ),
                )
              }
              aria-label={t('availability.aria_close', { day: t(DAY_KEYS[idx]!) })}
            />
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={row.closedAllDay}
                disabled={!row.enabled}
                onCheckedChange={(v) =>
                  setRows((prev) =>
                    prev.map((r, i) =>
                      i === idx ? { ...r, closedAllDay: v === true } : r,
                    ),
                  )
                }
                aria-label={t('availability.aria_closed_all_day', { day: t(DAY_KEYS[idx]!) })}
              />
              {t('availability.closed_all_day')}
            </label>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving} variant="primary">
          {saving ? t('availability.saving') : t('availability.save')}
        </Button>
      </div>
    </PageContainer>
  )
}
