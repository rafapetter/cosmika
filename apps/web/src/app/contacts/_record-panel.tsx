'use client'

import Link from 'next/link'
import { Link2, Mail, Phone, User, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ContactDTO } from '@cosmika/shared'
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Input,
  Switch,
  avatarColor,
  initialsOf,
} from '@cosmika/ui'

import { useDateTime } from '../../lib/format-datetime'

const FIELDS = [
  { key: 'name', labelKey: 'contacts.column_name', icon: <User className="size-3.5" /> },
  { key: 'email', labelKey: 'contacts.column_email', icon: <Mail className="size-3.5" /> },
  { key: 'phoneNumber', labelKey: 'contacts.column_phone', icon: <Phone className="size-3.5" /> },
  { key: 'identifier', labelKey: 'contacts.column_source', icon: <Link2 className="size-3.5" /> },
] as const

/**
 * Twenty-style record side panel: every field edits in place, so triage
 * never has to leave the list. The page owns persistence (the same
 * optimistic saveCell the grid uses); the panel owns only which field is
 * being edited.
 */
export function ContactRecordPanel({
  contact,
  canMutate,
  busy,
  onClose,
  onSaveField,
  onToggleBlocked,
}: {
  contact: ContactDTO
  canMutate: boolean
  busy: boolean
  onClose: () => void
  onSaveField: (contact: ContactDTO, field: string, value: string) => void
  onToggleBlocked: (contact: ContactDTO) => void
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const [editingField, setEditingField] = useState<string | null>(null)

  const display =
    [contact.name, contact.email, contact.phoneNumber, contact.identifier].find(
      (v) => v != null && v.trim() !== '',
    ) ?? contact.id

  return (
    <aside
      className="flex w-[340px] shrink-0 flex-col border-l border-border bg-background"
      data-testid="record-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="text-[11px]" style={avatarColor(display)}>
            {initialsOf(display)}
          </AvatarFallback>
        </Avatar>
        <span className="flex-1 truncate text-sm font-medium">{display}</span>
        {contact.blockedAt ? (
          <Badge variant="destructive">{t('contacts.bulk_block')}</Badge>
        ) : null}
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
        {FIELDS.map((f) => {
          const raw = (contact as unknown as Record<string, string | null>)[f.key]
          const isEditing = editingField === f.key
          return (
            <div
              key={f.key}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
            >
              <span className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {f.icon}
                {t(f.labelKey)}
              </span>
              {isEditing ? (
                <Input
                  autoFocus
                  defaultValue={raw ?? ''}
                  disabled={busy}
                  className="h-7 text-sm"
                  aria-label={t(f.labelKey)}
                  data-testid={`panel-edit-${f.key}`}
                  onBlur={(e) => {
                    setEditingField(null)
                    onSaveField(contact, f.key, e.target.value)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditingField(null)
                  }}
                />
              ) : (
                <button
                  type="button"
                  disabled={!canMutate}
                  onClick={() => setEditingField(f.key)}
                  className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  title={canMutate ? t('contacts.edit_hint') : undefined}
                  data-testid={`panel-field-${f.key}`}
                >
                  {raw?.trim() ? (
                    raw
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </button>
              )}
            </div>
          )
        })}

        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <span className="w-28 shrink-0 text-xs text-muted-foreground">
            {t('contacts.panel_blocked')}
          </span>
          <Switch
            checked={contact.blockedAt !== null}
            disabled={!canMutate || busy}
            onCheckedChange={() => onToggleBlocked(contact)}
            aria-label={t('contacts.panel_blocked')}
            data-testid="panel-blocked"
          />
        </div>

        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <span className="w-28 shrink-0 text-xs text-muted-foreground">
            {t('contacts.panel_created')}
          </span>
          <span className="text-sm text-muted-foreground">
            {fmt.date(contact.createdAt)}
          </span>
        </div>
      </div>

      <div className="border-t border-border p-3">
        <Link
          href={`/contacts/${contact.id}`}
          className="text-sm text-primary hover:underline"
          data-testid="panel-open-full"
        >
          {t('contacts.panel_open_full')} →
        </Link>
      </div>
    </aside>
  )
}
