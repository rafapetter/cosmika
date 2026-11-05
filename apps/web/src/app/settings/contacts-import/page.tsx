'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { ContactImportResult } from '@cosmika/shared'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

type ParsedRow = {
  name?: string
  email?: string
  phoneNumber?: string
  identifier?: string
  customAttributes?: Record<string, string>
}

const STANDARD_FIELDS = ['name', 'email', 'phoneNumber', 'identifier']

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  // Minimal CSV: split on newlines, then on commas. Handles double-quoted fields
  // (no escaping of quotes inside quotes — keep it simple). Trims fields.
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const splitLine = (l: string) => {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < l.length; i += 1) {
      const ch = l[i]
      if (ch === '"') {
        inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur.trim())
    return out
  }
  const headersLine = lines[0]
  if (!headersLine) return { headers: [], rows: [] }
  const headers = splitLine(headersLine)
  const rows = lines.slice(1).map(splitLine)
  return { headers, rows }
}

export default function ContactImportPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [text, setText] = React.useState('')
  const [parsed, setParsed] = React.useState<{
    headers: string[]
    rows: string[][]
  } | null>(null)
  const [mapping, setMapping] = React.useState<Record<string, string>>({})
  const [result, setResult] = React.useState<ContactImportResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  function onParse() {
    setError(null)
    setResult(null)
    const p = parseCSV(text)
    if (p.headers.length === 0) {
      setError(t('contactsImport.no_headers'))
      return
    }
    setParsed(p)
    // Try auto-mapping by header name.
    const auto: Record<string, string> = {}
    p.headers.forEach((h) => {
      const lo = h.toLowerCase()
      if (lo === 'name' || lo === 'full_name' || lo === 'fullname')
        auto[h] = 'name'
      else if (lo === 'email' || lo === 'e-mail') auto[h] = 'email'
      else if (lo === 'phone' || lo === 'phone_number' || lo === 'phonenumber')
        auto[h] = 'phoneNumber'
      else if (lo === 'identifier' || lo === 'id') auto[h] = 'identifier'
      else auto[h] = '__skip__'
    })
    setMapping(auto)
  }

  async function onImport() {
    if (!session || !parsed) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const rows: ParsedRow[] = parsed.rows.map((cells) => {
        const row: ParsedRow = {}
        parsed.headers.forEach((h, i) => {
          const dest = mapping[h]
          if (!dest || dest === '__skip__') return
          const value = cells[i] ?? ''
          if (!value) return
          if (STANDARD_FIELDS.includes(dest)) {
            ;(row as Record<string, string>)[dest] = value
          } else {
            row.customAttributes = row.customAttributes ?? {}
            row.customAttributes[dest] = value
          }
        })
        return row
      })
      const r = await api.importContacts(
        session.session.token,
        session.account.id,
        { rows },
      )
      setResult(r)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('contactsImport.title')}
        subtitle={t('contactsImport.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            {t('contactsImport.paste_label')}
          </label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const t = await f.text()
              setText(t)
            }}
            className="text-xs"
            data-testid="csv-file"
          />
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={t('contactsImport.csv_placeholder')}
          className="resize-y font-mono text-xs"
          aria-label={t('contactsImport.csv_aria')}
        />
        <div className="flex justify-end">
          <Button onClick={onParse} variant="outline" disabled={!text.trim()}>
            {t('contactsImport.parse')}
          </Button>
        </div>
      </div>

      {parsed ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {t('contactsImport.map_columns', { rows: parsed.rows.length })}
            </h2>
            <Button
              onClick={onImport}
              variant="primary"
              disabled={submitting || parsed.rows.length === 0}
            >
              {submitting
                ? t('contactsImport.importing')
                : t('contactsImport.import_rows', { rows: parsed.rows.length })}
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {parsed.headers.map((h) => (
              <label key={h} className="flex items-center gap-2">
                <span className="w-32 truncate text-xs font-mono">{h}</span>
                <Select
                  value={mapping[h] ?? '__skip__'}
                  onValueChange={(v) =>
                    setMapping((prev) => ({ ...prev, [h]: v }))
                  }
                >
                  <SelectTrigger
                    className="h-8 flex-1 text-xs"
                    aria-label={t('contactsImport.map_column', { name: h })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__skip__">{t('contactsImport.skip')}</SelectItem>
                    <SelectItem value="name">{t('contactsImport.field_name')}</SelectItem>
                    <SelectItem value="email">{t('contactsImport.field_email')}</SelectItem>
                    <SelectItem value="phoneNumber">{t('contactsImport.field_phone')}</SelectItem>
                    <SelectItem value="identifier">{t('contactsImport.field_identifier')}</SelectItem>
                    <SelectItem
                      value={h.toLowerCase().replace(/[^a-z0-9]+/g, '_')}
                    >
                      {t('contactsImport.field_custom', {
                        key: h.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
                      })}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
          <p className="text-sm font-medium">{t('contactsImport.complete')}</p>
          <ul className="mt-2 space-y-1 text-xs">
            <li>{t('contactsImport.created', { n: result.created })}</li>
            <li>{t('contactsImport.updated', { n: result.updated })}</li>
            <li>{t('contactsImport.skipped', { n: result.skipped })}</li>
          </ul>
          {result.errors.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t('contactsImport.errors', { n: result.errors.length })}
              </summary>
              <ul className="mt-1 space-y-0.5 text-xs">
                {result.errors.map((e, i) => (
                  <li key={i}>
                    {e.code === 'duplicate'
                      ? t('contactsImport.row_duplicate', { row: e.row })
                      : t('contactsImport.row_failed', { row: e.row })}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </PageContainer>
  )
}
