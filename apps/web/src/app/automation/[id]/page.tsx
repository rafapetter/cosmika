'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type {
  AutomationDryRunResult,
  AutomationRuleDTO,
} from '@cosmika/shared'
import { Button } from '@cosmika/ui'

import { ApiError, api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'
import { RuleForm } from '../_form'

export default function EditAutomationRulePage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = params?.id
  const { session, ready } = useStoredSession()
  const [rule, setRule] = useState<AutomationRuleDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [convoId, setConvoId] = useState('')
  const [dry, setDry] = useState<AutomationDryRunResult | null>(null)
  const [dryError, setDryError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    if (!id) return
    api
      .getAutomationRule(session.session.token, session.account.id, id)
      .then(setRule)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('automation.forbidden'))
        } else if (err instanceof ApiError && err.status === 404) {
          router.replace('/automation')
        } else {
          setError(t('auth.generic_error'))
        }
      })
  }, [ready, session, id, router, t])

  if (!ready || !session || !rule) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <header>
        <Link
          href="/automation"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('automation.back_to_list')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {t('automation.edit_title')}
        </h1>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <RuleForm
        initial={rule}
        submitting={submitting}
        onSubmit={async (values) => {
          setSubmitting(true)
          setError(null)
          try {
            const updated = await api.updateAutomationRule(
              session.session.token,
              session.account.id,
              rule.id,
              values,
            )
            setRule(updated)
          } catch (err) {
            if (err instanceof ApiError && err.status === 403) {
              setError(t('automation.forbidden'))
            } else {
              setError(t('auth.generic_error'))
            }
          } finally {
            setSubmitting(false)
          }
        }}
        onDelete={async () => {
          if (!confirm(t('automation.confirm_delete'))) return
          try {
            await api.deleteAutomationRule(
              session.session.token,
              session.account.id,
              rule.id,
            )
            router.replace('/automation')
          } catch {
            setError(t('auth.generic_error'))
          }
        }}
      />

      <section
        className="rounded-lg border border-border bg-card p-4 space-y-3"
        data-testid="dry-run"
      >
        <h2 className="font-semibold text-sm">
          {t('automation.dry_run_title')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('automation.dry_run_help')}
        </p>
        <div className="flex gap-2">
          <input
            value={convoId}
            onChange={(e) => setConvoId(e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
            placeholder="cmp_..."
            data-testid="dry-run-id"
          />
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              setDry(null)
              setDryError(null)
              try {
                const result = await api.dryRunAutomationRule(
                  session.session.token,
                  session.account.id,
                  rule.id,
                  convoId,
                )
                setDry(result)
              } catch (err) {
                setDryError(
                  apiErrorText(t, err),
                )
              }
            }}
            disabled={!convoId}
            data-testid="dry-run-button"
          >
            {t('automation.dry_run_button')}
          </Button>
        </div>
        {dryError ? (
          <p className="text-xs text-destructive">{dryError}</p>
        ) : null}
        {dry ? (
          <div className="text-sm space-y-2">
            <p
              className={
                dry.matched
                  ? 'text-emerald-600 font-medium'
                  : 'text-muted-foreground'
              }
              data-testid="dry-run-result"
            >
              {dry.matched
                ? t('automation.dry_run_matched')
                : t('automation.dry_run_not_matched')}
            </p>
            {dry.matched && dry.wouldExecute.length > 0 ? (
              <ul className="list-disc pl-5 text-xs">
                {dry.wouldExecute.map((a, i) => (
                  <li key={i}>
                    {t(`automation.kind_${a.kind}`)}: {a.value}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
      </main>
  )
}
