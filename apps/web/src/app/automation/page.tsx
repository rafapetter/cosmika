'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type { AutomationRuleDTO } from '@cosmika/shared'
import { buttonVariants } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'

export default function AutomationListPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [rules, setRules] = useState<AutomationRuleDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    api
      .listAutomationRules(session.session.token, session.account.id)
      .then(setRules)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('automation.forbidden'))
        } else {
          setError(t('auth.generic_error'))
        }
      })
  }, [ready, session, router, t])

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('automation.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('automation.subtitle')}
          </p>
        </div>
        <Link
          href="/automation/new"
          className={buttonVariants({ variant: 'default' })}
          data-testid="create-rule"
        >
          {t('automation.create')}
        </Link>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {rules === null && !error ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {rules && rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('automation.empty')}</p>
      ) : null}

      {rules && rules.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center justify-between p-4">
              <div>
                <Link
                  href={`/automation/${rule.id}`}
                  className="font-medium hover:underline"
                  data-testid={`rule-${rule.id}`}
                >
                  {rule.name}
                </Link>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(`automation.trigger_${rule.triggerEvent}`)} ·{' '}
                  {rule.actions.length}{' '}
                  {t('automation.actions').toLowerCase()}
                </p>
              </div>
              <span
                className={`text-xs uppercase tracking-wide ${
                  rule.isActive ? 'text-emerald-600' : 'text-muted-foreground'
                }`}
              >
                {rule.isActive ? t('automation.is_active') : '-'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Link
        href="/inbox"
        className="inline-block text-sm text-muted-foreground hover:underline"
      >
        ← {t('inbox.title')}
      </Link>
    </div>
      </main>
  )
}
