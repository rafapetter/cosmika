'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, X } from 'lucide-react'

import { api, type UsageDTO } from '../lib/api'
import { useStoredSession } from '../lib/session-store'

export function dismissedKey(accountId: string, state: string): string {
  return `cosmika.usage.dismissed.${accountId}.${state}`
}

function readDismissed(accountId: string, state: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(accountId, state)) === '1'
  } catch {
    return false
  }
}

/** The one line the banner shows, per state. Null = nothing to say. */
export function bannerKey(usage: UsageDTO): string | null {
  const ai = usage.ai
  const aiCounted = ai.included !== null
  const aiOut = aiCounted && ai.conversations >= (ai.included as number)
  // The AI cases lead, because they are the ones where behaviour changes for
  // the contact: on a plan with no AI overage, new conversations stop being
  // answered by the AI and go to the team.
  if (aiOut && ai.overagePriceBrl === null) return 'banner_ai_upgrade'
  if (usage.state === 'upgrade') return 'banner_upgrade'
  if (usage.state === 'overage') return 'banner_overage'
  if (aiCounted && ai.conversations >= (ai.included as number) * 0.8) {
    return 'banner_ai_warn'
  }
  if (usage.state === 'warn') return 'banner_warn'
  return null
}

/**
 * Account-wide usage notice, shown above every page.
 *
 * Only to people who can act on it: an agent cannot change a plan or a
 * ceiling, so telling them their employer's account is near a limit is noise
 * in the middle of their work. Administrators and supervisors get one line
 * and a link to the usage screen.
 *
 * Nothing here blocks anything, and the wording is careful about that: the
 * published terms promise that no conversation is ever refused for being over
 * a cap, and an alarming banner is how a customer comes to believe otherwise.
 *
 * Dismissal is per state, in this browser: dismissing "near a limit" does not
 * hide the later "limit reached", which is a different thing to know.
 */
export function UsageBanner() {
  const t = useTranslations('usageLimits')
  const { session } = useStoredSession()
  const [usage, setUsage] = useState<UsageDTO | null>(null)
  // States dismissed in this view. Persisted ones are read straight from
  // storage during render rather than through an effect, so a banner the
  // customer already closed never flashes on the way to being hidden.
  const [closed, setClosed] = useState<string[]>([])

  const accountId = session?.account.id
  const token = session?.session.token
  const role = session?.membership.role
  const canSee = role === 'ADMINISTRATOR' || role === 'SUPERVISOR'

  useEffect(() => {
    if (!accountId || !token || !canSee) return
    let live = true
    void (async () => {
      try {
        const u = await api.getUsage(token, accountId)
        if (live) setUsage(u)
      } catch {
        // A usage read that fails is not worth a word to the customer: the
        // banner simply does not appear.
      }
    })()
    return () => {
      live = false
    }
  }, [accountId, token, canSee])

  const key = usage ? bannerKey(usage) : null
  const dismissed =
    key !== null &&
    accountId !== undefined &&
    (closed.includes(key) || readDismissed(accountId, key))

  if (!usage || !key || dismissed) return null

  const upgrade = key === 'banner_upgrade' || key === 'banner_ai_upgrade'

  return (
    <div
      className={`flex items-start gap-3 border-b px-4 py-2 text-xs ${
        upgrade
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
          : 'border-border bg-muted/50 text-muted-foreground'
      }`}
      data-testid="usage-banner"
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">{t(key)}</p>
      <Link
        href="/settings/billing"
        className="inline-flex shrink-0 items-center gap-1 font-medium underline"
      >
        {t('banner_link')}
        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      </Link>
      <button
        type="button"
        aria-label={t('banner_dismiss')}
        className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
        onClick={() => {
          setClosed((prev) => [...prev, key])
          try {
            window.localStorage.setItem(dismissedKey(accountId!, key), '1')
          } catch {
            // Private mode or blocked storage: the banner comes back on the
            // next load, which is a good deal better than crashing the shell.
          }
        }}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
