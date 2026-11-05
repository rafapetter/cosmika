'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Inbox, MessageSquare, Search, Settings, Users } from 'lucide-react'
import { cn } from '@cosmika/ui'

import { useStoredSession } from '../lib/session-store'

// Short labels: the tab bar is five 10px columns on a phone.
const ITEMS = [
  { id: 'inbox', href: '/inbox', labelKey: 'shell.mobile_inbox', icon: Inbox },
  { id: 'chats', href: '/conversations', labelKey: 'shell.mobile_chats', icon: MessageSquare },
  { id: 'contacts', href: '/contacts', labelKey: 'shell.mobile_contacts', icon: Users },
  { id: 'kb', href: '/knowledge-base', labelKey: 'shell.mobile_kb', icon: Search },
  { id: 'settings', href: '/settings/profile', labelKey: 'shell.mobile_settings', icon: Settings },
]

/**
 * Bottom tab bar shown below the md breakpoint. The left-side icon sidebar
 * is also hidden in that range — this replaces it.
 */
export function MobileNav() {
  const t = useTranslations()
  const pathname = usePathname() ?? ''
  // An operator's "settings" tab only holds their own account (item 12).
  const isAgent = useStoredSession().session?.membership?.role === 'AGENT'
  return (
    <nav className="flex shrink-0 items-stretch border-t border-border bg-surface md:hidden">
      {ITEMS.map((it) => {
        const active = pathname.startsWith(it.href)
        const Icon = it.icon
        return (
          <a
            key={it.href}
            href={it.href}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px]',
              active ? 'text-foreground' : 'text-muted-foreground',
            )}
            data-testid={`mobile-nav-${it.id}`}
          >
            <Icon className="h-5 w-5" />
            <span>
              {t((it.id === 'settings' && isAgent ? 'shell.mobile_my_account' : it.labelKey) as never)}
            </span>
          </a>
        )
      })}
    </nav>
  )
}
