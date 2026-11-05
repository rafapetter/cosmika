'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { BillingStatusDTO } from '@cosmika/shared'
import { Button } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { financeEmail } from '../../lib/instance'
import { clearSession, useStoredSession } from '../../lib/session-store'


export default function SubscriptionPage() {
  const t = useTranslations()
  const format = useFormatter()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [status, setStatus] = useState<BillingStatusDTO | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)

  const check = useCallback(async () => {
    if (!session) return
    setChecking(true)
    setError(false)
    try {
      const s = await api.getBillingStatus(session.session.token)
      // Paid (or the trial was extended): nothing to show here.
      if (s.accessAllowed) {
        router.replace('/inbox')
        return
      }
      setStatus(s)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setError(true)
    } finally {
      setChecking(false)
    }
  }, [session, router])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    void check()
  }, [ready, session, router, check])

  async function onSignOut() {
    if (session) await api.signOut(session.session.token).catch(() => undefined)
    clearSession()
    router.replace('/sign-in')
  }

  const trialDate = status?.trialExpiresAt
    ? format.dateTime(new Date(`${status.trialExpiresAt}T12:00:00Z`), { dateStyle: 'long' })
    : null

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          {t('brand.name')}
        </div>

        {status === null ? (
          <p className="text-sm text-muted-foreground">
            {error ? t('auth.generic_error') : t('common.loading')}
          </p>
        ) : (
          <div className="space-y-6 rounded-lg border border-border bg-card p-6">
            <header className="space-y-2">
              <h1 className="text-lg font-semibold" data-testid="subscription-title">
                {trialDate ? t('billing.ended_title_trial') : t('billing.ended_title')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('billing.ended_body')}</p>
              {trialDate ? (
                <p className="text-xs text-muted-foreground">
                  {t('billing.ended_trial_date', { date: trialDate })}
                </p>
              ) : null}
            </header>

            <div className="space-y-2">
              {status.checkoutUrl ? (
                <Button asChild variant="primary" className="w-full">
                  <a href={status.checkoutUrl} target="_blank" rel="noopener noreferrer" data-testid="pay-now">
                    {t('billing.pay_now')}
                  </a>
                </Button>
              ) : (
                <p className="text-sm">{t('billing.no_link')}</p>
              )}
              {/* Where a locked-out customer reaches billing, if the install set it. */}
              {financeEmail() ? (
                <Button asChild variant="outline" className="w-full">
                  <a href={`mailto:${financeEmail()}`}>{t('billing.contact_finance')}</a>
                </Button>
              ) : null}
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">{t('billing.paid_hint')}</p>
              <div className="flex items-center justify-between gap-2">
                <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking}>
                  {checking ? t('common.loading') : t('billing.check_again')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void onSignOut()}>
                  {t('auth.sign_out')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
