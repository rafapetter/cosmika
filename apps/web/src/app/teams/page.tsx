'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type { TeamDTO } from '@cosmika/shared'
import { buttonVariants } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'

export default function TeamsListPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [teams, setTeams] = useState<TeamDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    api
      .listTeams(session.session.token, session.account.id)
      .then(setTeams)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('teams.forbidden'))
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
            {t('teams.title')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('teams.subtitle')}</p>
        </div>
        <Link
          href="/teams/new"
          className={buttonVariants({ variant: 'default' })}
          data-testid="create-team"
        >
          {t('teams.create')}
        </Link>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {teams === null && !error ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {teams && teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('teams.empty')}</p>
      ) : null}

      {teams && teams.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {teams.map((team) => (
            <li key={team.id} className="flex items-center justify-between p-4">
              <div>
                <Link
                  href={`/teams/${team.id}`}
                  className="font-medium hover:underline"
                  data-testid={`team-${team.id}`}
                >
                  {team.name}
                </Link>
                {team.description ? (
                  <p className="text-xs text-muted-foreground mt-1">
                    {team.description}
                  </p>
                ) : null}
              </div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {team.memberCount} {t('teams.member_count')}
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
