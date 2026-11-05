'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  Clock,
  CornerUpLeft,
  Download,
  ListChecks,
  Lock,
  MousePointerClick,
  Paperclip,
  Reply,
  SmilePlus,
  Sparkles,
} from 'lucide-react'
import { cn } from '@cosmika/ui'
import type { MessageDTO } from '@cosmika/shared'

import { API_BASE } from '../../../lib/api'
import { activityText, type Translate } from '../../../lib/activity-text'
import { reactionsOf, withoutStaleDrafts } from '../../../lib/optimistic-messages'
import { renderWhatsAppFormatting, stripWhatsAppFormatting } from '../../../lib/whatsapp-format'
import { useDateTime, type DateTimeTools } from '../../../lib/format-datetime'
import { useStoredSession } from '../../../lib/session-store'

/**
 * WhatsApp-fidelity thread.
 *
 * Layout rules:
 *   - inbound (CONTACT) → left, white bubble, tail-left on FIRST of a group
 *   - outbound (USER / AGENT_BOT) → right, mint bubble, tail-right on FIRST
 *   - private notes → right, yellow bubble, "Internal" pill
 *   - SYSTEM → centered pill
 *
 * Grouping rules:
 *   - same sender within 60s → tight stack (no extra spacing)
 *   - else → group break (extra vertical gap)
 *   - tail rendered on first message of each group only
 *
 * Background: subtle dotted pattern overlaid on the chat canvas color.
 */

type Side = 'left' | 'right' | 'center'

function sideOf(m: MessageDTO): Side {
  if (m.senderType === 'SYSTEM') return 'center'
  if (m.senderType === 'CONTACT') return 'left'
  return 'right'
}

function dayLabel(
  d: Date,
  fmt: DateTimeTools,
  labels: { today: string; yesterday: string },
) {
  // Day boundaries follow the account's zone, so "today" is the same day for
  // everyone on the account.
  const now = new Date()
  if (fmt.dayKey(d) === fmt.dayKey(now)) return labels.today
  const yest = new Date(now.getTime() - 86_400_000)
  if (fmt.dayKey(d) === fmt.dayKey(yest)) return labels.yesterday
  const sameYear = fmt.date(d, { year: 'numeric' }) === fmt.date(now, { year: 'numeric' })
  return fmt.date(d, {
    weekday: sameYear ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  })
}

type GroupedItem =
  | { type: 'day'; key: string; label: string }
  | {
      type: 'message'
      message: MessageDTO
      side: Side
      isFirstOfGroup: boolean
      isLastOfGroup: boolean
    }

function buildItems(
  messages: MessageDTO[],
  fmt: DateTimeTools,
  dayLabels: { today: string; yesterday: string },
): GroupedItem[] {
  const groupKeys: number[] = []
  let currentGroup = 0
  let lastDay: string | null = null
  let lastSenderKey: string | null = null
  let lastTime = 0
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!
    const d = new Date(m.createdAt)
    const t = d.getTime()
    const sKey = m.isPrivate ? `private:${m.senderType}` : m.senderType
    const dKey = fmt.dayKey(d)
    const sameGroup =
      lastDay === dKey &&
      lastSenderKey === sKey &&
      t - lastTime < 60_000
    if (!sameGroup) currentGroup += 1
    groupKeys.push(currentGroup)
    lastDay = dKey
    lastSenderKey = sKey
    lastTime = t
  }
  const items: GroupedItem[] = []
  lastDay = null
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!
    const d = new Date(m.createdAt)
    const dKey = fmt.dayKey(d)
    if (lastDay !== dKey) {
      items.push({ type: 'day', key: dKey, label: dayLabel(d, fmt, dayLabels) })
      lastDay = dKey
    }
    const gThis = groupKeys[i]!
    const gPrev = i > 0 ? groupKeys[i - 1] : null
    const gNext = i < messages.length - 1 ? groupKeys[i + 1] : null
    items.push({
      type: 'message',
      message: m,
      side: sideOf(m),
      isFirstOfGroup: gThis !== gPrev,
      isLastOfGroup: gThis !== gNext,
    })
  }
  return items
}

function bubbleClasses(m: MessageDTO, isFirstOfGroup: boolean): string {
  const base =
    'inline-block max-w-[72%] px-3 py-1.5 text-sm leading-snug shadow-xs'
  let radius: string
  if (m.senderType === 'CONTACT') {
    radius = isFirstOfGroup ? 'rounded-2xl rounded-tl-md' : 'rounded-2xl'
  } else {
    radius = isFirstOfGroup ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl'
  }
  if (m.isPrivate) {
    return cn(base, radius, 'bg-chat-private text-chat-bubble-foreground')
  }
  if (m.senderType === 'CONTACT') {
    return cn(base, radius, 'bg-chat-inbound text-chat-bubble-foreground')
  }
  return cn(base, radius, 'bg-chat-outbound text-chat-bubble-foreground')
}

const PATTERN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><g fill='%23000' fill-opacity='0.03'><circle cx='8' cy='8' r='1'/><circle cx='32' cy='24' r='1'/><circle cx='48' cy='12' r='1'/><circle cx='16' cy='40' r='1'/><circle cx='44' cy='52' r='1'/><circle cx='56' cy='36' r='1'/></g></svg>`,
)}")`

const DRAFT_PREFIX = '[draft] '

/**
 * An AI-suggested reply awaiting a human. The orchestrator writes these in
 * DRAFT mode, and in AUTO_SAFE whenever the reply scores below the bot's
 * confidence threshold — structural signal, not a string match, so a plain
 * internal note from a flow (status SENT) is never mistaken for one.
 */
export function isAgentDraft(m: MessageDTO): boolean {
  return m.isPrivate && m.senderType === 'AGENT_BOT' && m.status === 'PENDING'
}

/** The suggestion itself, without the marker the backend stores. */
export function draftBody(m: MessageDTO): string {
  const c = m.content ?? ''
  return c.startsWith(DRAFT_PREFIX) ? c.slice(DRAFT_PREFIX.length) : c
}

export function Thread({
  messages,
  meName,
  onReply,
  onUseDraft,
  onEditDraft,
  onDiscardDraft,
  onReact,
  onRetry,
  conversationId,
}: {
  messages: MessageDTO[]
  meName: string
  onReply: (m: MessageDTO) => void
  /** Send an AI suggestion to the contact as it is. */
  onUseDraft?: (messageId: string, text: string) => void
  /** Load an AI suggestion into the composer to change it before sending. */
  onEditDraft?: (messageId: string, text: string) => void
  /**
   * Put our reaction on a message (`''` takes it off). Absent where
   * reactions can't be sent: other channels, or a closed conversation.
   */
  onReact?: (messageId: string, emoji: string) => void
  /** Drop an AI suggestion the agent doesn't want. */
  onDiscardDraft?: (messageId: string) => void
  /** Re-attempt delivery of a message that never reached the contact. */
  onRetry?: (messageId: string) => void
  conversationId: string
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const dayLabels = React.useMemo(
    () => ({ today: t('conversations.today'), yesterday: t('conversations.yesterday') }),
    [t],
  )
  // Lookup parent message by id for inline reply preview.
  const byId = React.useMemo(() => {
    const map = new Map<string, MessageDTO>()
    for (const m of messages) map.set(m.id, m)
    return map
  }, [messages])
  // Which option the contact picked for each bot question, so the operator
  // sees the offer and the answer together.
  const chosen = React.useMemo(() => chosenReplies(messages), [messages])
  // The message whose reaction picker is open, if any.
  const [reactingTo, setReactingTo] = React.useState<string | null>(null)
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  // A suggestion nobody used is hidden once the conversation moved past it.
  const shown = React.useMemo(() => withoutStaleDrafts(messages), [messages])
  const items = React.useMemo(
    () => buildItems(shown, fmt, dayLabels),
    [shown, fmt, dayLabels],
  )

  return (
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 overflow-y-auto bg-chat-canvas"
      style={{ backgroundImage: PATTERN }}
      data-testid="thread"
    >
      <div className="mx-auto max-w-3xl px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('conversations.no_messages')}</p>
          </div>
        ) : null}

        {items.map((it) => {
          if (it.type === 'day') {
            return (
              <div key={`day-${it.key}`} className="my-3 flex justify-center">
                <span className="rounded-md bg-chat-system px-2.5 py-0.5 text-[11px] font-medium text-chat-meta shadow-xs">
                  {it.label}
                </span>
              </div>
            )
          }
          const { message: m, side, isFirstOfGroup } = it

          if (side === 'center') {
            return (
              <div key={m.id} className="my-2 flex justify-center">
                <span className="rounded-md bg-chat-system px-2.5 py-1 text-[11px] text-chat-meta shadow-xs">
                  {activityText(t as unknown as Translate, m)}
                </span>
              </div>
            )
          }

          const wrap = cn(
            'flex',
            side === 'right' ? 'justify-end' : 'justify-start',
            isFirstOfGroup ? 'mt-2' : 'mt-0.5',
          )

          const parent = m.inReplyToId ? byId.get(m.inReplyToId) : null

          return (
            <div key={m.id} className={cn(wrap, 'group')}>
              {side === 'right' && onReact && canReactTo(m) ? (
                <ReactButton
                  open={reactingTo === m.id}
                  current={reactionsOf(m).business?.emoji ?? null}
                  label={t('conversations.react_button')}
                  removeLabel={t('conversations.reaction_remove')}
                  onToggle={() => setReactingTo((v) => (v === m.id ? null : m.id))}
                  onPick={(emoji) => {
                    setReactingTo(null)
                    onReact(m.id, emoji)
                  }}
                />
              ) : null}
              {/* Reply action — hidden until hover */}
              {side === 'right' ? (
                <button
                  type="button"
                  onClick={() => onReply(m)}
                  className="mr-1 mt-1 self-end rounded-full p-1 text-chat-meta opacity-0 transition-opacity hover:bg-foreground/5 group-hover:opacity-100"
                  aria-label={t('conversations.thread_reply_button')}
                >
                  <Reply className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <div className={bubbleClasses(m, isFirstOfGroup)}>
                {parent ? (
                  <div
                    className={cn(
                      'mb-1 cursor-pointer rounded border-l-2 border-primary px-2 py-1 text-[11px]',
                      m.senderType === 'CONTACT'
                        ? 'bg-foreground/5'
                        : 'bg-foreground/10',
                    )}
                    onClick={() => {
                      const el = document.getElementById(`msg-${parent.id}`)
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }}
                  >
                    <p className="flex items-center gap-1 text-primary">
                      <CornerUpLeft className="h-3 w-3" />
                      {parent.senderType === 'CONTACT'
                        ? t('conversations.inbound_label')
                        : parent.senderType === 'AGENT_BOT'
                          ? t('conversations.bot_label')
                          : t('conversations.you')}
                    </p>
                    <p className="line-clamp-2 break-words text-chat-bubble-foreground/80">
                      {parent.content ? stripWhatsAppFormatting(parent.content) : '-'}
                    </p>
                  </div>
                ) : null}
                {isFirstOfGroup && m.isPrivate && isAgentDraft(m) ? (
                  <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-primary">
                    <Sparkles className="h-3 w-3" /> {t('conversations.ai_draft_label')}
                  </p>
                ) : isFirstOfGroup && m.isPrivate ? (
                  <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
                    <Lock className="h-3 w-3" /> {t('conversations.thread_internal_note_label')}
                  </p>
                ) : null}
                {isFirstOfGroup && m.senderType === 'AGENT_BOT' && !m.isPrivate ? (
                  <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-primary">
                    {isAiWritten(m) ? (
                      <>
                        <Sparkles className="h-3 w-3" /> {t('conversations.ai_agent_label')}
                      </>
                    ) : (
                      <>
                        <Bot className="h-3 w-3" /> {t('conversations.bot_label')}
                      </>
                    )}
                  </p>
                ) : null}
                {isInteractiveReply(m) ? (
                  <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-chat-meta">
                    <MousePointerClick className="h-3 w-3" />{' '}
                    {t('conversations.interactive_reply_label')}
                  </p>
                ) : null}
                {attrs(m).rawType === 'reaction' ? (
                  // Stored as a message before reactions were understood.
                  <p className="italic text-chat-meta" id={`msg-${m.id}`}>
                    {t('conversations.reaction_legacy')}
                  </p>
                ) : m.content ? (
                  <p className="whitespace-pre-wrap break-words" id={`msg-${m.id}`}>
                    {renderWhatsAppFormatting(isAgentDraft(m) ? draftBody(m) : m.content, renderWithMentions)}
                  </p>
                ) : (
                  <span id={`msg-${m.id}`} />
                )}
                {interactiveOptions(m) ? (
                  <InteractiveOptions
                    offer={interactiveOptions(m)!}
                    chosenId={chosen.get(m.id) ?? null}
                    label={t('conversations.interactive_options_label')}
                    chosenLabel={t('conversations.interactive_chosen')}
                  />
                ) : null}
                {isAgentDraft(m) && (onUseDraft || onEditDraft || onDiscardDraft) ? (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    {onUseDraft ? (
                      <button
                        type="button"
                        onClick={() => onUseDraft(m.id, draftBody(m))}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                      >
                        <Sparkles className="h-3 w-3" />
                        {t('conversations.ai_draft_use')}
                      </button>
                    ) : null}
                    {onEditDraft ? (
                      <button
                        type="button"
                        onClick={() => onEditDraft(m.id, draftBody(m))}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-chat-meta transition-colors hover:bg-foreground/5"
                      >
                        {t('conversations.ai_draft_edit')}
                      </button>
                    ) : null}
                    {onDiscardDraft ? (
                      <button
                        type="button"
                        onClick={() => onDiscardDraft(m.id)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-chat-meta transition-colors hover:bg-foreground/5"
                      >
                        {t('conversations.ai_draft_discard')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {m.attachments.length > 0 ? (
                  <Attachments attachments={m.attachments} />
                ) : null}
                <ReactionPills
                  reactions={reactionsOf(m)}
                  contactLabel={t('conversations.reaction_contact')}
                  businessLabel={t('conversations.reaction_business')}
                />
                <div className="-mb-0.5 mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-chat-meta">
                  {aiDraftHint(m) ? (
                    // A reply that started as an AI suggestion: just a mark,
                    // the words on hover.
                    <span
                      role="img"
                      title={t(`conversations.${aiDraftHint(m)!}`)}
                      aria-label={t(`conversations.${aiDraftHint(m)!}`)}
                      className="mr-0.5 inline-flex cursor-help"
                    >
                      <Sparkles className="h-2.5 w-2.5" aria-hidden />
                    </span>
                  ) : null}
                  <span>{fmt.time(m.createdAt)}</span>
                  {side === 'right' && !m.isPrivate ? (
                    <DeliveryTicks status={m.status} sendingLabel={t('conversations.sending')} />
                  ) : null}
                  {side === 'right' && !m.isPrivate && m.status === 'FAILED' && onRetry ? (
                    <button
                      type="button"
                      onClick={() => onRetry(m.id)}
                      className="ml-1 rounded px-1 text-[10px] font-medium text-destructive underline-offset-2 hover:underline"
                    >
                      {t('conversations.retry_send')}
                    </button>
                  ) : null}
                </div>
              </div>
              {side === 'left' ? (
                <button
                  type="button"
                  onClick={() => onReply(m)}
                  className="ml-1 mt-1 self-end rounded-full p-1 text-chat-meta opacity-0 transition-opacity hover:bg-foreground/5 group-hover:opacity-100"
                  aria-label={t('conversations.thread_reply_button')}
                >
                  <Reply className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {side === 'left' && onReact && canReactTo(m) ? (
                <ReactButton
                  open={reactingTo === m.id}
                  current={reactionsOf(m).business?.emoji ?? null}
                  label={t('conversations.react_button')}
                  removeLabel={t('conversations.reaction_remove')}
                  onToggle={() => setReactingTo((v) => (v === m.id ? null : m.id))}
                  onPick={(emoji) => {
                    setReactingTo(null)
                    onReact(m.id, emoji)
                  }}
                />
              ) : null}
            </div>
          )
        })}
        <div className="h-2" />
      </div>
      <span className="sr-only">{meName}</span>
    </div>
  )
}

function DeliveryTicks({ status, sendingLabel }: { status: string; sendingLabel: string }) {
  if (status === 'PENDING') {
    // Shown in the thread, not yet confirmed by the server.
    return <Clock className="h-3 w-3" aria-label={sendingLabel} />
  }
  if (status === 'FAILED') {
    // The message is in our thread but never reached the contact.
    return <AlertCircle className="h-3 w-3 text-destructive" />
  }
  if (status === 'READ') {
    return <CheckCheck className="h-3 w-3 text-chat-tick" />
  }
  if (status === 'DELIVERED') {
    return <CheckCheck className="h-3 w-3" />
  }
  return <Check className="h-3 w-3" />
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Attachment tiles on a message bubble. The bytes always come from the
 * authenticated download endpoint — `fileUrl` on the DTO is the raw storage
 * value (an `s3://` URI, or a route that itself needs a bearer token), so it
 * isn't usable as an `<img src>` or a plain link. Images fetch eagerly for a
 * thumbnail; everything else fetches on click.
 */
function Attachments({
  attachments,
}: {
  attachments: MessageDTO['attachments']
}) {
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="message-attachments">
      {attachments.map((a) => (
        <AttachmentItem key={a.id} attachment={a} />
      ))}
    </div>
  )
}

function AttachmentItem({
  attachment,
}: {
  attachment: MessageDTO['attachments'][number]
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const isImage = attachment.fileType === 'IMAGE'

  const fetchBlob = React.useCallback(async (): Promise<string | null> => {
    if (!session) return null
    const res = await fetch(
      `${API_BASE}/accounts/${session.account.id}/attachments/${attachment.id}/download`,
      { headers: { authorization: `Bearer ${session.session.token}` } },
    )
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    return URL.createObjectURL(await res.blob())
  }, [session, attachment.id])

  // Thumbnails load on their own; other types stay a click away so we don't
  // pull every PDF in a long thread.
  React.useEffect(() => {
    if (!isImage || !session) return
    let revoked: string | null = null
    let cancelled = false
    fetchBlob()
      .then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url)
          return
        }
        revoked = url
        setObjectUrl(url)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [isImage, session, fetchBlob])

  async function open() {
    if (busy) return
    if (objectUrl) {
      window.open(objectUrl, '_blank', 'noopener')
      return
    }
    setBusy(true)
    try {
      const url = await fetchBlob()
      if (url) {
        setObjectUrl(url)
        window.open(url, '_blank', 'noopener')
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const label = attachment.fileName ?? t('conversations.attachment_untitled')

  if (isImage && objectUrl) {
    return (
      <button
        type="button"
        onClick={open}
        className="block overflow-hidden rounded-md"
        aria-label={label}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={objectUrl}
          alt={label}
          className="max-h-64 max-w-full rounded-md object-cover"
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      className="flex max-w-[260px] items-center gap-2 rounded-md border border-foreground/10 bg-foreground/5 px-2 py-1.5 text-left text-xs hover:bg-foreground/10 disabled:opacity-60"
      data-testid="attachment-download"
    >
      {failed ? (
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
      ) : (
        <Paperclip className="h-4 w-4 shrink-0 text-chat-meta" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        <span className="block text-[10px] text-chat-meta">
          {failed
            ? t('conversations.attachment_failed')
            : attachment.fileSize != null
              ? formatBytes(attachment.fileSize)
              : t('conversations.attachment_download')}
        </span>
      </span>
      <Download className="h-3.5 w-3.5 shrink-0 text-chat-meta" />
    </button>
  )
}

/**
 * Render content with `@username` tokens highlighted as bold + primary color.
 * Whitespace and line breaks are preserved by the wrapping `<p>` (whitespace-
 * pre-wrap), so we just split on the mention regex.
 */
/** Which hint a reply born from an AI suggestion carries, if any. */
function aiDraftHint(m: MessageDTO): 'ai_draft_sent_hint' | 'ai_draft_edited_hint' | null {
  if (m.senderType !== 'USER') return null
  const v = attrs(m).aiDraft
  if (v === 'sent') return 'ai_draft_sent_hint'
  if (v === 'edited') return 'ai_draft_edited_hint'
  return null
}

/** Only a public message that went through WhatsApp (it has a wamid) takes a reaction. */
function canReactTo(m: MessageDTO): boolean {
  return !m.isPrivate && Boolean(m.externalSourceId) && attrs(m).rawType !== 'reaction'
}

const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🙏']

/** Hover button that opens a one-row picker, as on the phone. */
function ReactButton({
  open,
  current,
  label,
  removeLabel,
  onToggle,
  onPick,
}: {
  open: boolean
  current: string | null
  label: string
  removeLabel: string
  onToggle: () => void
  onPick: (emoji: string) => void
}) {
  return (
    <div className="relative mt-1 self-end">
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        aria-expanded={open}
        className={cn(
          'rounded-full p-1 text-chat-meta transition-opacity hover:bg-foreground/5 group-hover:opacity-100',
          open ? 'opacity-100' : 'opacity-0',
        )}
      >
        <SmilePlus className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onToggle()
          }}
          className="absolute bottom-full z-20 mb-1 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-card px-1.5 py-1 shadow-md"
        >
          {REACTION_CHOICES.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              // Picking the one already there takes it off, as on the phone.
              onClick={() => onPick(emoji === current ? '' : emoji)}
              aria-label={emoji === current ? removeLabel : emoji}
              className={cn(
                'rounded-full px-1 text-base leading-none transition-transform hover:scale-125',
                emoji === current && 'bg-primary/15',
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The contact's and our reaction, under the bubble. */
function ReactionPills({
  reactions,
  contactLabel,
  businessLabel,
}: {
  reactions: ReturnType<typeof reactionsOf>
  contactLabel: string
  businessLabel: string
}) {
  if (!reactions.contact && !reactions.business) return null
  return (
    <div className="mt-1 flex gap-1">
      {reactions.contact ? (
        <span
          title={contactLabel}
          className="rounded-full border border-border bg-card px-1.5 text-sm leading-5 shadow-xs"
        >
          {reactions.contact.emoji}
        </span>
      ) : null}
      {reactions.business ? (
        <span
          title={businessLabel}
          className="rounded-full border border-primary/40 bg-primary/10 px-1.5 text-sm leading-5 shadow-xs"
        >
          {reactions.business.emoji}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Bot bubbles come from two writers: the AI agent (it signs with its bot id)
 * and a flow. A flow's own lines are scripted, so labelling them "AI agent"
 * told the desk the AI had said things it never wrote; only the flow's AI
 * blocks and off-script answers carry `aiGenerated`.
 */
function isAiWritten(m: MessageDTO): boolean {
  return Boolean(m.senderAgentBotId) || attrs(m).aiGenerated === true
}

function renderWithMentions(text: string) {
  const re = /(^|\s)(@[a-z0-9._-]+)/gi
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    const start = m.index + (m[1]?.length ?? 0)
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start))
    }
    parts.push(
      <span
        key={`m${key++}`}
        className="font-semibold text-primary"
      >
        {m[2]}
      </span>,
    )
    lastIndex = start + (m[2]?.length ?? 0)
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length > 0 ? parts : text
}


// ─── Interactive messages (buttons / list) ─────────────────────────────

/** Attributes as a plain record. One malformed message must never blank the thread. */
function attrs(m: MessageDTO): Record<string, unknown> {
  return (m.contentAttributes ?? {}) as Record<string, unknown>
}

type OfferOption = { id: string; label: string; description?: string }
export type InteractiveOffer = {
  kind: 'buttons' | 'list'
  buttonText?: string
  groups: Array<{ title?: string; options: OfferOption[] }>
}

/**
 * The options a bot message offered, normalized across WhatsApp's two
 * shapes. Without this the thread showed only the question, so an operator
 * reading "📋 Outro" had no way to tell it was a tap on a list, or what the
 * other choices were.
 */
export function interactiveOptions(m: MessageDTO): InteractiveOffer | null {
  if (m.contentType !== 'QUICK_REPLIES') return null
  const a = attrs(m)
  if (a.kind === 'buttons' && Array.isArray(a.buttons)) {
    const options = (a.buttons as Array<{ id?: unknown; label?: unknown }>)
      .filter((b) => typeof b.id === 'string' && typeof b.label === 'string')
      .map((b) => ({ id: b.id as string, label: b.label as string }))
    return options.length ? { kind: 'buttons', groups: [{ options }] } : null
  }
  if (a.kind === 'list' && Array.isArray(a.sections)) {
    const groups = (a.sections as Array<{ title?: unknown; rows?: unknown }>)
      .map((sec) => ({
        title: typeof sec.title === 'string' && sec.title ? sec.title : undefined,
        options: (Array.isArray(sec.rows) ? sec.rows : [])
          .filter(
            (r: { id?: unknown; title?: unknown }) =>
              typeof r.id === 'string' && typeof r.title === 'string',
          )
          .map((r: { id: string; title: string; description?: unknown }) => ({
            id: r.id,
            label: r.title,
            description:
              typeof r.description === 'string' && r.description ? r.description : undefined,
          })),
      }))
      .filter((g) => g.options.length > 0)
    if (!groups.length) return null
    return {
      kind: 'list',
      buttonText: typeof a.buttonText === 'string' ? a.buttonText : undefined,
      groups,
    }
  }
  return null
}

/** A contact message that came from tapping a button or list row. */
export function isInteractiveReply(m: MessageDTO): boolean {
  if (m.senderType !== 'CONTACT') return false
  const id = attrs(m).interactiveReplyId
  return typeof id === 'string' && id.length > 0
}

/**
 * Map each bot question to the option the contact tapped: the first contact
 * message after it, if its reply id is one of the options offered. Keyed by
 * position rather than id alone, because a flow can ask the same question
 * twice with the same option ids.
 */
export function chosenReplies(messages: MessageDTO[]): Map<string, string> {
  const out = new Map<string, string>()
  messages.forEach((m, i) => {
    const offer = interactiveOptions(m)
    if (!offer) return
    const ids = new Set(offer.groups.flatMap((g) => g.options.map((o) => o.id)))
    for (let j = i + 1; j < messages.length; j += 1) {
      const next = messages[j]!
      if (next.senderType !== 'CONTACT') continue
      const rid = attrs(next).interactiveReplyId
      if (typeof rid === 'string' && ids.has(rid)) out.set(m.id, rid)
      break
    }
  })
  return out
}

function InteractiveOptions({
  offer,
  chosenId,
  label,
  chosenLabel,
}: {
  offer: InteractiveOffer
  chosenId: string | null
  label: string
  chosenLabel: string
}) {
  // Read-only: these mirror what the contact saw, they are not controls.
  return (
    <div className="mt-1.5 space-y-1" data-testid="interactive-options">
      <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-chat-meta">
        <ListChecks className="h-3 w-3" /> {offer.buttonText ?? label}
      </p>
      {offer.groups.map((g, gi) => (
        <div key={gi} className="space-y-1">
          {g.title ? (
            <p className="text-[10px] uppercase tracking-wide text-chat-meta">{g.title}</p>
          ) : null}
          <ul className={cn(offer.kind === 'buttons' ? 'flex flex-wrap gap-1' : 'space-y-1')}>
            {g.options.map((o) => {
              const picked = o.id === chosenId
              return (
                <li
                  key={o.id}
                  aria-current={picked ? 'true' : undefined}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] leading-snug',
                    picked
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border/60 bg-background/40 text-chat-bubble-foreground/80',
                  )}
                >
                  <span className="flex items-center gap-1">
                    {picked ? <Check className="h-3 w-3 text-primary" aria-label={chosenLabel} /> : null}
                    <span className={cn(picked && 'font-medium')}>{o.label}</span>
                  </span>
                  {o.description ? (
                    <span className="block text-[10px] text-chat-meta">{o.description}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
