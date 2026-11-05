'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type {
  CustomAttributeDTO,
  CustomAttributeTarget,
  CustomAttributeType,
} from '@cosmika/shared'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const TYPES: CustomAttributeType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
]

const TARGETS: { value: CustomAttributeTarget; labelKey: string }[] = [
  { value: 'CONTACT', labelKey: 'customAttributes.target_contact' },
  { value: 'CONVERSATION', labelKey: 'customAttributes.target_conversation' },
]

export default function CustomAttributesPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<CustomAttributeDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listCustomAttributes(
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

  async function onCreate(input: {
    target: CustomAttributeTarget
    key: string
    label: string
    type: CustomAttributeType
    options?: { value: string; label: string }[]
  }) {
    if (!session) return
    try {
      await api.createCustomAttribute(
        session.session.token,
        session.account.id,
        input,
      )
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onDelete(id: string) {
    if (!session) return
    if (!confirm(t('customAttributes.delete_confirm'))) return
    await api.deleteCustomAttribute(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('customAttributes.title')}
        subtitle={t('customAttributes.subtitle')}
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
        <p className="text-sm text-muted-foreground">{t('customAttributes.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-start justify-between gap-3 p-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{c.key}</span> ·{' '}
                  {t(`customAttributes.target_${c.target.toLowerCase()}` as never)} ·{' '}
                  {t(`customAttributes.type_${c.type.toLowerCase()}` as never)}
                  {c.options && c.options.length > 0
                    ? ` · ${t('customAttributes.options_count', { n: c.options.length })}`
                    : ''}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => onDelete(c.id)}>
                {t('customAttributes.delete')}
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
  onCreate: (input: {
    target: CustomAttributeTarget
    key: string
    label: string
    type: CustomAttributeType
    options?: { value: string; label: string }[]
  }) => Promise<void>
}) {
  const t = useTranslations()
  const [target, setTarget] = React.useState<CustomAttributeTarget>('CONTACT')
  const [key, setKey] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [type, setType] = React.useState<CustomAttributeType>('TEXT')
  const [optionsText, setOptionsText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim() || !label.trim()) return
    setSubmitting(true)
    try {
      const options =
        type === 'SELECT'
          ? optionsText
              .split(',')
              .map((o) => o.trim())
              .filter(Boolean)
              .map((value) => ({ value, label: value }))
          : undefined
      await onCreate({
        target,
        key: key.trim(),
        label: label.trim(),
        type,
        options,
      })
      setKey('')
      setLabel('')
      setOptionsText('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{t('customAttributes.new_title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('customAttributes.target')} htmlFor="ca-target">
          <Select
            value={target}
            onValueChange={(v) => setTarget(v as CustomAttributeTarget)}
          >
            <SelectTrigger id="ca-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TARGETS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {t(o.labelKey as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('customAttributes.type')} htmlFor="ca-type">
          <Select
            value={type}
            onValueChange={(v) => setType(v as CustomAttributeType)}
          >
            <SelectTrigger id="ca-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((o) => (
                <SelectItem key={o} value={o}>
                  {t(`customAttributes.type_${o.toLowerCase()}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('customAttributes.key_label')} htmlFor="ca-key">
          <Input
            id="ca-key"
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            placeholder={t('customAttributes.key_placeholder')}
            className="font-mono"
          />
        </FormField>
        <FormField label={t('customAttributes.label_label')} htmlFor="ca-label">
          <Input
            id="ca-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('customAttributes.label_placeholder')}
          />
        </FormField>
        {type === 'SELECT' ? (
          <FormField
            label={t('customAttributes.options_label')}
            htmlFor="ca-options"
            className="sm:col-span-2"
          >
            <Input
              id="ca-options"
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              placeholder={t('customAttributes.options_placeholder')}
            />
          </FormField>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !key.trim() || !label.trim()}
        >
          {t('customAttributes.create')}
        </Button>
      </div>
    </form>
  )
}
