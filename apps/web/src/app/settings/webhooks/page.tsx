'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type {
  WebhookDTO,
  WebhookDeliveryDTO,
  WebhookEvent,
  WebhookWithSecret,
} from '@cosmika/shared'
import {
  Button,
  Checkbox,
  Input,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useDateTime } from '../../../lib/format-datetime'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const EVENT_OPTIONS: WebhookEvent[] = [
  'conversation.created',
  'conversation.resolved',
  'conversation.reopened',
  'message.created',
  'contact.created',
  'conversation.sla_breached',
]

export default function WebhooksPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<WebhookDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState<WebhookWithSecret | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listWebhooks(session.session.token, session.account.id)
      setItems(r)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  async function onCreate(name: string, url: string, events: WebhookEvent[]) {
    if (!session) return
    try {
      const created = await api.createWebhook(
        session.session.token,
        session.account.id,
        { name, url, events },
      )
      setRevealed(created)
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onToggle(wh: WebhookDTO) {
    if (!session) return
    await api.updateWebhook(session.session.token, session.account.id, wh.id, {
      isActive: !wh.isActive,
    })
    await reload()
  }

  async function onDelete(id: string) {
    if (!session) return
    if (!confirm(t('webhooks.delete_confirm'))) return
    await api.deleteWebhook(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {revealed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium">{t('webhooks.created_title')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('webhooks.created_hint')}
          </p>
          <code className="mt-2 block break-all rounded bg-background px-2 py-1 font-mono text-xs">
            {revealed.secret}
          </code>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => setRevealed(null)}
          >
            {t('webhooks.dismiss')}
          </Button>
        </div>
      ) : null}

      <CreateForm onCreate={onCreate} />

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('webhooks.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((w) => (
            <WebhookRow
              key={w.id}
              webhook={w}
              onToggle={() => onToggle(w)}
              onDelete={() => onDelete(w.id)}
            />
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function WebhookRow({
  webhook,
  onToggle,
  onDelete,
}: {
  webhook: WebhookDTO
  onToggle: () => Promise<void> | void
  onDelete: () => Promise<void> | void
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [expanded, setExpanded] = React.useState(false)
  const [deliveries, setDeliveries] = React.useState<WebhookDeliveryDTO[] | null>(
    null,
  )
  const [loading, setLoading] = React.useState(false)
  const [retrying, setRetrying] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    setLoading(true)
    try {
      const list = await api.listWebhookDeliveries(
        session.session.token,
        session.account.id,
        webhook.id,
      )
      setDeliveries(list)
    } finally {
      setLoading(false)
    }
  }, [session, webhook.id])

  async function onExpand() {
    setExpanded(true)
    if (deliveries === null) void reload()
  }

  async function onRetry(deliveryId: string) {
    if (!session) return
    setRetrying(deliveryId)
    try {
      await api.retryWebhookDelivery(
        session.session.token,
        session.account.id,
        webhook.id,
        deliveryId,
      )
      // Optimistic: mark PENDING locally so the row shows the change without
      // waiting for the next refetch. The 30-second worker will pick it up.
      setDeliveries((prev) =>
        prev
          ? prev.map((d) =>
              d.id === deliveryId
                ? { ...d, status: 'PENDING', errorMessage: null }
                : d,
            )
          : prev,
      )
    } finally {
      setRetrying(null)
    }
  }

  return (
    <li className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {webhook.name}
            {!webhook.isActive ? (
              <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {t('webhooks.paused')}
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">{webhook.url}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('webhooks.events_line', { events: webhook.events.join(', ') })}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (expanded ? setExpanded(false) : onExpand())}
            data-testid={`expand-${webhook.id}`}
          >
            {expanded ? t('webhooks.hide') : t('webhooks.deliveries')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onToggle()}>
            {webhook.isActive ? t('webhooks.pause') : t('webhooks.resume')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onDelete()}>
            {t('webhooks.delete')}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-muted/30">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium">{t('webhooks.recent_deliveries')}</span>
            <Button size="sm" variant="ghost" onClick={() => reload()} disabled={loading}>
              {loading ? t('webhooks.refreshing') : t('webhooks.refresh')}
            </Button>
          </div>
          {deliveries === null ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : deliveries.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t('webhooks.no_deliveries')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t('webhooks.col_when')}</th>
                  <th className="px-3 py-2 text-left">{t('webhooks.col_event')}</th>
                  <th className="px-3 py-2 text-left">{t('webhooks.col_status')}</th>
                  <th className="px-3 py-2 text-left">HTTP</th>
                  <th className="px-3 py-2 text-left">{t('webhooks.col_attempts')}</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      {fmt.dateTime(d.createdAt)}
                    </td>
                    <td className="px-3 py-2 font-mono">{d.event}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-3 py-2">{d.responseStatus ?? '-'}</td>
                    <td className="px-3 py-2">{d.attempts}</td>
                    <td className="px-3 py-2 text-right">
                      {d.status === 'FAILED' || d.status === 'PENDING' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={retrying === d.id}
                          onClick={() => onRetry(d.id)}
                          data-testid={`retry-${d.id}`}
                        >
                          {retrying === d.id ? t('webhooks.queued') : t('webhooks.retry')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </li>
  )
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations()
  const palette =
    status === 'SUCCESS'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : status === 'FAILED'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${palette}`}>
      {t(`webhooks.status_${status.toLowerCase()}` as never)}
    </span>
  )
}

function CreateForm({
  onCreate,
}: {
  onCreate: (name: string, url: string, events: WebhookEvent[]) => Promise<void>
}) {
  const t = useTranslations()
  const [name, setName] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [events, setEvents] = React.useState<Set<WebhookEvent>>(
    new Set(['conversation.created', 'conversation.resolved']),
  )
  const [submitting, setSubmitting] = React.useState(false)

  function toggleEvent(e: WebhookEvent) {
    setEvents((prev) => {
      const next = new Set(prev)
      if (next.has(e)) next.delete(e)
      else next.add(e)
      return next
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim() || events.size === 0) return
    setSubmitting(true)
    try {
      await onCreate(name.trim(), url.trim(), Array.from(events))
      setName('')
      setUrl('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{t('webhooks.new_title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('webhooks.name_label')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('webhooks.name_placeholder')}
          />
        </Field>
        <Field label={t('webhooks.url_label')}>
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('webhooks.url_placeholder')}
          />
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">
          {t('webhooks.events_label')}
        </legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {EVENT_OPTIONS.map((e) => (
            <label
              key={e}
              className="inline-flex items-center gap-2 text-xs text-foreground"
            >
              <Checkbox
                checked={events.has(e)}
                onCheckedChange={() => toggleEvent(e)}
                aria-label={e}
              />
              <code className="font-mono">{e}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !name.trim() || !url.trim() || events.size === 0}
        >
          {t('webhooks.create')}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
