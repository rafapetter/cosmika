'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import { ApiError, api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'
import { RuleForm } from '../_form'

export default function NewAutomationRulePage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ready && !session) router.replace('/sign-in')
  }, [ready, session, router])

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
      <header>
        <Link
          href="/automation"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('automation.back_to_list')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {t('automation.new_title')}
        </h1>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <RuleForm
        submitting={submitting}
        onSubmit={async (values) => {
          setSubmitting(true)
          setError(null)
          try {
            const rule = await api.createAutomationRule(
              session.session.token,
              session.account.id,
              values,
            )
            router.replace(`/automation/${rule.id}`)
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
      />
    </div>
      </main>
  )
}
