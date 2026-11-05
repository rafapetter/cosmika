'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { ArticleStatus } from '@cosmika/shared'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

export type ArticleFormState = {
  slug: string
  title: string
  content: string
  status: ArticleStatus
  tagsText: string
}

export function ArticleForm({
  initial,
  slugLocked,
  submitting,
  onSubmit,
  onDelete,
}: {
  initial: ArticleFormState
  slugLocked: boolean
  submitting: boolean
  onSubmit: (form: ArticleFormState) => void
  onDelete?: () => void
}) {
  const t = useTranslations()
  const [form, setForm] = React.useState<ArticleFormState>(initial)
  const set = <K extends keyof ArticleFormState>(k: K) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => setForm((p) => ({ ...p, [k]: e.target.value as ArticleFormState[K] }))

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit(form)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <FormField label={t('knowledgeBase.form_title')} htmlFor="article-title" required>
          <Input
            id="article-title"
            value={form.title}
            onChange={set('title')}
            placeholder={t('knowledgeBase.form_title_placeholder')}
            required
          />
        </FormField>
        <FormField label={t('knowledgeBase.form_status')} htmlFor="article-status">
          <Select
            value={form.status}
            onValueChange={(v) => setForm((p) => ({ ...p, status: v as ArticleStatus }))}
          >
            <SelectTrigger id="article-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="DRAFT">{t('knowledgeBase.form_status_draft')}</SelectItem>
              <SelectItem value="PUBLISHED">{t('knowledgeBase.form_status_published')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </div>
      <FormField
        label={t('knowledgeBase.form_slug')}
        htmlFor="article-slug"
        hint={slugLocked ? t('knowledgeBase.form_slug_locked') : t('knowledgeBase.form_slug_hint')}
        required={!slugLocked}
      >
        <Input
          id="article-slug"
          value={form.slug}
          onChange={set('slug')}
          placeholder={t('knowledgeBase.form_slug_placeholder')}
          className="font-mono"
          disabled={slugLocked}
          required
        />
      </FormField>
      <FormField
        label={t('knowledgeBase.form_tags')}
        htmlFor="article-tags"
        hint={t('knowledgeBase.form_tags_hint')}
      >
        <Input
          id="article-tags"
          value={form.tagsText}
          onChange={set('tagsText')}
          placeholder={t('knowledgeBase.form_tags_placeholder')}
        />
      </FormField>
      <FormField
        label={t('knowledgeBase.form_content')}
        htmlFor="article-content"
        hint={t('knowledgeBase.form_content_hint')}
        required
      >
        <Textarea
          id="article-content"
          value={form.content}
          onChange={set('content')}
          rows={18}
          required
          className="resize-y font-mono text-xs"
        />
      </FormField>
      <div className="flex items-center justify-between">
        <div>
          {onDelete ? (
            <Button type="button" variant="destructive" onClick={onDelete}>
              {t('common.delete')}
            </Button>
          ) : null}
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !form.title.trim() || !form.content.trim()}
        >
          {submitting ? t('knowledgeBase.form_saving') : t('common.save')}
        </Button>
      </div>
    </form>
  )
}

export function tagsTextToArray(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
}
