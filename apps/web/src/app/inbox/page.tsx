'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import {
  Bot,
  Inbox as InboxIcon,
  MessageSquare,
  PieChart,
  Tag,
  Users,
  Workflow,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@cosmika/ui'

import { OnboardingChecklist } from '../../components/onboarding-checklist'
import { OnboardingProfilePrompt } from '../../components/onboarding-profile-prompt'
import { api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'

type DashStats = {
  openConversations: number | string
  totalConversations: number | string
  inboxes: number | string
}

export default function DashboardPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [stats, setStats] = useState<DashStats | null>(null)

  useEffect(() => {
    if (!session) return
    Promise.all([
      api
        .reportsOverview(session.session.token, session.account.id, {})
        .catch(() => null),
      api.listInboxes(session.session.token, session.account.id).catch(() => []),
    ]).then(([overview, inboxes]) => {
      setStats({
        openConversations: overview?.statusCounts.open ?? '-',
        totalConversations: overview?.totalConversations ?? '-',
        inboxes: Array.isArray(inboxes) ? inboxes.length : '-',
      })
    })
  }, [session])

  if (!session) return null

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-8 space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('inbox.welcome')}, {session.user.fullName ?? session.user.email}
          </h1>
          <p className="text-sm text-muted-foreground">
            {session.account.name} · {t(`members.role_${session.membership.role.toLowerCase()}` as never)}
          </p>
        </header>

        <OnboardingProfilePrompt />
        <OnboardingChecklist />

        {/* Stat strip */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            icon={MessageSquare}
            label={t('conversations.status_open')}
            value={stats?.openConversations ?? '-'}
            href="/conversations"
          />
          <Stat
            icon={InboxIcon}
            label={t('conversations.title')}
            value={stats?.totalConversations ?? '-'}
            href="/conversations"
          />
          <Stat
            icon={Tag}
            label={t('inboxes.title')}
            value={stats?.inboxes ?? '-'}
            href="/inboxes"
          />
        </div>

        {/* Shortcuts grid */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t('inbox.quick_actions')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Shortcut
              href="/conversations"
              icon={InboxIcon}
              title={t('conversations.title')}
              body={t('conversations.subtitle')}
            />
            <Shortcut
              href="/contacts"
              icon={Users}
              title={t('contacts.title')}
              body={t('contacts.subtitle')}
            />
            <Shortcut
              href="/inboxes"
              icon={Tag}
              title={t('inboxes.title')}
              body={t('inboxes.subtitle')}
            />
            <Shortcut
              href="/agent-bots"
              icon={Bot}
              title={t('agentBots.title')}
              body={t('agentBots.subtitle')}
            />
            <Shortcut
              href="/automation"
              icon={Workflow}
              title={t('automation.title')}
              body={t('automation.subtitle')}
            />
            <Shortcut
              href="/reports"
              icon={PieChart}
              title={t('reports.title')}
              body={t('reports.subtitle')}
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
  href: string
}) {
  return (
    <a href={href} className="block">
      <Card className="transition-colors hover:bg-muted/40">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <p className="text-2xl font-semibold leading-none">{value}</p>
            <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
          </div>
        </CardContent>
      </Card>
    </a>
  )
}

function Shortcut({
  href,
  icon: Icon,
  title,
  body,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
}) {
  return (
    <a href={href} className="group block">
      <Card className="h-full transition-colors group-hover:bg-muted/40">
        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-subtle text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-sm">{title}</CardTitle>
            <CardDescription className="mt-1 line-clamp-2 text-xs">
              {body}
            </CardDescription>
          </div>
        </CardHeader>
      </Card>
    </a>
  )
}
