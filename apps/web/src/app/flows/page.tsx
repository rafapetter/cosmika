'use client'

import * as React from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { FlowSummaryDTO } from '@cosmika/shared'
import { Badge, Button, Input } from '@cosmika/ui'

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { useDateTime } from '../../lib/format-datetime'

import { PageContainer, PageHeader } from '../../components/page'
import { useStoredSession } from '../../lib/session-store'
import { starterDefinition } from './flow-edit'
import { useFlowText } from './_flow-text'

const STATUS_VARIANT: Record<string, 'outline' | 'warning' | 'success'> = {
  DRAFT: 'outline',
  PUBLISHED: 'success',
  ARCHIVED: 'warning',
}

export default function FlowsPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const text = useFlowText()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<FlowSummaryDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [name, setName] = React.useState('')
  const [busyId, setBusyId] = React.useState<string | null>(null)
  // Publishing from the list gives no canvas to point at, so we only say how
  // many problems there are and send the author to the editor to see them.
  const [checked, setChecked] = React.useState<{ name: string; count: number } | null>(null)
  const [creating, setCreating] = React.useState(false)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      setItems(await api.listFlows(session.session.token, session.account.id))
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!session || !name.trim()) return
    setCreating(true)
    setError(null)
    try {
      await api.createFlow(session.session.token, session.account.id, {
        name: name.trim(),
        definition: starterDefinition(text),
      })
      setName('')
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setCreating(false)
    }
  }

  async function onPublish(f: FlowSummaryDTO) {
    if (!session) return
    setBusyId(f.id)
    setError(null)
    setChecked(null)
    try {
      const r = await api.publishFlow(session.session.token, session.account.id, f.id)
      if (r.checks.length > 0) setChecked({ name: f.name, count: r.checks.length })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusyId(null)
    }
  }

  async function onDelete(f: FlowSummaryDTO) {
    if (!session) return
    if (!confirm(t('flows.delete_confirm', { name: f.name }))) return
    setBusyId(f.id)
    setError(null)
    try {
      await api.deleteFlow(session.session.token, session.account.id, f.id)
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusyId(null)
    }
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('flows.title')}
        subtitle={t('flows.subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="flows-error">
          {error}
        </p>
      ) : null}
      {checked ? (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-xs" data-testid="flows-checks">
          {t('flows.checks_list_notice', { name: checked.name, count: checked.count })}
        </p>
      ) : null}

      <form onSubmit={onCreate} className="flex items-center gap-2" data-testid="flow-create-form">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('flows.name_placeholder')}
          data-testid="flow-name"
        />
        <Button type="submit" variant="primary" disabled={!name.trim() || creating} data-testid="flow-create">
          {creating ? t('flows.creating') : t('flows.create')}
        </Button>
      </form>

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="flows-empty">
          {t('flows.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="flow-list">
          {items.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={{ pathname: `/flows/${f.id}` }} className="truncate text-sm font-medium hover:underline" data-testid={`flow-link-${f.id}`}>
                    {f.name}
                  </Link>
                  <Badge variant={STATUS_VARIANT[f.status] ?? 'outline'}>{t(`flows.status_${f.status.toLowerCase()}` as never)}</Badge>
                  {f.hasPublished ? (
                    <span className="text-xs text-muted-foreground">{t('flows.has_published')}</span>
                  ) : (
                    <span className="text-xs text-warning">{t('flows.draft_only')}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('flows.updated_at', { date: fmt.date(f.updatedAt) })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onPublish(f)}
                  disabled={busyId === f.id}
                  data-testid={`flow-publish-${f.id}`}
                >
                  {t('flows.publish')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDelete(f)}
                  disabled={busyId === f.id}
                  data-testid={`flow-delete-${f.id}`}
                >
                  {t('common.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}
