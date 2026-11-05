'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { ProtocolHistoryDTO } from '@cosmika/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'

/**
 * The service protocol in the conversation header, and the case behind it:
 * one timeline of what the contact said on every channel under the same
 * protocol (Webchat yesterday, WhatsApp today), so nobody asks twice.
 */
export function ProtocolBadge({
  conversationId,
  protocol,
}: {
  conversationId: string
  protocol: string | null | undefined
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [open, setOpen] = React.useState(false)
  const [history, setHistory] = React.useState<ProtocolHistoryDTO | null>(null)

  React.useEffect(() => {
    if (!open || !session) return
    setHistory(null)
    api
      .getProtocolHistory(session.session.token, session.account.id, conversationId)
      .then(setHistory)
      .catch(() => setHistory({ protocol: protocol ?? null, conversations: [], messages: [] }))
  }, [open, session, conversationId, protocol])

  if (!protocol) return null
  const channel = (c: string) => t(`inboxes.channel_${c.toLowerCase()}` as never)
  const time = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] font-mono"
        data-testid="protocol-badge"
        title={t('protocol.open_history')}
        onClick={() => setOpen(true)}
      >
        {t('protocol.label')} {protocol}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t('common.close')} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('protocol.history_title', { protocol })}</DialogTitle>
            <DialogDescription>{t('protocol.history_help')}</DialogDescription>
          </DialogHeader>
          {!history ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <div className="space-y-3">
              <ul className="flex flex-wrap gap-2 text-xs" data-testid="protocol-conversations">
                {history.conversations.map((c) => (
                  <li key={c.id} className="rounded border border-border px-2 py-1">
                    <span className="font-medium">{channel(c.channelType)}</span> · #{c.displayId} ·{' '}
                    {time(c.createdAt)}
                  </li>
                ))}
              </ul>
              <ol className="max-h-[50vh] space-y-1.5 overflow-y-auto text-sm" data-testid="protocol-timeline">
                {history.messages.map((m) => (
                  <li key={m.id} className="rounded-md bg-muted/40 px-2 py-1.5">
                    <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {channel(m.channelType)} · {time(m.createdAt)} ·{' '}
                      {m.senderType === 'CONTACT' ? t('protocol.from_contact') : t('protocol.from_us')}
                    </span>
                    <span className="whitespace-pre-wrap">{m.content ?? `[${m.contentType.toLowerCase()}]`}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
