'use client'

import * as React from 'react'
import Link from 'next/link'
import type { Route } from 'next'
import { useTranslations } from 'next-intl'
import type { SlaMissDTO, TeamDTO } from '@cosmika/shared'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const ALL = '__all__'

/** Date and time to the second: with a 60 s target, minutes are not enough. */
function withSeconds(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
}

/** yyyy-mm-dd of a local date, for the date inputs. */
function day(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Missed conversations: every one that crossed its first-response SLA, with
 * when it entered the queue, its deadline, when the breach was caught and the
 * sector it was in. Filters by day range and team; exports CSV.
 */
export default function SlaMissesPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const today = day(new Date())
  const [from, setFrom] = React.useState(today)
  const [to, setTo] = React.useState(today)
  const [teamId, setTeamId] = React.useState(ALL)
  const [teams, setTeams] = React.useState<TeamDTO[]>([])
  const [rows, setRows] = React.useState<SlaMissDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const filter = React.useMemo(
    () => ({
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59.999`).toISOString(),
      ...(teamId !== ALL && { teamId }),
    }),
    [from, to, teamId],
  )

  const load = React.useCallback(async () => {
    if (!session) return
    setError(null)
    try {
      setRows(await api.slaMisses(session.session.token, session.account.id, filter))
    } catch (err) {
      setError(apiErrorText(t, err))
      setRows([])
    }
  }, [session, filter, t])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!session) return
    api
      .listTeams(session.session.token, session.account.id)
      .then(setTeams)
      .catch(() => setTeams([]))
  }, [session])

  async function downloadCsv() {
    if (!session) return
    const csv = await api.slaMissesCsv(session.session.token, session.account.id, filter)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `atendimentos-perdidos-${from}_${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader title={t('slaMisses.title')} subtitle={t('slaMisses.subtitle')} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('slaMisses.from')}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('slaMisses.to')}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
        </label>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('slaMisses.team')}
          <Select value={teamId} onValueChange={setTeamId}>
            <SelectTrigger className="h-9 w-48" aria-label={t('slaMisses.team')} data-testid="sla-misses-team">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('slaMisses.all_teams')}</SelectItem>
              {teams.map((tm) => (
                <SelectItem key={tm.id} value={tm.id}>
                  {tm.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t('slaMisses.refresh')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void downloadCsv()} disabled={!rows?.length}>
          {t('slaMisses.download_csv')}
        </Button>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          {t('slaMisses.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" data-testid="sla-misses-table">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('slaMisses.col_conversation')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_sector')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_queued')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_deadline')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_breached')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_first_reply')}</th>
                <th className="px-3 py-2">{t('slaMisses.col_agent')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.conversationId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link href={`/conversations/${r.conversationId}` as Route} className="text-primary hover:underline">
                      #{r.displayId}
                    </Link>{' '}
                    <span className="text-muted-foreground">{r.contactName ?? ''}</span>
                  </td>
                  <td className="px-3 py-2">
                    {r.teamName ?? t('slaMisses.no_team')}
                    <span className="block text-xs text-muted-foreground">{r.inboxName}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{withSeconds(r.queuedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{withSeconds(r.targetAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-medium text-destructive">{withSeconds(r.breachedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.firstReplyAt ? withSeconds(r.firstReplyAt) : t('slaMisses.no_reply')}
                  </td>
                  <td className="px-3 py-2">{r.assigneeName ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  )
}
