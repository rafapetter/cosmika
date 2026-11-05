'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'
import { ArticleForm, tagsTextToArray, ArticleFormState } from '../_form'

const INITIAL: ArticleFormState = {
  slug: '',
  title: '',
  content: '',
  status: 'DRAFT',
  tagsText: '',
}

export default function NewArticlePage() {
  const t = useTranslations()
  const router = useRouter()
  const { session } = useStoredSession()
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (!session) return null

  async function onSubmit(form: ArticleFormState) {
    if (!session) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await api.createArticle(
        session.session.token,
        session.account.id,
        {
          slug: form.slug.trim(),
          title: form.title.trim(),
          content: form.content,
          status: form.status,
          tags: tagsTextToArray(form.tagsText),
        },
      )
      router.push(`/knowledge-base/${created.id}`)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('knowledgeBase.new_article')}
        subtitle={t('knowledgeBase.new_subtitle')}
      />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ArticleForm
        initial={INITIAL}
        slugLocked={false}
        submitting={submitting}
        onSubmit={onSubmit}
      />
    </PageContainer>
  )
}
