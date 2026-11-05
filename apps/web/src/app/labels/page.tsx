'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { LabelDTO } from '@cosmika/shared'
import { Badge, Button, Input } from '@cosmika/ui'

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { PageContainer, PageHeader } from '../../components/page'
import { useStoredSession } from '../../lib/session-store'

const SUGGESTED_COLORS = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#84cc16', // lime
  '#ec4899', // pink
]

export default function LabelsPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<LabelDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listLabels(
        session.session.token,
        session.account.id,
      )
      setItems(r)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  async function onCreate(title: string, color: string) {
    if (!session) return
    try {
      await api.createLabel(session.session.token, session.account.id, {
        title,
        color,
      })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onDelete(id: string) {
    if (!session) return
    if (!confirm(t('labels.delete_confirm'))) return
    await api.deleteLabel(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('labels.title')}
        subtitle={t('labels.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <CreateLabelForm onCreate={onCreate} />

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('labels.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between gap-3 p-3"
            >
              <Badge
                style={{
                  backgroundColor: `${l.color}22`,
                  color: l.color,
                  borderColor: `${l.color}55`,
                }}
                className="border"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.title}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(l.id)}
                data-testid={`delete-${l.id}`}
              >
                {t('common.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function CreateLabelForm({
  onCreate,
}: {
  onCreate: (title: string, color: string) => Promise<void>
}) {
  const t = useTranslations()
  const [title, setTitle] = React.useState('')
  const [color, setColor] = React.useState(SUGGESTED_COLORS[0]!)
  const [submitting, setSubmitting] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSubmitting(true)
    try {
      await onCreate(title.trim(), color)
      setTitle('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('labels.title_placeholder')}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !title.trim()}
        >
          {t('labels.save')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTED_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={
              'h-7 w-7 rounded-full border-2 transition-all ' +
              (color === c
                ? 'border-foreground scale-110'
                : 'border-transparent hover:scale-105')
            }
            style={{ backgroundColor: c }}
            aria-label={t('labels.pick_color', { color: c })}
          />
        ))}
      </div>
    </form>
  )
}
