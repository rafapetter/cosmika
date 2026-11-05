'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type { AgentBotDTO } from '@cosmika/shared'
import { buttonVariants } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'

export default function AgentBotsListPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [bots, setBots] = useState<AgentBotDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    api
      .listAgentBots(session.session.token, session.account.id)
      .then(setBots)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('agentBots.forbidden'))
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
            {t('agentBots.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('agentBots.subtitle')}
          </p>
        </div>
        <Link
          href="/agent-bots/new"
          className={buttonVariants({ variant: 'default' })}
          data-testid="create-bot"
        >
          {t('agentBots.create')}
        </Link>
      </header>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {bots === null && !error ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {bots && bots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('agentBots.empty')}</p>
      ) : null}

      {bots && bots.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {bots.map((bot) => {
            const budgetPct = Math.min(
              100,
              Math.round((bot.costLast24hUsd / Math.max(bot.dailyBudgetUsd, 0.0001)) * 100),
            )
            return (
              <li key={bot.id} className="space-y-2 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <Link
                      href={`/agent-bots/${bot.id}`}
                      className="font-medium hover:underline"
                      data-testid={`bot-${bot.id}`}
                    >
                      {bot.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {bot.model} · {bot.isActive ? '●' : '○'}{' '}
                      {bot.isActive ? t('agentBots.is_active') : ''}
                    </p>
                  </div>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {bot.inboxCount} {t('agentBots.inbox_count')}
                  </span>
                </div>
                <dl className="grid gap-1 text-xs sm:grid-cols-[8rem_1fr]" data-testid={`bot-${bot.id}-profile`}>
                  <dt className="font-medium">{t('agentBots.persona')}</dt>
                  <dd className="line-clamp-2 text-muted-foreground">{bot.description || bot.systemPrompt}</dd>
                  <dt className="font-medium">{t('agentBots.knowledge_tags')}</dt>
                  <dd className="text-muted-foreground">
                    {bot.knowledgeTags.length > 0
                      ? t('agentBots.knowledge_base_tags', {
                          tags: bot.knowledgeTags.join(', '),
                          count: bot.knowledgeArticleCount,
                        })
                      : t('agentBots.knowledge_base_all', { count: bot.knowledgeArticleCount })}
                  </dd>
                </dl>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('agentBots.cost_last_24h')}: $
                    {bot.costLast24hUsd.toFixed(4)} /{' '}
                    ${bot.dailyBudgetUsd.toFixed(2)}
                  </p>
                  <div className="mt-1 h-1.5 w-full rounded bg-secondary">
                    <div
                      className="h-1.5 rounded bg-primary"
                      style={{ width: `${budgetPct}%` }}
                    />
                  </div>
                </div>
              </li>
            )
          })}
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
