'use client'

import * as React from 'react'
import { ChevronRight, Check, AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cosmika/ui'

import { useDateTime } from '../../lib/format-datetime'


import {
  columnsOf,
  findStats,
  findTable,
  formatValue,
  kindOf,
} from './format'
import { keyLabel, toolLabel, valueLabel } from './labels'

/**
 * What the assistant looked at, rendered by shape rather than by tool name.
 *
 * The prose answer stays the primary thing; this is the evidence behind it,
 * collapsed by default. An operator who doubts a number can open one panel and
 * see the rows the model actually read, which is the difference between
 * trusting the assistant and verifying it.
 */
export function ToolResults({
  calls,
  label,
}: {
  calls: Array<{ toolName: string; critical: boolean; output?: unknown }>
  label: (n: number) => string
}) {
  const t = useTranslations()
  const [openTool, setOpenTool] = React.useState<string | null>(null)
  if (calls.length === 0) return null

  return (
    <div className="min-w-0 space-y-1.5" data-testid="tool-results">
      <p className="text-[11px] text-muted-foreground">{label(calls.length)}</p>
      <div className="flex flex-wrap gap-1.5">
        {calls.map((c) => {
          const open = openTool === c.toolName
          const hasData = c.output !== undefined && c.output !== null
          return (
            <button
              key={c.toolName}
              type="button"
              disabled={!hasData}
              onClick={() => setOpenTool(open ? null : c.toolName)}
              data-testid={`tool-chip-${c.toolName}`}
              aria-expanded={open}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                open
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground'
              } ${hasData ? 'hover:bg-subtle/60 hover:text-foreground' : 'opacity-60'}`}
            >
              {hasData ? (
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
                />
              ) : (
                <Check className="h-3 w-3" />
              )}
              {toolLabel(t, c.toolName)}
            </button>
          )
        })}
      </div>
      {openTool
        ? calls
            .filter((c) => c.toolName === openTool && c.output !== undefined)
            .map((c) => <ResultPanel key={c.toolName} output={c.output} />)
        : null}
    </div>
  )
}

export function ResultPanel({ output }: { output: unknown }) {
  const t = useTranslations()
  const error = errorOf(output)
  if (error) {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
        data-testid="result-error"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  const table = findTable(output)
  const stats = findStats(output)

  if (!table && stats.length === 0) {
    return (
      <pre
        className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2.5 font-mono text-[11px]"
        data-testid="result-raw"
      >
        {JSON.stringify(output, null, 2)}
      </pre>
    )
  }

  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border bg-muted/20 p-2.5">
      {stats.length > 0 ? <StatGrid stats={stats} /> : null}
      {table ? <DataTable rows={table.rows} caption={keyLabel(t, table.key)} /> : null}
    </div>
  )
}

function errorOf(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null
  const e = (output as Record<string, unknown>).error
  return typeof e === 'string' ? e : null
}

function StatGrid({ stats }: { stats: Array<{ key: string; value: unknown }> }) {
  const t = useTranslations()
  return (
    <dl
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
      data-testid="stat-grid"
    >
      {stats.map((s) => (
        <div key={s.key} className="rounded-md border border-border bg-background px-2.5 py-1.5">
          <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
            {keyLabel(t, s.key)}
          </dt>
          <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">
            <Value name={s.key} value={s.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({
  rows,
  caption,
}: {
  rows: Array<Record<string, unknown>>
  caption: string
}) {
  const t = useTranslations()
  const MAX_ROWS = 25
  const cols = columnsOf(rows)
  const shown = rows.slice(0, MAX_ROWS)
  return (
    <div className="min-w-0" data-testid="data-table">
      <p className="pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {caption} · {rows.length}
      </p>
      {/* Table owns its own overflow wrapper, so the page never scrolls
          sideways — the bug this replaced had to be fixed by hand. */}
      <Table className="text-[11px]">
        <TableHeader>
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c} className="h-auto whitespace-nowrap px-2 py-1">
                {keyLabel(t, c)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, i) => (
            <TableRow key={i}>
              {cols.map((c) => (
                <TableCell key={c} className="px-2 py-1 align-top">
                  <Value name={c} value={row[c]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > MAX_ROWS ? (
        // Never let a truncated table read as the whole set.
        <p className="pt-1 text-[10px] text-muted-foreground">
          {t('assistant.showing_rows', { shown: MAX_ROWS, total: rows.length })}
        </p>
      ) : null}
    </div>
  )
}

/** One cell or tile, styled by what the value actually is. */
export function Value({ name, value }: { name: string; value: unknown }) {
  const t = useTranslations()
  const fmt = useDateTime()
  const kind = kindOf(name, value)
  const text =
    kind === 'boolean'
      ? value
        ? t('common.yes')
        : t('common.no')
      : kind === 'enum'
        ? valueLabel(t, String(value))
        : formatValue(name, value, fmt)

  if (kind === 'boolean') {
    return (
      <span
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
          value
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {text}
      </span>
    )
  }
  if (kind === 'enum') {
    return (
      <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[10px]">
        {text}
      </span>
    )
  }
  if (kind === 'id') {
    return <span className="font-mono text-[10px] text-muted-foreground">{text}</span>
  }
  if (kind === 'empty') return <span className="text-muted-foreground">-</span>
  if (kind === 'money' || kind === 'count' || kind === 'percent') {
    return <span className="tabular-nums">{text}</span>
  }
  return <span className="break-words">{text}</span>
}
