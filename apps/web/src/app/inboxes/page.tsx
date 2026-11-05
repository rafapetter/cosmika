'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type { InboxDTO } from '@cosmika/shared'
import { buttonVariants } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'

function channelKey(t: ReturnType<typeof useTranslations>, channel: string) {
  switch (channel) {
    case 'WEB_WIDGET':
      return t('inboxes.channel_web_widget')
    case 'EMAIL':
      return t('inboxes.channel_email')
    case 'WHATSAPP':
      return t('inboxes.channel_whatsapp')
    case 'API':
      return t('inboxes.channel_api')
    case 'TELEGRAM':
      return t('inboxes.channel_telegram')
    case 'FACEBOOK':
      return t('inboxes.channel_facebook')
    case 'INSTAGRAM':
      return t('inboxes.channel_instagram')
    default:
      return channel
  }
}

export default function InboxesPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [inboxes, setInboxes] = useState<InboxDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    let cancelled = false
    api
      .listInboxes(session.session.token, session.account.id)
      .then((data) => {
        if (!cancelled) setInboxes(data)
      })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 403) {
          setError(t('inboxes.forbidden'))
        } else {
          setError(t('auth.generic_error'))
        }
      })
    return () => {
      cancelled = true
    }
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
            {t('inboxes.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('inboxes.subtitle')}
          </p>
        </div>
        <Link
          href="/inboxes/new"
          className={buttonVariants({ variant: 'default' })}
          data-testid="create-inbox"
        >
          {t('inboxes.create')}
        </Link>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {inboxes === null && !error ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {inboxes && inboxes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inboxes.empty')}</p>
      ) : null}

      {inboxes && inboxes.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {inboxes.map((inbox) => (
            <li key={inbox.id} className="flex items-center justify-between p-4">
              <div>
                <Link
                  href={`/inboxes/${inbox.id}`}
                  className="font-medium hover:underline"
                  data-testid={`inbox-${inbox.id}`}
                >
                  {inbox.name}
                </Link>
                <p className="text-xs text-muted-foreground mt-1">
                  {channelKey(t, inbox.channelType)}
                </p>
              </div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {inbox.aiAutoreplyMode}
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
