'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { SlaPolicyDTO } from '@cosmika/shared'
import { Button, Input } from '@cosmika/ui'
import Link from 'next/link'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

type FormState = {
  name: string
  firstResponseLowMinutes: string
  firstResponseNormalMinutes: string
  firstResponseHighMinutes: string
  firstResponseUrgentMinutes: string
  resolutionLowMinutes: string
  resolutionNormalMinutes: string
  resolutionHighMinutes: string
  resolutionUrgentMinutes: string
  firstResponseSeconds: string
}

const DEFAULT_FORM: FormState = {
  name: '',
  firstResponseLowMinutes: '480',
  firstResponseNormalMinutes: '240',
  firstResponseHighMinutes: '60',
  firstResponseUrgentMinutes: '15',
  resolutionLowMinutes: '10080',
  resolutionNormalMinutes: '2880',
  resolutionHighMinutes: '480',
  resolutionUrgentMinutes: '120',
  firstResponseSeconds: '',
}

export default function SlaPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<SlaPolicyDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listSlaPolicies(
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

  async function onCreate(form: FormState) {
    if (!session) return
    try {
      await api.createSlaPolicy(session.session.token, session.account.id, {
        name: form.name,
        firstResponseLowMinutes: Number(form.firstResponseLowMinutes),
        firstResponseNormalMinutes: Number(form.firstResponseNormalMinutes),
        firstResponseHighMinutes: Number(form.firstResponseHighMinutes),
        firstResponseUrgentMinutes: Number(form.firstResponseUrgentMinutes),
        resolutionLowMinutes: Number(form.resolutionLowMinutes),
        resolutionNormalMinutes: Number(form.resolutionNormalMinutes),
        resolutionHighMinutes: Number(form.resolutionHighMinutes),
        resolutionUrgentMinutes: Number(form.resolutionUrgentMinutes),
        ...(form.firstResponseSeconds.trim() && {
          firstResponseSeconds: Number(form.firstResponseSeconds),
        }),
      })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onDelete(id: string) {
    if (!session) return
    if (!confirm(t('sla.delete_confirm')))
      return
    await api.deleteSlaPolicy(session.session.token, session.account.id, id)
    await reload()
  }

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('sla.title')}
        subtitle={t('sla.subtitle')}
      />

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <p className="text-sm">
        <Link href="/reports/sla" className="text-primary hover:underline" data-testid="sla-misses-link">
          {t('sla.misses_link')}
        </Link>
      </p>

      <CreateForm onCreate={onCreate} />

      {items === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('sla.empty')}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.id.slice(0, 12)}…
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onDelete(p.id)}
                >
                  {t('sla.delete')}
                </Button>
              </div>
              {p.firstResponseSeconds ? (
                <p className="mt-3 text-xs font-medium text-foreground" data-testid="sla-seconds">
                  {t('sla.first_reply_seconds_value', { seconds: p.firstResponseSeconds })}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <Cell label={t('sla.first_reply', { priority: t('sla.priority_low') })} value={p.firstResponseLowMinutes} />
                <Cell label={t('sla.first_reply', { priority: t('sla.priority_normal') })} value={p.firstResponseNormalMinutes} />
                <Cell label={t('sla.first_reply', { priority: t('sla.priority_high') })} value={p.firstResponseHighMinutes} />
                <Cell label={t('sla.first_reply', { priority: t('sla.priority_urgent') })} value={p.firstResponseUrgentMinutes} />
                <Cell label={t('sla.resolution', { priority: t('sla.priority_low') })} value={p.resolutionLowMinutes} />
                <Cell label={t('sla.resolution', { priority: t('sla.priority_normal') })} value={p.resolutionNormalMinutes} />
                <Cell label={t('sla.resolution', { priority: t('sla.priority_high') })} value={p.resolutionHighMinutes} />
                <Cell label={t('sla.resolution', { priority: t('sla.priority_urgent') })} value={p.resolutionUrgentMinutes} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/60 bg-background p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-mono">{prettyMinutes(value)}</p>
    </div>
  )
}

function prettyMinutes(m: number): string {
  if (m % (24 * 60) === 0) return `${m / (24 * 60)}d`
  if (m % 60 === 0) return `${m / 60}h`
  return `${m}m`
}

function CreateForm({
  onCreate,
}: {
  onCreate: (form: FormState) => Promise<void>
}) {
  const t = useTranslations()
  const [form, setForm] = React.useState<FormState>(DEFAULT_FORM)
  const [submitting, setSubmitting] = React.useState(false)
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSubmitting(true)
    try {
      await onCreate(form)
      setForm(DEFAULT_FORM)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{t('sla.new_title')}</h2>
      <Field label={t('sla.name_label')}>
        <Input value={form.name} onChange={set('name')} placeholder={t('sla.name_placeholder')} />
      </Field>
      <Field label={t('sla.first_reply_seconds')}>
        <Input
          type="number"
          min={10}
          value={form.firstResponseSeconds}
          onChange={set('firstResponseSeconds')}
          placeholder={t('sla.first_reply_seconds_placeholder')}
          data-testid="sla-seconds-input"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('sla.first_reply_min', { priority: t('sla.priority_low') })}>
          <Input type="number" value={form.firstResponseLowMinutes} onChange={set('firstResponseLowMinutes')} />
        </Field>
        <Field label={t('sla.first_reply_min', { priority: t('sla.priority_normal') })}>
          <Input type="number" value={form.firstResponseNormalMinutes} onChange={set('firstResponseNormalMinutes')} />
        </Field>
        <Field label={t('sla.first_reply_min', { priority: t('sla.priority_high') })}>
          <Input type="number" value={form.firstResponseHighMinutes} onChange={set('firstResponseHighMinutes')} />
        </Field>
        <Field label={t('sla.first_reply_min', { priority: t('sla.priority_urgent') })}>
          <Input type="number" value={form.firstResponseUrgentMinutes} onChange={set('firstResponseUrgentMinutes')} />
        </Field>
        <Field label={t('sla.resolution_min', { priority: t('sla.priority_low') })}>
          <Input type="number" value={form.resolutionLowMinutes} onChange={set('resolutionLowMinutes')} />
        </Field>
        <Field label={t('sla.resolution_min', { priority: t('sla.priority_normal') })}>
          <Input type="number" value={form.resolutionNormalMinutes} onChange={set('resolutionNormalMinutes')} />
        </Field>
        <Field label={t('sla.resolution_min', { priority: t('sla.priority_high') })}>
          <Input type="number" value={form.resolutionHighMinutes} onChange={set('resolutionHighMinutes')} />
        </Field>
        <Field label={t('sla.resolution_min', { priority: t('sla.priority_urgent') })}>
          <Input type="number" value={form.resolutionUrgentMinutes} onChange={set('resolutionUrgentMinutes')} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !form.name.trim()}
        >
          {submitting ? t('sla.saving') : t('sla.create')}
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
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}
