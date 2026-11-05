'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Bot, Check, X } from 'lucide-react'
import { Badge, Button, cn } from '@cosmika/ui'
import type {
  AgentToolCallDTO,
  AiAgentSessionDTO,
} from '@cosmika/shared'

import { useDateTime, type DateTimeTools } from '../../../lib/format-datetime'

/**
 * Compact AI panel shown in the conversation sidebar.
 *
 * Surfaces:
 *   - session totals (cost, tokens, last-active)
 *   - last 5 tool calls with status pill
 *   - approve / reject buttons when there are PENDING destructive calls
 */
/** Human-readable name for a tool, falling back to the raw name. */
function toolLabel(t: ReturnType<typeof useTranslations>, name: string): string {
  const key = `ai.tool_${name}`
  const label = t(key)
  return label === key ? name : label
}

/** The first meaningful string the agent passed, if any. */
function toolReason(input: Record<string, unknown>): string | null {
  for (const key of ['reason', 'query', 'tag', 'note', 'priority']) {
    const v = input?.[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

export function AiPanel({
  session,
  toolCalls,
  onConfirm,
  onReject,
  confirming,
}: {
  session: AiAgentSessionDTO | null
  toolCalls: AgentToolCallDTO[]
  onConfirm: (ids: string[]) => Promise<void> | void
  onReject: (ids: string[]) => Promise<void> | void
  confirming: boolean
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const pending = toolCalls.filter((c) => c.status === 'PENDING')
  if (!session && toolCalls.length === 0) return null

  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Bot className="h-3 w-3" /> {t('ai.panel_title')}
      </h3>

      {session ? (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label={t('ai.cost_short')} value={`$${session.totalCostUsd.toFixed(4)}`} />
          <Stat
            label={t('ai.tokens_short')}
            value={`${session.totalTokensIn + session.totalTokensOut}`}
          />
          <Stat
            label={t('ai.last_active_short')}
            value={formatRel(session.lastActiveAt, fmt, t)}
            className="col-span-2"
          />
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 p-2.5">
          <p className="text-xs font-medium text-foreground">
            {t('ai.pending_actions_waiting', { count: pending.length })}
          </p>
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {pending.slice(0, 3).map((c) => (
              <li key={c.id}>
                <span className="text-foreground">{toolLabel(t, c.toolName)}</span>
                {/* The agent's own rationale — far more useful to whoever
                    approves than the tool's internal name ever was. */}
                {toolReason(c.input) ? (
                  <span className="block truncate">{toolReason(c.input)}</span>
                ) : null}
              </li>
            ))}
            {pending.length > 3 ? (
              <li className="text-muted-foreground/70">
                {t('ai.more_actions', { count: pending.length - 3 })}
              </li>
            ) : null}
          </ul>
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="primary"
              className="h-7 flex-1 text-xs"
              onClick={() => onConfirm(pending.map((c) => c.id))}
              disabled={confirming}
              data-testid="approve-tool-calls"
            >
              <Check className="h-3 w-3" /> {t('ai.approve_pending')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 flex-1 text-xs"
              onClick={() => onReject(pending.map((c) => c.id))}
              disabled={confirming}
              data-testid="reject-tool-calls"
            >
              <X className="h-3 w-3" /> {t('ai.reject_pending')}
            </Button>
          </div>
        </div>
      ) : null}

      {toolCalls.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {toolCalls.slice(0, 5).map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-[11px]">
                {toolLabel(t, c.toolName)}
              </span>
              <Badge variant={statusVariant(c.status)} className="text-[10px]">
                {t(`ai.status_${c.status.toLowerCase()}` as never)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className={cn('rounded-md bg-muted/50 px-2 py-1.5', className)}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-foreground">{value}</p>
    </div>
  )
}

function statusVariant(status: AgentToolCallDTO['status']) {
  switch (status) {
    case 'SUCCESS':
      return 'success' as const
    case 'CONFIRMED':
      return 'success' as const
    case 'PENDING':
      return 'pending' as const
    case 'REJECTED':
      return 'destructive' as const
    case 'ERROR':
      return 'destructive' as const
    default:
      return 'default' as const
  }
}

function formatRel(
  iso: string,
  fmt: DateTimeTools,
  t: ReturnType<typeof useTranslations>,
) {
  const d = new Date(iso)
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return t('conversations.time_just_now')
  if (diff < 3600)
    return t('conversations.time_minutes_ago', { m: Math.floor(diff / 60) })
  if (diff < 86400)
    return t('conversations.time_hours_ago', { h: Math.floor(diff / 3600) })
  return fmt.dateShort(d)
}
