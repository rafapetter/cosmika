'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { CannedResponseDTO } from '@cosmika/shared'
import { Button, Input, Textarea } from '@cosmika/ui'

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { PageContainer, PageHeader } from '../../components/page'
import { useStoredSession } from '../../lib/session-store'

export default function CannedResponsesPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<CannedResponseDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listCannedResponses(
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

  async function onCreate(shortcode: string, content: string) {
    if (!session) return
    try {
      await api.createCannedResponse(session.session.token, session.account.id, {
        shortcode,
        content,
      })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onDelete(id: string) {
    if (!session) return
    if (!confirm(t('cannedResponses.delete_confirm'))) return
    await api.deleteCannedResponse(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('cannedResponses.title')}
        subtitle={t('cannedResponses.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <CreateForm onCreate={onCreate} />

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('cannedResponses.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-primary">/{c.shortcode}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                  {c.content}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(c.id)}
                data-testid={`delete-${c.id}`}
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

function CreateForm({
  onCreate,
}: {
  onCreate: (shortcode: string, content: string) => Promise<void>
}) {
  const t = useTranslations()
  const [shortcode, setShortcode] = React.useState('')
  const [content, setContent] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!shortcode.trim() || !content.trim()) return
    setSubmitting(true)
    try {
      await onCreate(shortcode.trim(), content.trim())
      setShortcode('')
      setContent('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-lg border border-border bg-card p-4"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr]">
        <Input
          value={shortcode}
          onChange={(e) => setShortcode(e.target.value)}
          placeholder={t('cannedResponses.shortcode_placeholder')}
          aria-label={t('cannedResponses.shortcode')}
          className="font-mono"
        />
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('cannedResponses.content_placeholder')}
          aria-label={t('cannedResponses.content')}
          rows={2}
          className="min-h-0 resize-none"
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !shortcode.trim() || !content.trim()}
        >
          {t('cannedResponses.save')}
        </Button>
      </div>
    </form>
  )
}
