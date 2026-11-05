'use client'

import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ArticleDTO } from '@cosmika/shared'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'
import { ArticleForm, tagsTextToArray, ArticleFormState } from '../_form'

export default function EditArticlePage() {
  const t = useTranslations()
  const params = useParams<{ id: string }>()
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id
  const router = useRouter()
  const { session } = useStoredSession()
  const [article, setArticle] = React.useState<ArticleDTO | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!session || !id) return
    void (async () => {
      try {
        const a = await api.getArticle(
          session.session.token,
          session.account.id,
          id,
        )
        setArticle(a)
      } catch (err) {
        setError(apiErrorText(t, err))
      }
    })()
  }, [session, id, t])

  async function onSubmit(form: ArticleFormState) {
    if (!session || !id) return
    setSubmitting(true)
    setError(null)
    try {
      const updated = await api.updateArticle(
        session.session.token,
        session.account.id,
        id,
        {
          title: form.title.trim(),
          content: form.content,
          status: form.status,
          tags: tagsTextToArray(form.tagsText),
        },
      )
      setArticle(updated)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  async function onDelete() {
    if (!session || !id) return
    if (!confirm(t('knowledgeBase.delete_confirm'))) return
    await api.deleteArticle(session.session.token, session.account.id, id)
    router.push('/knowledge-base')
  }

  if (!session) return null
  if (article === null && !error) {
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        title={article?.title ?? t('knowledgeBase.edit_title')}
        subtitle={article ? `/${article.slug}` : undefined}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {article ? (
        <ArticleForm
          initial={{
            slug: article.slug,
            title: article.title,
            content: article.content,
            status: article.status,
            tagsText: article.tags.join(' '),
          }}
          slugLocked={true}
          submitting={submitting}
          onSubmit={onSubmit}
          onDelete={onDelete}
        />
      ) : null}
    </PageContainer>
  )
}
