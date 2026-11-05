'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import type { ArticleDTO, ArticleStatus } from '@cosmika/shared'
import {
  Badge,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { PageContainer, PageHeader } from '../../components/page'
import { useStoredSession } from '../../lib/session-store'

export default function KnowledgeBasePage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<ArticleDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [statusFilter, setStatusFilter] = React.useState<'ALL' | ArticleStatus>('ALL')
  const [q, setQ] = React.useState('')

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const list = await api.listArticles(
        session.session.token,
        session.account.id,
        {
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          q: q.trim() || undefined,
        },
      )
      setItems(list)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, statusFilter, q, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('knowledgeBase.title')}
        subtitle={t('knowledgeBase.subtitle')}
        actions={
          <Link
            href="/knowledge-base/new"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            data-testid="new-article"
          >
            {t('knowledgeBase.new_article')}
          </Link>
        }
      />

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as 'ALL' | ArticleStatus)}
        >
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('knowledgeBase.filter_all')}</SelectItem>
            <SelectItem value="DRAFT">{t('knowledgeBase.filter_drafts')}</SelectItem>
            <SelectItem value="PUBLISHED">{t('knowledgeBase.filter_published')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('knowledgeBase.search_placeholder')}
          className="h-8 max-w-sm"
        />
      </div>

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('knowledgeBase.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((a) => (
            <li key={a.id}>
              <a
                href={`/knowledge-base/${a.id}`}
                className="flex items-start justify-between gap-3 p-4 hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{a.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">/{a.slug}</p>
                  {a.tags.length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {a.tags.map((t) => `#${t}`).join(' ')}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.hasEmbedding ? (
                    <span
                      title={t('knowledgeBase.ai_indexed_hint')}
                      className="text-[10px] text-emerald-600 dark:text-emerald-400"
                    >
                      {t('knowledgeBase.ai_indexed')}
                    </span>
                  ) : null}
                  <Badge variant={a.status === 'PUBLISHED' ? 'default' : 'pending'}>
                    {t(`knowledgeBase.status_${a.status.toLowerCase()}` as never)}
                  </Badge>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}
