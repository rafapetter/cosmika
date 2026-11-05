'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useState } from 'react'
import type {
  BreakdownDimension,
  BreakdownResponse,
  InboxDTO,
  LeaderboardResponse,
  OverviewResponse,
  TeamDTO,
  TimeseriesResponse,
} from '@cosmika/shared'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useDateTime } from '../../lib/format-datetime'
import { useLiveRefresh } from '../../lib/use-live-refresh'
import { useStoredSession } from '../../lib/session-store'

type RangePreset = '7' | '30' | '90' | 'all'

// "All time" lower bound — earlier than any conversation. Default range so
// reports aren't empty on accounts whose data predates a recent window
// (e.g. migrated-from-Nebula history).
const ALL_TIME_FROM = '2015-01-01'

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days + 1)
  return d.toISOString().slice(0, 10)
}

function formatDuration(seconds: number | null, dash: string): string {
  if (seconds === null || seconds === undefined) return dash
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#10b981',
  neutral: '#94a3b8',
  negative: '#ef4444',
  unknown: '#cbd5e1',
}

// Radix Select reserves the empty string, so "all" travels as a sentinel.
const ALL = '__all__'

export default function ReportsPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()

  const [from, setFrom] = useState<string>(ALL_TIME_FROM)
  const [to, setTo] = useState<string>(todayISO())
  const [inboxId, setInboxId] = useState<string>('')
  const [teamId, setTeamId] = useState<string>('')

  const [inboxes, setInboxes] = useState<InboxDTO[]>([])
  const [teams, setTeams] = useState<TeamDTO[]>([])

  const [overview, setOverview] = useState<OverviewResponse | null>(null)
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(
    null,
  )

  const [breakdownDim, setBreakdownDim] = useState<BreakdownDimension>('inbox')
  const [breakdown, setBreakdown] = useState<BreakdownResponse | null>(null)
  const [downloadingCsv, setDownloadingCsv] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Live dashboard (PoC item 14): refetch shortly after conversations or
  // messages change, plus a 30 s fallback. The page keeps showing the last
  // numbers while a refresh is in flight (`loading && !overview`).
  const live = useLiveRefresh(session?.session.token ?? null)
  const fmt = useDateTime()

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    const token = session.session.token
    const acct = session.account.id
    Promise.all([
      api.listInboxes(token, acct).catch(() => []),
      api.listTeams(token, acct).catch(() => []),
    ]).then(([ibs, tms]) => {
      setInboxes(ibs)
      setTeams(tms)
    })
  }, [ready, session, router])

  useEffect(() => {
    if (!ready || !session) return
    const token = session.session.token
    const acct = session.account.id
    const filter = { from, to, ...(inboxId ? { inboxId } : {}), ...(teamId ? { teamId } : {}) }
    setLoading(true)
    setError(null)
    Promise.all([
      api.reportsOverview(token, acct, filter),
      api.reportsTimeseries(token, acct, {
        ...filter,
        metric: 'conversations',
        bucket: 'day',
      }),
      api.reportsLeaderboard(token, acct, { from, to }),
    ])
      .then(([ov, ts, lb]) => {
        setOverview(ov)
        setTimeseries(ts)
        setLeaderboard(lb)
        live.markUpdated()
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('reports.forbidden'))
        } else {
          setError(t('auth.generic_error'))
        }
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markUpdated is stable
  }, [ready, session, from, to, inboxId, teamId, t, live.tick])

  useEffect(() => {
    if (!ready || !session) return
    api
      .reportsBreakdown(session.session.token, session.account.id, {
        dimension: breakdownDim,
        from,
        to,
      })
      .then(setBreakdown)
      .catch(() => setBreakdown(null))
  }, [ready, session, from, to, breakdownDim, live.tick])

  async function downloadCsv() {
    if (!session) return
    setDownloadingCsv(true)
    try {
      const csv = await api.reportsBreakdownCsv(
        session.session.token,
        session.account.id,
        { dimension: breakdownDim, from, to },
      )
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `breakdown-${breakdownDim}-${from}_${to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setDownloadingCsv(false)
    }
  }

  const dash = t('reports.duration_unknown')

  const sentimentData = useMemo(() => {
    if (!overview) return []
    return [
      {
        name: t('reports.sentiment_positive'),
        key: 'positive',
        value: overview.sentimentBreakdown.positive,
      },
      {
        name: t('reports.sentiment_neutral'),
        key: 'neutral',
        value: overview.sentimentBreakdown.neutral,
      },
      {
        name: t('reports.sentiment_negative'),
        key: 'negative',
        value: overview.sentimentBreakdown.negative,
      },
      {
        name: t('reports.sentiment_unknown'),
        key: 'unknown',
        value: overview.sentimentBreakdown.unknown,
      },
    ].filter((d) => d.value > 0)
  }, [overview, t])

  const resolvedRate = useMemo(() => {
    if (!overview || overview.totalConversations === 0) return null
    return overview.statusCounts.resolved / overview.totalConversations
  }, [overview])

  function applyPreset(p: RangePreset) {
    setTo(todayISO())
    setFrom(p === 'all' ? ALL_TIME_FROM : isoDaysAgo(Number(p)))
  }

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('reports.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('reports.subtitle')}
          </p>
          <p
            className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="reports-live"
            aria-live="polite"
          >
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-success" />
            </span>
            {live.lastUpdated
              ? t('reports.live_updated', { time: fmt.time(live.lastUpdated.toISOString()) })
              : t('reports.live')}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/reports/csat"
            className="inline-block text-sm text-foreground hover:underline"
          >
            {t('reports.csat_link')} →
          </Link>
          <Link
            href="/reports/sla"
            className="inline-block text-sm text-foreground hover:underline"
            data-testid="sla-misses-report-link"
          >
            {t('reports.sla_misses_link')} →
          </Link>
          <Link
            href="/inbox"
            className="inline-block text-sm text-muted-foreground hover:underline"
          >
            ← {t('inbox.title')}
          </Link>
        </div>
      </header>

      {/* Filters */}
      <section className="rounded-lg border border-border bg-card p-4 flex flex-wrap gap-4 items-end">
        <div className="flex flex-col">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('reports.from')}
          </label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1"
            data-testid="filter-from"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('reports.to')}
          </label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1"
            data-testid="filter-to"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('reports.inbox')}
          </label>
          <Select
            value={inboxId === '' ? ALL : inboxId}
            onValueChange={(v) => setInboxId(v === ALL ? '' : v)}
          >
            <SelectTrigger className="h-8 text-sm" data-testid="filter-inbox" aria-label={t('reports.inbox')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('reports.all')}</SelectItem>
              {inboxes.map((ib) => (
                <SelectItem key={ib.id} value={ib.id}>
                  {ib.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('reports.team')}
          </label>
          <Select
            value={teamId === '' ? ALL : teamId}
            onValueChange={(v) => setTeamId(v === ALL ? '' : v)}
          >
            <SelectTrigger className="h-8 text-sm" data-testid="filter-team" aria-label={t('reports.team')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('reports.all')}</SelectItem>
              {teams.map((tm) => (
                <SelectItem key={tm.id} value={tm.id}>
                  {tm.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={() => applyPreset('7')}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {t('reports.range_7d')}
          </button>
          <button
            type="button"
            onClick={() => applyPreset('30')}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {t('reports.range_30d')}
          </button>
          <button
            type="button"
            onClick={() => applyPreset('90')}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {t('reports.range_90d')}
          </button>
          <button
            type="button"
            onClick={() => applyPreset('all')}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
            data-testid="range-all"
          >
            {t('reports.range_all')}
          </button>
        </div>
      </section>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {loading && !overview ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {overview ? (
        <>
          {/* KPI Cards */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              testId="kpi-total"
              label={t('reports.kpi_total')}
              value={overview.totalConversations.toString()}
            />
            <KpiCard
              testId="kpi-first-response"
              label={t('reports.kpi_avg_first_response')}
              value={formatDuration(overview.avgFirstResponseSeconds, dash)}
            />
            <KpiCard
              testId="kpi-resolved-rate"
              label={t('reports.kpi_resolved_rate')}
              value={
                resolvedRate === null
                  ? dash
                  : `${Math.round(resolvedRate * 100)}%`
              }
            />
            <KpiCard
              testId="kpi-ai-cost"
              label={t('reports.kpi_ai_cost')}
              value={`$${overview.ai.totalCostUsd.toFixed(2)}`}
            />
          </section>

          {/* Charts row */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-4 lg:col-span-2">
              <h2 className="text-sm font-semibold mb-3">
                {t('reports.timeseries_title')}
              </h2>
              {timeseries && timeseries.points.length > 0 ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={timeseries.points}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#6366f1" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('reports.no_data')}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3">
                {t('reports.sentiment_title')}
              </h2>
              {sentimentData.length > 0 ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={sentimentData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={40}
                        outerRadius={80}
                      >
                        {sentimentData.map((entry) => (
                          <Cell
                            key={entry.key}
                            fill={SENTIMENT_COLORS[entry.key]}
                          />
                        ))}
                      </Pie>
                      <Legend />
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('reports.no_data')}
                </p>
              )}
            </div>
          </section>

          {/* Tables row */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold mb-3">
                {t('reports.top_tags_title')}
              </h2>
              {overview.topTags.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('reports.tags_empty')}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {overview.topTags.map((tag) => (
                    <li
                      key={tag.tag}
                      className="flex items-center justify-between py-2 text-sm"
                    >
                      <span>{tag.tag}</span>
                      <span className="text-muted-foreground">{tag.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div
              className="rounded-lg border border-border bg-card p-4"
              data-testid="leaderboard"
            >
              <h2 className="text-sm font-semibold mb-3">
                {t('reports.leaderboard_title')}
              </h2>
              {leaderboard && leaderboard.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('reports.leaderboard_empty')}
                </p>
              ) : null}
              {leaderboard && leaderboard.entries.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2">{t('reports.leaderboard_agent')}</th>
                      <th className="py-2">
                        {t('reports.leaderboard_resolved')}
                      </th>
                      <th className="py-2">
                        {t('reports.leaderboard_first_response')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.entries.map((row) => (
                      <tr
                        key={row.userId}
                        className="border-t border-border"
                        data-testid={`lb-${row.userId}`}
                      >
                        <td className="py-2">
                          {row.userFullName ?? row.userEmail}
                        </td>
                        <td className="py-2">{row.resolvedCount}</td>
                        <td className="py-2 text-muted-foreground">
                          {formatDuration(row.avgFirstResponseSeconds, dash)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </section>

          {/* Breakdown by dimension */}
          <section
            className="rounded-lg border border-border bg-card p-4"
            data-testid="breakdown"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {t('reports.breakdown_title')}
              </h2>
              <div className="flex items-center gap-2">
                <Select
                  value={breakdownDim}
                  onValueChange={(v) => setBreakdownDim(v as BreakdownDimension)}
                >
                  <SelectTrigger
                    className="h-8 w-44 text-sm"
                    data-testid="breakdown-dimension"
                    aria-label={t('reports.breakdown_title')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbox">{t('reports.breakdown_by_inbox')}</SelectItem>
                    <SelectItem value="team">{t('reports.breakdown_by_team')}</SelectItem>
                    <SelectItem value="agent">{t('reports.breakdown_by_agent')}</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={downloadCsv}
                  disabled={
                    downloadingCsv || !breakdown || breakdown.rows.length === 0
                  }
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  data-testid="breakdown-download-csv"
                >
                  {t('reports.breakdown_download_csv')}
                </button>
              </div>
            </div>
            {breakdown && breakdown.rows.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{t('reports.breakdown_col_name')}</th>
                    <th className="py-2">{t('reports.breakdown_col_total')}</th>
                    <th className="py-2">{t('reports.breakdown_col_open')}</th>
                    <th className="py-2">
                      {t('reports.breakdown_col_pending')}
                    </th>
                    <th className="py-2">
                      {t('reports.breakdown_col_resolved')}
                    </th>
                    <th className="py-2">
                      {t('reports.breakdown_col_first_response')}
                    </th>
                    <th className="py-2">
                      {t('reports.breakdown_col_resolution')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.rows.map((row, i) => (
                    <tr
                      key={row.id ?? `null-${i}`}
                      className="border-t border-border"
                    >
                      <td className="py-2">{row.label}</td>
                      <td className="py-2">{row.total}</td>
                      <td className="py-2">{row.open}</td>
                      <td className="py-2">{row.pending}</td>
                      <td className="py-2">{row.resolved}</td>
                      <td className="py-2 text-muted-foreground">
                        {formatDuration(row.avgFirstResponseSeconds, dash)}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {formatDuration(row.avgResolutionSeconds, dash)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('reports.breakdown_empty')}
              </p>
            )}
          </section>

          {/* Messages by sender */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">
              {t('reports.messages_title')}
            </h2>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['CONTACT', 'USER', 'AGENT_BOT', 'SYSTEM'] as const).map(
                (key) => (
                  <div key={key}>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {t(`reports.sender_${key}`)}
                    </dt>
                    <dd className="text-foreground">
                      {overview.messagesBySender[key]}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          </section>
        </>
      ) : null}
    </div>
      </main>
  )
}

function KpiCard({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId?: string
}) {
  return (
    <div
      className="rounded-lg border border-border bg-card p-4"
      data-testid={testId}
    >
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  )
}
