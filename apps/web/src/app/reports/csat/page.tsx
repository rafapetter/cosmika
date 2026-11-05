'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import type { CsatStats, NpsBucket, NpsStats, SurveyType } from '@cosmika/shared'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { dayBoundary } from '../../../lib/day-boundary'
import { PageContainer, PageHeader } from '../../../components/page'
import { useLiveRefresh } from '../../../lib/use-live-refresh'
import { useStoredSession } from '../../../lib/session-store'

export default function CsatReportPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [stats, setStats] = React.useState<CsatStats | null>(null)
  const [nps, setNps] = React.useState<NpsStats | null>(null)
  const [surveyType, setSurveyType] = React.useState<SurveyType | null>(null)
  const [savedNote, setSavedNote] = React.useState<string | null>(null)
  const [fromDay, setFromDay] = React.useState('')
  const [toDay, setToDay] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const live = useLiveRefresh(session?.session.token ?? null)
  const isAdmin = session?.membership.role === 'ADMINISTRATOR'

  const period = React.useMemo(
    () => ({
      from: fromDay ? dayBoundary(fromDay) : undefined,
      to: toDay ? dayBoundary(toDay, true) : undefined,
    }),
    [fromDay, toDay],
  )

  React.useEffect(() => {
    if (!session) return
    api
      .getSurveySettings(session.session.token, session.account.id)
      .then((s) => setSurveyType(s.surveyType))
      .catch(() => setSurveyType(null))
  }, [session])

  React.useEffect(() => {
    if (!session) return
    const token = session.session.token
    const acct = session.account.id
    Promise.all([api.getCsatStats(token, acct, period), api.getNpsStats(token, acct, period)])
      .then(([c, n]) => {
        setStats(c)
        setNps(n)
        setError(null)
      })
      .catch((err) => setError(apiErrorText(t, err)))
  }, [session, t, period, live.tick])

  async function changeType(next: SurveyType) {
    if (!session) return
    try {
      const r = await api.updateSurveySettings(session.session.token, session.account.id, {
        surveyType: next,
      })
      setSurveyType(r.surveyType)
      setSavedNote(t('csatReport.survey_type_saved'))
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function downloadNpsCsv() {
    if (!session) return
    try {
      const csv = await api.getNpsCsv(session.session.token, session.account.id, period)
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `nps${fromDay || toDay ? `-${fromDay || 'inicio'}_${toDay || 'hoje'}` : ''}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader title={t('csatReport.title')} subtitle={t('csatReport.subtitle')} />

      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-3">
        <FormField
          label={t('csatReport.survey_type')}
          htmlFor="survey-type"
          hint={savedNote ?? t('csatReport.survey_type_hint')}
        >
          <Select
            value={surveyType ?? ''}
            onValueChange={(v) => void changeType(v as SurveyType)}
            disabled={!isAdmin || surveyType === null}
          >
            <SelectTrigger id="survey-type" data-testid="survey-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CSAT">{t('csatReport.survey_type_csat')}</SelectItem>
              <SelectItem value="NPS">{t('csatReport.survey_type_nps')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('dataExport.from')} htmlFor="sat-from">
          <Input
            id="sat-from"
            type="date"
            value={fromDay}
            max={toDay || undefined}
            onChange={(e) => setFromDay(e.target.value)}
          />
        </FormField>
        <FormField label={t('dataExport.to')} htmlFor="sat-to">
          <Input
            id="sat-to"
            type="date"
            value={toDay}
            min={fromDay || undefined}
            onChange={(e) => setToDay(e.target.value)}
          />
        </FormField>
      </div>

      {!stats || !nps ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <>
          <section className="space-y-4" data-testid="nps-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium">{t('csatReport.nps_section')}</h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void downloadNpsCsv()}
                disabled={nps.responses === 0}
                data-testid="nps-csv"
              >
                <Download className="size-4" aria-hidden />
                {t('csatReport.download_csv')}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label={t('csatReport.nps_score')} value={nps.nps ?? '-'} testId="nps-score" />
              <Stat label={t('csatReport.responses')} value={nps.responses} />
              <Stat label={t('csatReport.promoters')} value={nps.promoters} />
              <Stat label={t('csatReport.passives')} value={nps.passives} />
              <Stat label={t('csatReport.detractors')} value={nps.detractors} />
            </div>
            <p className="text-xs text-muted-foreground">{t('csatReport.nps_formula')}</p>
            {nps.responses === 0 ? (
              <p className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
                {t('csatReport.nps_empty')}
              </p>
            ) : (
              <div className="space-y-4">
                <NpsTable
                  title={t('csatReport.by_team')}
                  buckets={nps.byTeam}
                  none={t('csatReport.no_team')}
                  testId="nps-by-team"
                />
                <NpsTable
                  title={t('csatReport.by_operator')}
                  buckets={nps.byAgent}
                  none={t('csatReport.no_agent')}
                  testId="nps-by-agent"
                />
              </div>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-medium">{t('csatReport.csat_section')}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label={t('csatReport.surveys_sent')} value={stats.totalPrompted} />
              <Stat label={t('csatReport.responses')} value={stats.totalResponded} />
              <Stat
                label={t('csatReport.average_rating')}
                value={stats.averageRating !== null ? stats.averageRating.toFixed(2) : '-'}
                suffix={stats.averageRating !== null ? '/5' : undefined}
              />
            </div>

            <BucketTable title={t('csatReport.by_inbox')} buckets={stats.byInbox} />
            <BucketTable title={t('csatReport.by_agent')} buckets={stats.byAgent} />

            {stats.totalPrompted === 0 ? (
              <p className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground">
                {t('csatReport.empty')}
              </p>
            ) : null}
          </section>
        </>
      )}
    </PageContainer>
  )
}

function Stat({
  label,
  value,
  suffix,
  testId,
}: {
  label: string
  value: string | number
  suffix?: string
  testId?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
        {suffix ? <span className="ml-1 text-sm text-muted-foreground">{suffix}</span> : null}
      </p>
    </div>
  )
}

function NpsTable({
  title,
  buckets,
  none,
  testId,
}: {
  title: string
  buckets: NpsBucket[]
  none: string
  testId: string
}) {
  const t = useTranslations()
  return (
    <div className="rounded-lg border border-border bg-card" data-testid={testId}>
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{title}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('csatReport.col_name')}</TableHead>
            <TableHead className="text-right">{t('csatReport.col_responses')}</TableHead>
            <TableHead className="text-right">{t('csatReport.promoters')}</TableHead>
            <TableHead className="text-right">{t('csatReport.detractors')}</TableHead>
            <TableHead className="text-right">{t('csatReport.col_nps')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buckets.map((b) => (
            <TableRow key={b.key}>
              <TableCell>{b.label || <span className="text-muted-foreground">{none}</span>}</TableCell>
              <TableCell className="text-right tabular-nums">{b.responses}</TableCell>
              <TableCell className="text-right tabular-nums">{b.promoters}</TableCell>
              <TableCell className="text-right tabular-nums">{b.detractors}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{b.nps ?? '-'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function BucketTable({
  title,
  buckets,
}: {
  title: string
  buckets: { key: string; label: string; responses: number; averageRating: number | null }[]
}) {
  const t = useTranslations()
  if (buckets.length === 0) return null
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{title}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('csatReport.col_name')}</TableHead>
            <TableHead className="text-right">{t('csatReport.col_responses')}</TableHead>
            <TableHead className="text-right">{t('csatReport.col_avg')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buckets
            .slice()
            .sort((a, b) => (b.averageRating ?? 0) - (a.averageRating ?? 0))
            .map((b) => (
              <TableRow key={b.key}>
                <TableCell>{b.label}</TableCell>
                <TableCell className="text-right tabular-nums">{b.responses}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {b.averageRating !== null ? b.averageRating.toFixed(2) : '-'}
                </TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  )
}
