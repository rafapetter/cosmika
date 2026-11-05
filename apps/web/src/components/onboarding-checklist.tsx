'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Circle, ExternalLink, X } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Progress,
} from '@cosmika/ui'
import {
  OnboardingStepKey,
  type OnboardingStatusDTO,
} from '@cosmika/shared'

import { api } from '../lib/api'
import { useStoredSession } from '../lib/session-store'

const DOCS = 'https://docs.cosmobots.io/cosmika'

// Where each step is done in the app, and the help page that explains it.
const STEP_LINKS: Record<OnboardingStepKey, { href: string; guide: string }> = {
  channel: { href: '/inboxes/new', guide: `${DOCS}/whatsapp` },
  firstMessage: { href: '/conversations', guide: `${DOCS}/primeiros-passos` },
  automation: { href: '/assistant', guide: `${DOCS}/atendimento-automatico` },
  team: { href: '/settings/members', guide: `${DOCS}/equipe` },
  availability: { href: '/settings/availability', guide: `${DOCS}/disponibilidade` },
}

export function hiddenKey(accountId: string): string {
  return `cosmika.onboarding.hidden.${accountId}`
}

function readHidden(accountId: string): boolean {
  try {
    return window.localStorage.getItem(hiddenKey(accountId)) === '1'
  } catch {
    return false
  }
}

/**
 * "First steps" checklist for a new account. Shown to administrators only
 * (they are the ones who can act on it) and gone for good once every step is
 * done. Steps are computed server-side from real account state, and the list
 * re-checks when the tab regains focus, so finishing a step elsewhere in the
 * app ticks it off on return.
 */
export function OnboardingChecklist() {
  const t = useTranslations('onboarding')
  const { session } = useStoredSession()
  const [status, setStatus] = useState<OnboardingStatusDTO | null>(null)
  const [hidden, setHidden] = useState(false)

  const accountId = session?.account.id
  const token = session?.session.token
  const isAdmin = session?.membership.role === 'ADMINISTRATOR'

  const load = useCallback(() => {
    if (!accountId || !token) return
    api
      .getOnboarding(token, accountId)
      .then(setStatus)
      // A failed check must never get in the way of the dashboard.
      .catch(() => setStatus(null))
  }, [accountId, token])

  useEffect(() => {
    if (!accountId || !isAdmin) return
    setHidden(readHidden(accountId))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [accountId, isAdmin, load])

  if (!isAdmin || !accountId || hidden || !status) return null
  if (status.completed >= status.total) return null

  const hide = () => {
    try {
      window.localStorage.setItem(hiddenKey(accountId), '1')
    } catch {
      // Storage can be unavailable (private mode); hiding still works this visit.
    }
    setHidden(true)
  }

  const nextStep = OnboardingStepKey.options.find((k) => !status.steps[k])

  return (
    <Card aria-labelledby="onboarding-title">
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle id="onboarding-title" className="text-sm font-medium">
              {t('title')}
            </CardTitle>
            <CardDescription className="text-xs">{t('subtitle')}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={hide}
            aria-label={t('hide')}
            title={t('hide')}
          >
            <X />
          </Button>
        </div>
        <div className="space-y-1.5">
          <Progress
            value={status.completed}
            max={status.total}
            label={t('progress', {
              completed: status.completed,
              total: status.total,
            })}
          />
          <p className="text-xs text-muted-foreground">
            {t('progress', { completed: status.completed, total: status.total })}
          </p>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ol className="divide-y divide-border border-t border-border">
          {OnboardingStepKey.options.map((key) => {
            const done = status.steps[key]
            const isNext = key === nextStep
            const links = STEP_LINKS[key]
            return (
              <li
                key={key}
                data-step={key}
                data-done={done}
                className={
                  done
                    ? 'flex items-center gap-3 p-4'
                    : 'flex flex-col gap-3 p-4 sm:flex-row sm:items-center'
                }
              >
                <div className="flex flex-1 items-start gap-3">
                  {done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <p
                      className={
                        done
                          ? 'text-sm text-muted-foreground'
                          : 'text-sm font-medium text-foreground'
                      }
                    >
                      {t(`steps.${key}.title`)}
                    </p>
                    {!done && (
                      <p className="text-xs text-muted-foreground">
                        {t(`steps.${key}.body`)}
                      </p>
                    )}
                  </div>
                </div>

                {done ? (
                  <Badge variant="success" className="shrink-0">
                    {t('done')}
                  </Badge>
                ) : (
                  <div className="flex shrink-0 items-center gap-1 pl-7 sm:pl-0">
                    <Button variant="link" size="sm" asChild>
                      <a href={links.guide} target="_blank" rel="noopener noreferrer">
                        {t('how_to')}
                        <ExternalLink />
                      </a>
                    </Button>
                    <Button variant={isNext ? 'primary' : 'outline'} size="sm" asChild>
                      <a href={links.href}>{t(`steps.${key}.action`)}</a>
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <div className="border-t border-border px-4 py-3">
          <Button variant="link" size="sm" className="h-auto px-0" asChild>
            <a href={`${DOCS}/primeiros-passos`} target="_blank" rel="noopener noreferrer">
              {t('guide')}
              <ExternalLink />
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
