'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@cosmika/ui'

import { canAccessPath, type Role } from '../lib/role-access'
import { useStoredSession } from '../lib/session-store'

type NavItem = {
  href: string
  /** i18n key under `settings.nav`. */
  labelKey: string
  /** Roles that can actually USE the destination; absent = everyone. An
      entry whose page (or list endpoint) 403s a role is hidden from that
      role — a door that only opens onto an error is worse than no door. */
  roles?: Role[]
}

const ITEMS: NavItem[] = [
  { href: '/settings/profile', labelKey: 'settings.nav.profile' },
  { href: '/settings/security', labelKey: 'settings.nav.security' },
  // Account renders a read-only explainer for supervisors on purpose. Agents
  // keep only their own pages here (profile, security, availability): the
  // rest is filtered by canAccessPath (item 12).
  { href: '/settings/account', labelKey: 'settings.nav.account' },
  { href: '/settings/members', labelKey: 'settings.nav.members' },
  { href: '/settings/billing', labelKey: 'settings.nav.billing' },
  { href: '/settings/custom-attributes', labelKey: 'settings.nav.customAttributes' },
  { href: '/settings/availability', labelKey: 'settings.nav.availability' },
  { href: '/settings/sla', labelKey: 'settings.nav.sla' },
  // list endpoints are admin-only: the page is a guaranteed 403 otherwise.
  { href: '/settings/webhooks', labelKey: 'settings.nav.webhooks', roles: ['ADMINISTRATOR'] },
  { href: '/settings/api-keys', labelKey: 'settings.nav.apiKeys', roles: ['ADMINISTRATOR'] },
  // import, export and audit log take admin or supervisor; agents get a 403.
  {
    href: '/settings/contacts-import',
    labelKey: 'settings.nav.contactsImport',
    roles: ['ADMINISTRATOR', 'SUPERVISOR'],
  },
  {
    href: '/settings/data-export',
    labelKey: 'settings.nav.dataExport',
    roles: ['ADMINISTRATOR', 'SUPERVISOR'],
  },
  {
    href: '/settings/audit-log',
    labelKey: 'settings.nav.auditLog',
    roles: ['ADMINISTRATOR', 'SUPERVISOR'],
  },
  // Not a settings page, but the only route to it on a phone: the assistant
  // lives in the desktop sidebar, and the mobile bottom bar is full at five
  // items. Settings is reachable on every viewport, so it carries the link
  // rather than displacing something an agent uses all day.
  { href: '/assistant', labelKey: 'settings.nav.assistant', roles: ['ADMINISTRATOR'] },
]

export function SettingsNav() {
  const t = useTranslations()
  const pathname = usePathname() ?? ''
  const { session } = useStoredSession()
  // Optional chaining fails closed: an unreadable membership hides every
  // role-gated entry rather than offering a door that 403s.
  const role = session?.membership?.role as Role | undefined

  return (
    <nav className="border-b border-border bg-card/40">
      <div className="mx-auto max-w-5xl px-6">
        <ul className="flex flex-wrap gap-1 py-2">
          {ITEMS.filter(
            (it) => (!it.roles || (role && it.roles.includes(role))) && canAccessPath(role, it.href),
          ).map((it) => {
            const active = pathname.startsWith(it.href)
            return (
              <li key={it.href}>
                <a
                  href={it.href}
                  data-testid={`settings-nav-${it.href.split('/').pop()}`}
                  className={cn(
                    'inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-subtle text-foreground'
                      : 'text-muted-foreground hover:bg-subtle/60 hover:text-foreground',
                  )}
                >
                  {t(it.labelKey)}
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
