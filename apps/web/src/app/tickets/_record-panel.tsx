'use client'

import Link from 'next/link'
import { CalendarDays, Flag, Loader2, MessageSquare, Tag, User, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { SupportTicketDTO } from '@cosmika/shared'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { useDateTime } from '../../lib/format-datetime'

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

/**
 * Twenty-style record side panel for tickets: triage (status, priority,
 * category) happens in place; the conversation stays one click away. The
 * page owns persistence via the same optimistic saveCell the grid uses.
 */
export function TicketRecordPanel({
  ticket,
  canMutate,
  busy,
  onClose,
  onSaveField,
}: {
  ticket: SupportTicketDTO
  canMutate: boolean
  busy: boolean
  onClose: () => void
  onSaveField: (ticket: SupportTicketDTO, field: string, value: string) => void
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const [editingCategory, setEditingCategory] = useState(false)

  const row = (icon: React.ReactNode, label: string, value: React.ReactNode) => (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
      <span className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="min-w-0 flex-1">{value}</div>
    </div>
  )

  return (
    <aside
      className="flex w-[340px] shrink-0 flex-col border-l border-border bg-background"
      data-testid="record-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground">
          #{ticket.number}
        </span>
        <span className="flex-1 truncate text-sm font-medium">{ticket.subject}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1.5 text-muted-foreground"
          aria-label={t('common.cancel')}
          onClick={onClose}
          data-testid="record-panel-close"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {row(
          <Loader2 className="size-3.5" />,
          t('tickets.column_status'),
          <Select
            value={ticket.status}
            disabled={!canMutate || busy}
            onValueChange={(v) => onSaveField(ticket, 'status', v)}
          >
            <SelectTrigger
              className="h-7 w-36 text-xs"
              aria-label={t('tickets.column_status')}
              data-testid="panel-status"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`tickets.status_${v.toLowerCase()}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}

        {row(
          <Flag className="size-3.5" />,
          t('tickets.column_priority'),
          <Select
            value={ticket.priority}
            disabled={!canMutate || busy}
            onValueChange={(v) => onSaveField(ticket, 'priority', v)}
          >
            <SelectTrigger
              className="h-7 w-36 text-xs"
              aria-label={t('tickets.column_priority')}
              data-testid="panel-priority"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`tickets.priority_${v.toLowerCase()}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}

        {row(
          <Tag className="size-3.5" />,
          t('tickets.column_category'),
          editingCategory ? (
            <Input
              autoFocus
              defaultValue={ticket.category ?? ''}
              disabled={busy}
              className="h-7 text-sm"
              aria-label={t('tickets.column_category')}
              data-testid="panel-edit-category"
              onBlur={(e) => {
                setEditingCategory(false)
                onSaveField(ticket, 'category', e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setEditingCategory(false)
              }}
            />
          ) : (
            <button
              type="button"
              disabled={!canMutate}
              onClick={() => setEditingCategory(true)}
              className="min-w-0 max-w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
              title={canMutate ? t('tickets.edit_hint') : undefined}
              data-testid="panel-field-category"
            >
              {ticket.category?.trim() ? (
                ticket.category
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </button>
          ),
        )}

        {row(
          <User className="size-3.5" />,
          t('tickets.column_contact'),
          <span className="text-sm">
            {ticket.contactName ?? <span className="text-muted-foreground">-</span>}
          </span>,
        )}

        {row(
          <CalendarDays className="size-3.5" />,
          t('tickets.column_created'),
          <span className="text-sm text-muted-foreground">
            {fmt.date(ticket.createdAt)}
          </span>,
        )}

        <div className="px-2 pt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t('tickets.column_description')}
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-sm">
            {ticket.description || '-'}
          </p>
        </div>
      </div>

      {ticket.conversationId ? (
        <div className="border-t border-border p-3">
          <Link
            href={`/conversations/${ticket.conversationId}`}
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            data-testid="panel-open-conversation"
          >
            <MessageSquare className="size-3.5" />
            {t('tickets.open_conversation')}
          </Link>
        </div>
      ) : null}
    </aside>
  )
}
