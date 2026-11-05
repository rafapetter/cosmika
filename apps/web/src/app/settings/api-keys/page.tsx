'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { ApiKeyDTO, ApiKeyWithSecret } from '@cosmika/shared'
import { Button, Input } from '@cosmika/ui'

import { API_BASE, api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useDateTime } from '../../../lib/format-datetime'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

export default function ApiKeysPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<ApiKeyDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState<ApiKeyWithSecret | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listApiKeys(session.session.token, session.account.id)
      setItems(r)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  async function onCreate(name: string) {
    if (!session) return
    try {
      const created = await api.createApiKey(
        session.session.token,
        session.account.id,
        { name },
      )
      setRevealed(created)
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onRevoke(id: string) {
    if (!session) return
    if (!confirm(t('apiKeys.revoke_confirm')))
      return
    await api.revokeApiKey(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('apiKeys.title')}
        subtitle={t('apiKeys.subtitle')}
        actions={
          <Button asChild size="sm" variant="outline">
            <a href={`${API_BASE}/docs`} target="_blank" rel="noreferrer" data-testid="api-docs-link">
              {t('apiKeys.docs_link')}
            </a>
          </Button>
        }
      />

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {revealed ? (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium">{t('apiKeys.created_title')}</p>
          <p className="text-xs text-muted-foreground">
            {t('apiKeys.created_hint')}
          </p>
          <code className="block break-all rounded bg-background px-2 py-2 font-mono text-xs">
            {revealed.secret}
          </code>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t('apiKeys.curl_example')}
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px]">
              {`curl -H 'authorization: Bearer ${revealed.secret}' \\
  ${API_BASE}/v1/whoami`}
            </pre>
          </details>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRevealed(null)}
            data-testid="dismiss-api-key"
          >
            {t('apiKeys.dismiss')}
          </Button>
        </div>
      ) : null}

      <CreateForm onCreate={onCreate} />

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('apiKeys.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((k) => (
            <li key={k.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {k.name}
                  {k.revokedAt ? (
                    <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] uppercase text-destructive">
                      {t('apiKeys.revoked')}
                    </span>
                  ) : null}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  cosmika_{k.prefix}_…
                </p>
                <p className="text-xs text-muted-foreground">
                  {k.lastUsedAt
                    ? t('apiKeys.last_used', {
                        when: fmt.dateTime(k.lastUsedAt),
                      })
                    : t('apiKeys.never_used')}
                  {' · '}
                  {t('apiKeys.created_at', {
                    when: fmt.date(k.createdAt),
                  })}
                </p>
              </div>
              {!k.revokedAt ? (
                <Button size="sm" variant="ghost" onClick={() => onRevoke(k.id)}>
                  {t('apiKeys.revoke')}
                </Button>
              ) : null}
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
  onCreate: (name: string) => Promise<void>
}) {
  const t = useTranslations()
  const [name, setName] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    try {
      await onCreate(name.trim())
      setName('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-lg border border-border bg-card p-4"
    >
      <label className="flex-1">
        <span className="block text-xs font-medium text-muted-foreground">
          {t('apiKeys.new_name_label')}
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('apiKeys.new_name_placeholder')}
        />
      </label>
      <Button
        type="submit"
        variant="primary"
        disabled={submitting || !name.trim()}
        data-testid="create-api-key"
      >
        {submitting ? t('apiKeys.creating') : t('apiKeys.create')}
      </Button>
    </form>
  )
}
