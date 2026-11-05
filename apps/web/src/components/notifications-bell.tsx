'use client'

import * as React from 'react'
import { Bell, CheckCheck } from 'lucide-react'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  initialsOf,
} from '@cosmika/ui'
import type { NotificationDTO } from '@cosmika/shared'

import { api } from '../lib/api'
import { useDateTime, type DateTimeTools } from '../lib/format-datetime'
import { useStoredSession } from '../lib/session-store'

const POLL_INTERVAL_MS = 30_000

type T = ReturnType<typeof useTranslations>

export function NotificationsBell() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [unread, setUnread] = React.useState(0)
  const [items, setItems] = React.useState<NotificationDTO[] | null>(null)
  const [open, setOpen] = React.useState(false)

  const refreshCount = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.notificationCounts(
        session.session.token,
        session.account.id,
      )
      setUnread(r.unread)
    } catch {
      /* keep silent */
    }
  }, [session])

  const refreshList = React.useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listNotifications(
        session.session.token,
        session.account.id,
        { limit: 15 },
      )
      setItems(r)
    } catch {
      setItems([])
    }
  }, [session])

  React.useEffect(() => {
    if (!session) return
    void refreshCount()
    const id = window.setInterval(refreshCount, POLL_INTERVAL_MS)
    // Coming back to the tab is when someone actually looks at the bell, and
    // a background tab can be a whole interval behind (browsers also throttle
    // timers there). Checking on focus makes the common case feel immediate
    // without opening a socket for it.
    const onFocus = () => void refreshCount()
    window.addEventListener('focus', onFocus)
    // The SLA alarm asks for a refresh the moment a breach lands.
    window.addEventListener('cosmika:notifications-refresh', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('cosmika:notifications-refresh', onFocus)
    }
  }, [session, refreshCount])

  // Pull list when the dropdown opens.
  React.useEffect(() => {
    if (open) void refreshList()
  }, [open, refreshList])

  async function onItemClick(n: NotificationDTO) {
    if (!session) return
    if (!n.readAt) {
      try {
        await api.markNotificationRead(
          session.session.token,
          session.account.id,
          n.id,
        )
      } catch {
        /* silent */
      }
    }
    if (n.conversationId) {
      window.location.href = `/conversations/${n.conversationId}`
    }
    void refreshCount()
  }

  async function onMarkAllRead() {
    if (!session) return
    try {
      await api.markAllNotificationsRead(
        session.session.token,
        session.account.id,
      )
    } catch {
      /* silent */
    }
    void refreshCount()
    void refreshList()
  }

  if (!session) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle/70 hover:text-foreground focus-visible:outline-none focus-visible:bg-subtle"
              aria-label={t('notifications.title')}
              data-testid="notifications-bell"
            >
              <Bell className="h-4 w-4" />
              {unread > 0 ? (
                <span
                  className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
                  data-testid="notifications-badge"
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">
          {unread > 0 ? t('notifications.unread', { count: unread }) : t('notifications.title')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="px-0 py-0">
            {t('notifications.title')}
          </DropdownMenuLabel>
          {unread > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={onMarkAllRead}
              data-testid="mark-all-read"
            >
              <CheckCheck className="h-3 w-3" /> {t('notifications.mark_all_read')}
            </Button>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        {items === null ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : items.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {t('notifications.empty')}
          </p>
        ) : (
          items.map((n) => (
            <DropdownMenuItem
              key={n.id}
              onClick={() => onItemClick(n)}
              className={cn(
                'flex items-start gap-2 px-2 py-2',
                !n.readAt && 'bg-primary-subtle/40',
              )}
              data-testid={`notification-${n.id}`}
            >
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarFallback className="text-[10px]">
                  {initialsOf(
                    n.mentionedBy?.fullName ?? n.mentionedBy?.email ?? '?',
                  )}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">
                  {/*
                    Automatic distribution has no actor, so naming one would
                    invent a person. Those rows lead with the sentence instead
                    of a name.
                  */}
                  {n.mentionedBy ? (
                    <>
                      <span className="font-medium">
                        {n.mentionedBy.fullName ?? n.mentionedBy.email}
                      </span>{' '}
                      {n.type === 'ASSIGNMENT'
                        ? t('notifications.assigned_you')
                        : t('notifications.mentioned_you')}
                    </>
                  ) : n.type === 'ASSIGNMENT' ? (
                    t('notifications.assigned_you_auto')
                  ) : n.type === 'ASSIGNMENT_FALLBACK' ? (
                    // No author and no name: nobody caused this, and the row
                    // does not carry who received it. Opening it shows that.
                    t('notifications.assigned_off_shift')
                  ) : n.type === 'SLA_BREACH' ? (
                    t('notifications.sla_breached')
                  ) : (
                    <>
                      <span className="font-medium">
                        {t('notifications.someone')}
                      </span>{' '}
                      {t('notifications.mentioned_you')}
                    </>
                  )}
                  {n.conversation ? (
                    <>
                      {' '}
                      {t('notifications.in')}{' '}
                      <span className="text-muted-foreground">
                        #{n.conversation.displayId}
                      </span>
                    </>
                  ) : null}
                </p>
                {n.messagePreview ? (
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                    {n.messagePreview}
                  </p>
                ) : null}
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {formatRel(t, fmt, n.createdAt)}
                </p>
              </div>
              {!n.readAt ? (
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatRel(t: T, fmt: DateTimeTools, iso: string) {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return t('notifications.just_now')
  if (diff < 3600) return t('notifications.minutes_ago', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('notifications.hours_ago', { n: Math.floor(diff / 3600) })
  return fmt.dateShort(d)
}
