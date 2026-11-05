'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowRight, Sparkles, X } from 'lucide-react'
import { Button, Card, CardContent } from '@cosmika/ui'
import { isProfilePending, type AccountProfileDTO } from '@cosmika/shared'

import { api } from '../lib/api'
import { useStoredSession } from '../lib/session-store'

/**
 * One line on the dashboard inviting an administrator back into the welcome
 * flow, for as long as the profile is neither finished nor dismissed.
 *
 * It sits OUTSIDE the first-steps checklist on purpose, and this is not a
 * layout preference. That card disappears when the five steps are done, and
 * for good in a browser where somebody pressed its X. Rendered inside it,
 * this invitation would inherit both: it would vanish for an account that
 * finished setup but never answered, and dismissing the checklist would
 * silently dismiss this too. Its own component gives it its own life.
 *
 * Administrators only, stated here rather than inherited: the questions are
 * about the company, and an agent cannot answer them.
 *
 * It is an invitation, never a step. The checklist next to it derives every
 * step from real account state so that it cannot claim something is done when
 * it is not; "filled in a form" is exactly the kind of flag that would cost
 * it that property.
 */
export function OnboardingProfilePrompt() {
  const t = useTranslations('onboardingFlow')
  const { session } = useStoredSession()
  const [pending, setPending] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const isAdmin = session?.membership.role === 'ADMINISTRATOR'

  useEffect(() => {
    if (!session || session.membership.role !== 'ADMINISTRATOR') return
    api
      .getAccountProfile(session.session.token, session.account.id)
      .then((p: AccountProfileDTO | null) => setPending(isProfilePending(p)))
      // A failed check must never get in the way of the dashboard, and a
      // refusal is not the same as "never answered": we learned nothing, so
      // we say nothing and ask again on the next visit. Note the order,
      // after `.then` and not before: catching first would turn every
      // network blip into "this account has no profile", which is an
      // invitation shown to somebody who already finished.
      .catch(() => setPending(false))
  }, [session])

  if (!isAdmin || !pending || dismissed) return null

  return (
    <Card data-testid="profile-prompt">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{t('prompt.title')}</p>
          <p className="text-xs text-muted-foreground">{t('prompt.body')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="primary" size="sm" asChild>
            <Link href="/welcome">
              {t('prompt.action')}
              <ArrowRight />
            </Link>
          </Button>
          {/* Dismissing hides it for this visit only. It is not "skip": the
              flow itself owns that, and writes it down. */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDismissed(true)}
            aria-label={t('prompt.dismiss')}
            title={t('prompt.dismiss')}
          >
            <X />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
