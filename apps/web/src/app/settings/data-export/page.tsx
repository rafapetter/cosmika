'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import type { DataExportFormat, DataExportKind } from '@cosmika/shared'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  Input,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { dayBoundary } from '../../../lib/day-boundary'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const KINDS: Array<{ kind: DataExportKind; title: string; hint: string; file: string }> = [
  { kind: 'contacts', title: 'dataExport.contacts_title', hint: 'dataExport.contacts_hint', file: 'contatos' },
  {
    kind: 'conversations',
    title: 'dataExport.conversations_title',
    hint: 'dataExport.conversations_hint',
    file: 'conversas',
  },
]

export default function DataExportPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [fromDay, setFromDay] = React.useState('')
  const [toDay, setToDay] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  async function download(kind: DataExportKind, file: string, format: DataExportFormat) {
    if (!session) return
    setBusy(`${kind}.${format}`)
    setError(null)
    setDone(null)
    try {
      const url = await api.createDataExportLink(session.session.token, session.account.id, kind, {
        format,
        from: fromDay ? dayBoundary(fromDay) : undefined,
        to: toDay ? dayBoundary(toDay, true) : undefined,
      })
      // The response is an attachment: the browser saves it, the page stays.
      window.location.assign(url)
      setDone(`${file}.${format}`)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(null)
    }
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader title={t('dataExport.title')} subtitle={t('dataExport.subtitle')} />

      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-md bg-subtle px-3 py-2 text-xs text-muted-foreground">
          {t('dataExport.done', { file: done })}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('dataExport.period')}</CardTitle>
          <CardDescription>{t('dataExport.period_hint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('dataExport.from')} htmlFor="export-from">
            <Input
              id="export-from"
              type="date"
              value={fromDay}
              max={toDay || undefined}
              onChange={(e) => setFromDay(e.target.value)}
            />
          </FormField>
          <FormField label={t('dataExport.to')} htmlFor="export-to">
            <Input
              id="export-to"
              type="date"
              value={toDay}
              min={fromDay || undefined}
              onChange={(e) => setToDay(e.target.value)}
            />
          </FormField>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {KINDS.map(({ kind, title, hint, file }) => (
          <Card key={kind} data-testid={`export-${kind}`}>
            <CardHeader>
              <CardTitle className="text-sm font-medium">{t(title as never)}</CardTitle>
              <CardDescription>{t(hint as never)}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {(['csv', 'json'] as const).map((format) => (
                <Button
                  key={format}
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void download(kind, file, format)}
                  data-testid={`export-${kind}-${format}`}
                >
                  <Download className="size-4" aria-hidden />
                  {busy === `${kind}.${format}`
                    ? t('dataExport.downloading')
                    : t(format === 'csv' ? 'dataExport.download_csv' : 'dataExport.download_json')}
                </Button>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t('dataExport.audit_note')}</p>
    </PageContainer>
  )
}
