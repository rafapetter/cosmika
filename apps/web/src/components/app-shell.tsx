'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  ThemeToggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  initialsOf,
} from '@cosmika/ui'
import {
  Bookmark,
  Bot,
  BookOpenCheck,
  BookOpen,
  Building2,
  ChevronsUpDown,
  Inbox,
  LogOut,
  Megaphone,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PieChart,
  Settings,
  Share2,
  Sparkles,
  Tag,
  Tags,
  Ticket,
  UserCircle2,
  Users,
  Workflow,
} from 'lucide-react'

import { api, ApiError } from '../lib/api'
import { canAccessPath } from '../lib/role-access'
import { clearSession, useStoredSession } from '../lib/session-store'

import { NotificationsBell } from './notifications-bell'
import { SlaAlarm } from './sla-alarm'
import { MobileNav } from './mobile-nav'
import { UsageBanner } from './usage-banner'

type NavKey =
  | 'inbox'
  | 'conversations'
  | 'contacts'
  | 'channels'
  | 'agents'
  | 'teams'
  | 'reports'
  | 'automation'
  | 'flows'
  | 'canned'
  | 'broadcasts'
  | 'labels'
  | 'knowledge'
  | 'tickets'
  | 'assistant'

type NavItem = {
  key: NavKey
  href: string
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  /** Hidden from anyone who couldn't use the page anyway. */
  adminOnly?: boolean
}

const NAV: NavItem[] = [
  { key: 'inbox',         href: '/inbox',         icon: Inbox,         labelKey: 'inbox.title' },
  { key: 'conversations', href: '/conversations', icon: MessageSquare, labelKey: 'conversations.title' },
  { key: 'contacts',      href: '/contacts',      icon: Users,         labelKey: 'contacts.title' },
  { key: 'channels',      href: '/inboxes',       icon: Tag,           labelKey: 'inboxes.title' },
  { key: 'agents',        href: '/agent-bots',    icon: Bot,           labelKey: 'agentBots.title' },
  { key: 'flows',         href: '/flows',         icon: Share2,        labelKey: 'flows.title' },
  { key: 'teams',         href: '/teams',         icon: BookOpenCheck, labelKey: 'teams.title' },
  { key: 'automation',    href: '/automation',    icon: Workflow,      labelKey: 'automation.title' },
  { key: 'canned',        href: '/canned-responses', icon: Bookmark,   labelKey: 'cannedResponses.title' },
  { key: 'broadcasts',    href: '/broadcasts',    icon: Megaphone,     labelKey: 'broadcasts.title' },
  { key: 'labels',        href: '/labels',        icon: Tags,          labelKey: 'labels.title' },
  { key: 'knowledge',     href: '/knowledge-base', icon: BookOpen,     labelKey: 'knowledgeBase.title' },
  { key: 'tickets',       href: '/tickets',       icon: Ticket,        labelKey: 'tickets.title' },
  { key: 'reports',       href: '/reports',       icon: PieChart,      labelKey: 'reports.title' },
  { key: 'assistant',     href: '/assistant',     icon: Sparkles,      labelKey: 'assistant.title', adminOnly: true },
]

const SIDEBAR_KEY = 'cosmika.sidebar-collapsed'

const MOBILE_BREAKPOINT_PX = 768

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = React.useState<boolean>(false)
  const [userToggled, setUserToggled] = React.useState(false)
  React.useEffect(() => {
    // Persisted preference wins if the user has ever toggled. Otherwise we
    // auto-collapse on narrow screens and expand on wide ones.
    try {
      const persisted = window.localStorage.getItem(SIDEBAR_KEY)
      if (persisted === '0' || persisted === '1') {
        setCollapsed(persisted === '1')
        setUserToggled(true)
        return
      }
    } catch {
      /* ignore */
    }
    const apply = () => {
      setCollapsed(window.innerWidth < MOBILE_BREAKPOINT_PX)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
    setUserToggled(true)
  }, [])
  return { collapsed, toggle, userToggled }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const { session, ready } = useStoredSession()
  const [signingOut, setSigningOut] = React.useState(false)
  const { collapsed, toggle } = useSidebarCollapsed()

  React.useEffect(() => {
    if (ready && !session) router.replace('/sign-in')
  }, [ready, session, router])

  // Mirror the account's defaultLocale to the `cosmika_locale` cookie so the
  // server-side next-intl resolver picks pt-BR / es / en based on the signed-
  // in account, not the browser's Accept-Language. Defensively normalize
  // legacy/Nebula-migrated values (e.g. "16" = pt-BR enum) so we never write
  // a non-Cosmika locale to the cookie. Refreshes the route once when the
  // cookie value actually changes — no-op on subsequent renders.
  React.useEffect(() => {
    if (!ready || !session?.account?.defaultLocale) return
    const raw = session.account.defaultLocale
    const VALID = ['pt-BR', 'es', 'en'] as const
    const NEBULA_MAP: Record<string, (typeof VALID)[number]> = {
      '0': 'en',
      '9': 'pt-BR',
      '12': 'es',
      '16': 'pt-BR',
    }
    const target = (VALID as readonly string[]).includes(raw)
      ? (raw as (typeof VALID)[number])
      : (NEBULA_MAP[raw] ?? 'pt-BR')
    const current = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('cosmika_locale='))
      ?.split('=')[1]
    if (current === target) return
    // 1-year cookie, path=/, samesite=lax — same shape as next-intl examples.
    document.cookie = `cosmika_locale=${target}; path=/; max-age=31536000; samesite=lax`
    router.refresh()
  }, [ready, session, router])

  async function onSignOut() {
    if (!session) return
    setSigningOut(true)
    try {
      await api.signOut(session.session.token)
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err)
    }
    clearSession()
    router.replace('/sign-in')
  }

  if (!ready || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    )
  }

  const userName = session.user.fullName ?? session.user.email
  const accountInitial =
    session.account.name?.[0]?.toUpperCase() ?? 'C'
  // Optional chaining fails closed: an unreadable membership hides the
  // admin-only entries rather than crashing the shell or showing them.
  const isAdmin = session.membership?.role === 'ADMINISTRATOR'
  // Operators see the queue, not the workspace's configuration (item 12).
  const role = session.membership?.role
  const allowed = (href: string) => canAccessPath(role, href)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar — hidden on mobile, replaced by bottom-nav */}
      <aside
        className={cn(
          'hidden flex-shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 ease-out md:flex',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        {/* Account switcher (single-account for now) */}
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggle}
                className="flex h-14 w-14 items-center justify-center border-b border-border hover:bg-subtle/50"
                aria-label={session.account.name}
                data-testid="account-switcher"
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                  {accountInitial}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{session.account.name}</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex w-full items-center gap-2 border-b border-border px-3 py-3 text-left hover:bg-subtle/50 focus-visible:outline-none focus-visible:bg-subtle/80"
                data-testid="account-switcher"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                  {accountInitial}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {session.account.name}
                  </p>
                  <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                    {session.account.plan}
                  </p>
                </div>
                <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>{t('inbox.title')}</DropdownMenuLabel>
              <DropdownMenuItem disabled>{session.account.name}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="space-y-0.5">
            {NAV.filter((item) => (!item.adminOnly || isAdmin) && allowed(item.href)).map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== '/inbox' && pathname.startsWith(item.href))
              const Icon = item.icon
              const link = (
                <a
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-md py-1.5 text-sm transition-colors',
                    collapsed ? 'justify-center px-0' : 'px-2.5',
                    active
                      ? 'bg-subtle text-foreground'
                      : 'text-muted-foreground hover:bg-subtle/60 hover:text-foreground',
                  )}
                  data-testid={`nav-${item.key}`}
                  aria-label={t(item.labelKey)}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {collapsed ? null : (
                    <span className="truncate">{t(item.labelKey)}</span>
                  )}
                </a>
              )
              return (
                <li key={item.key}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">
                        {t(item.labelKey)}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              )
            })}
          </ul>
        </nav>

        <Separator />

        {/* Footer */}
        <div
          className={cn(
            'flex items-center gap-1 p-2',
            collapsed && 'flex-col gap-2',
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggle}
                aria-label={collapsed ? t('shell.expand_sidebar') : t('shell.collapse_sidebar')}
                data-testid="sidebar-toggle"
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? t('shell.expand') : t('shell.collapse')}
            </TooltipContent>
          </Tooltip>
          <NotificationsBell />
          <SlaAlarm />
          <ThemeToggle
            labels={{
              toggle: t('shell.theme_toggle'),
              light: t('shell.theme_light'),
              dark: t('shell.theme_dark'),
              system: t('shell.theme_system'),
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'flex items-center gap-2 rounded-md p-1 hover:bg-subtle/70 focus-visible:outline-none focus-visible:bg-subtle',
                  collapsed ? '' : 'ml-auto',
                )}
                data-testid="user-menu"
                aria-label={userName}
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback>{initialsOf(userName)}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {session.user.fullName ?? session.user.email}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {session.user.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href="/settings/profile">
                  <UserCircle2 className="h-4 w-4" /> {t('shell.menu_profile')}
                </a>
              </DropdownMenuItem>
              {allowed('/settings/account') ? (
                <DropdownMenuItem asChild>
                  <a href="/settings/account">
                    <Building2 className="h-4 w-4" /> {t('shell.menu_account')}
                  </a>
                </DropdownMenuItem>
              ) : null}
              {allowed('/inboxes') ? (
                <DropdownMenuItem asChild>
                  <Link href="/inboxes">
                    <Settings className="h-4 w-4" /> {t('shell.menu_channels')}
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onSignOut}
                disabled={signingOut}
                destructive
                data-testid="sign-out"
              >
                <LogOut className="h-4 w-4" />
                {signingOut ? t('common.loading') : t('auth.sign_out')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Account-wide usage notice. Renders nothing for agents, and
            nothing at all when there is nothing to say. */}
        <UsageBanner />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {allowed(pathname) ? children : <NoAccess />}
        </div>
        <MobileNav />
      </main>
    </div>
  )
}

/** A typed URL to an area this role cannot open. */
function NoAccess() {
  const t = useTranslations()
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-testid="no-access">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-lg font-semibold">{t('shell.no_access_title')}</h1>
        <p className="text-sm text-muted-foreground">{t('shell.no_access_body')}</p>
        <Button asChild variant="outline" size="sm">
          <a href="/inbox">{t('shell.no_access_back')}</a>
        </Button>
      </div>
    </div>
  )
}

// Keep symbol referenced — Sparkles was previously in footer, now elsewhere.
void Sparkles
