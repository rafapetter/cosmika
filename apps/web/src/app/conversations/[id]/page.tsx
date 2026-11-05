'use client'

import * as React from 'react'
import type { Route } from 'next'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Avatar,
  AvatarFallback,
  Badge,
  Skeleton,
  initialsOf,
} from '@cosmika/ui'
import type {
  AgentToolCallDTO,
  AiAgentSessionDTO,
  CannedResponseDTO,
  ConversationDetailDTO,
  ConversationStatus,
  ConversationSummaryDTO,
  LabelDTO,
  MessageDTO,
  Priority,
  WhatsappTemplateDTO,
} from '@cosmika/shared'

import { ApiError, api } from '../../../lib/api'
import { apiErrorCode, apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'
import { useRealtime } from '../../../lib/use-realtime'
import {
  confirmPending,
  mergePending,
  optimisticMessage,
  withBusinessReaction,
  withReactions,
} from '../../../lib/optimistic-messages'

import { Composer } from './_composer'
import { ProtocolBadge } from './_protocol'
import { ConversationSidebar } from './_sidebar'
import { Thread } from './_thread'

function statusBadge(s: ConversationStatus) {
  return s === 'OPEN' ? 'open' : s === 'PENDING' ? 'pending' : 'resolved'
}

export default function ConversationDetailPage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const conversationId = params.id
  const { session, ready } = useStoredSession()

  const [conversation, setConversation] = React.useState<ConversationDetailDTO | null>(null)
  const [messages, setMessages] = React.useState<MessageDTO[]>([])
  const [aiSession, setAiSession] = React.useState<AiAgentSessionDTO | null>(null)
  const [aiToolCalls, setAiToolCalls] = React.useState<AgentToolCallDTO[]>([])
  const [previousConversations, setPreviousConversations] = React.useState<
    ConversationSummaryDTO[]
  >([])
  const [confirmingTools, setConfirmingTools] = React.useState(false)
  const [replyTo, setReplyTo] = React.useState<MessageDTO | null>(null)
  // An AI suggestion the agent chose to review before sending. The nonce lets
  // the composer tell a fresh choice from a re-render.
  const [prefill, setPrefill] = React.useState<{
    text: string
    nonce: number
    draftId?: string
  } | null>(null)
  const [cannedResponses, setCannedResponses] = React.useState<CannedResponseDTO[]>([])
  const [accountLabels, setAccountLabels] = React.useState<LabelDTO[]>([])
  const [error, setError] = React.useState<string | null>(null)
  // A failure the agent should see without losing the screen (a refused
  // reaction, a send that did not go): shown above the composer.
  const [notice, setNotice] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  // Sends shown in the thread before the server confirmed them, and the
  // queue that keeps them in the order they were typed.
  const pendingRef = React.useRef(new Map<string, MessageDTO>())
  const sendSeq = React.useRef(0)
  const sendQueue = React.useRef<Promise<unknown>>(Promise.resolve())

  const [accountMembers, setAccountMembers] = React.useState<
    Array<{ id: string; email: string; fullName: string | null }>
  >([])
  const [templates, setTemplates] = React.useState<WhatsappTemplateDTO[]>([])

  // Account-wide refs (canned responses + labels + members) — fetched once per session.
  React.useEffect(() => {
    if (!session) return
    api
      .listCannedResponses(session.session.token, session.account.id)
      .then(setCannedResponses)
      .catch(() => setCannedResponses([]))
    api
      .listLabels(session.session.token, session.account.id)
      .then(setAccountLabels)
      .catch(() => setAccountLabels([]))
    api
      .getAccount(session.session.token, session.account.id)
      .then((a) =>
        setAccountMembers(
          (a.members ?? [])
            .filter((m) => m.isActive)
            .map((m) => ({
              id: m.user.id,
              email: m.user.email,
              fullName: m.user.fullName,
            })),
        ),
      )
      .catch(() => setAccountMembers([]))
  }, [session])

  // WhatsApp templates for this conversation's inbox (HSM) — only WHATSAPP
  // inboxes have them; other channels get an empty list (picker stays hidden).
  const inboxId = conversation?.inbox?.id
  const inboxChannel = conversation?.inbox?.channelType
  React.useEffect(() => {
    if (!session || !inboxId || inboxChannel !== 'WHATSAPP') {
      setTemplates([])
      return
    }
    api
      .listWhatsappTemplates(session.session.token, session.account.id, inboxId)
      .then(setTemplates)
      .catch(() => setTemplates([]))
  }, [session, inboxId, inboxChannel])

  const refresh = React.useCallback(async () => {
    if (!session) return
    try {
      const [c, mPage, ai] = await Promise.all([
        api.getConversation(session.session.token, session.account.id, conversationId),
        api.listMessages(
          session.session.token,
          session.account.id,
          conversationId,
          undefined,
          200,
        ),
        api
          .getAiSession(session.session.token, session.account.id, conversationId)
          .catch(() => ({ session: null, recentToolCalls: [] })),
      ])
      setConversation(c)
      setMessages(mergePending(mPage.data, [...pendingRef.current.values()]))
      setAiSession(ai.session)
      setAiToolCalls(ai.recentToolCalls)

      // Previous conversations with the same contact (excluding current).
      if (c.contact?.id) {
        try {
          const prev = await api.listConversations(
            session.session.token,
            session.account.id,
            { contactId: c.contact.id, excludeId: c.id, limit: 5 },
          )
          setPreviousConversations(prev.data)
        } catch {
          setPreviousConversations([])
        }
      } else {
        setPreviousConversations([])
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        router.replace('/conversations')
        return
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(t('conversations.forbidden'))
      } else {
        setError(t('auth.generic_error'))
      }
    }
  }, [session, conversationId, router, t])

  React.useEffect(() => {
    if (!ready || !session) return
    void refresh()
  }, [ready, session, refresh])

  useRealtime(session?.session.token ?? null, (event) => {
    if (
      event.type === 'MessageCreated' &&
      event.conversationId === conversationId
    ) {
      void refresh()
    } else if (
      event.type === 'ConversationStatusChanged' &&
      event.conversationId === conversationId
    ) {
      void refresh()
    } else if (
      event.type === 'MessageReactionChanged' &&
      event.conversationId === conversationId
    ) {
      setMessages((prev) =>
        prev.map((m) => (m.id === event.messageId ? withReactions(m, event.reactions) : m)),
      )
    } else if (
      event.type === 'MessageStatusChanged' &&
      event.conversationId === conversationId
    ) {
      // A delivery receipt moved the ticks; patch the one row in place
      // rather than refetching the whole thread.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.messageId ? { ...m, status: event.status as never } : m,
        ),
      )
    }
  })

  if (!ready || !session) return null

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center bg-chat-canvas p-8">
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      </div>
    )
  }
  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border bg-card p-3">
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="flex-1 bg-chat-canvas p-8">
          <Skeleton className="mx-auto h-6 w-40" />
        </div>
      </div>
    )
  }

  const name =
    conversation.contact.name ||
    conversation.contact.email ||
    conversation.contact.phoneNumber ||
    '-'

  // A closed conversation is never reopened. What the agent gets instead is a
  // way to start a new one with the same contact on the same inbox.
  const closed =
    conversation.status === 'RESOLVED'
      ? {
          // `typedRoutes` can't know a path built at runtime; the ids are
          // encoded and the route itself is fixed.
          newConversationHref: `/conversations/new?contactId=${encodeURIComponent(conversation.contact.id)}&inboxId=${encodeURIComponent(conversation.inbox.id)}` as Route,
        }
      : null

  async function onUpload(file: File): Promise<string> {
    if (!session) throw new Error('No session')
    const att = await api.uploadAttachment(
      session.session.token,
      session.account.id,
      file,
    )
    return att.id
  }

  async function onRetry(messageId: string) {
    if (!session) return
    try {
      const updated = await api.retryMessage(
        session.session.token,
        session.account.id,
        conversationId,
        messageId,
      )
      // The endpoint returns the settled row — FAILED still means failed, so
      // reflect what actually happened rather than assuming success.
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
    } catch {
      await refresh()
    }
  }

  async function onDiscardDraft(messageId: string) {
    if (!session) return
    // Drop it locally first so the thread reacts immediately; the realtime
    // MessageDeleted event is a backstop for other open tabs.
    setMessages((prev) => prev.filter((m) => m.id !== messageId))
    try {
      await api.discardAgentDraft(
        session.session.token,
        session.account.id,
        conversationId,
        messageId,
      )
    } catch {
      // Put it back rather than pretending it's gone.
      await refresh()
    }
  }

  /**
   * Show the message at once and send it in the background. Resolves false
   * when it did not go, so the composer can give the text back.
   */
  function onSend({
    content,
    isPrivate,
    inReplyToId,
    attachmentIds,
    fromDraft,
  }: {
    content: string
    isPrivate: boolean
    inReplyToId?: string
    attachmentIds: string[]
    fromDraft?: { id: string; edited: boolean }
  }): Promise<boolean> {
    if (!session) return Promise.resolve(false)
    const { token } = session.session
    const accountId = session.account.id
    // A reply that started as an AI suggestion keeps a small mark of it, and
    // the suggestion itself leaves the thread (it has been answered).
    const contentAttributes = fromDraft
      ? { aiDraft: fromDraft.edited ? 'edited' : 'sent' }
      : undefined
    if (fromDraft) setMessages((prev) => prev.filter((m) => m.id !== fromDraft.id))
    // Attachments are drawn by the server (thumbnails, file names), so only
    // text gets the instant bubble; a file send still waits for the row.
    const temp =
      attachmentIds.length === 0
        ? optimisticMessage({
            seq: (sendSeq.current += 1),
            conversationId,
            accountId,
            userId: session.user.id,
            content,
            isPrivate,
            inReplyToId,
            contentAttributes,
          })
        : null
    if (temp) {
      pendingRef.current.set(temp.id, temp)
      setMessages((prev) => [...prev, temp])
    }
    const run = sendQueue.current.then(async () => {
      try {
        const sent = await api.sendMessage(token, accountId, conversationId, {
          content,
          contentType: 'TEXT',
          isPrivate,
          attachmentIds,
          ...(inReplyToId ? { inReplyToId } : {}),
          ...(contentAttributes ? { contentAttributes } : {}),
        })
        if (temp) pendingRef.current.delete(temp.id)
        if (fromDraft) {
          void api
            .discardAgentDraft(token, accountId, conversationId, fromDraft.id)
            .catch(() => undefined)
        }
        setMessages((prev) => confirmPending(prev, temp?.id ?? '', sent))
        window.dispatchEvent(new Event('cosmika:refresh-conversations'))
        // The conversation itself changed too (first reply, bot → human).
        void refresh()
        return true
      } catch (err) {
        if (temp) {
          pendingRef.current.delete(temp.id)
          setMessages((prev) => prev.filter((m) => m.id !== temp.id))
        }
        // Not sent: the suggestion comes back with the reload below or now.
        if (fromDraft) void refresh()
        if (err instanceof ApiError && err.status === 403) {
          setError(t('conversations.forbidden'))
        } else if (apiErrorCode(err) === 'conversation_closed') {
          // It closed (by a colleague or by the inactivity timer) while this
          // screen was open: say so and show the conversation as it is now.
          setError(apiErrorText(t, err))
          void refresh()
        } else {
          setNotice(apiErrorCode(err) ? apiErrorText(t, err) : t('auth.generic_error'))
        }
        return false
      }
    })
    sendQueue.current = run
    return run
  }

  /** Send an AI suggestion as it is; it leaves the thread once sent. */
  async function onSendDraft(messageId: string, text: string) {
    await onSend({
      content: text,
      isPrivate: false,
      attachmentIds: [],
      fromDraft: { id: messageId, edited: false },
    })
  }

  /** Put (or take off) our reaction; the thread changes before the server answers. */
  async function onReact(messageId: string, emoji: string) {
    if (!session) return
    const before = messages.find((m) => m.id === messageId)
    if (!before) return
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? withBusinessReaction(m, emoji) : m)),
    )
    try {
      const updated = await api.reactToMessage(
        session.session.token,
        session.account.id,
        conversationId,
        messageId,
        emoji,
      )
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? before : m)))
      setNotice(apiErrorCode(err) ? apiErrorText(t, err) : t('auth.generic_error'))
    }
  }

  async function onSendTemplate({
    templateId,
    variables,
  }: {
    templateId: string
    variables: string[]
  }) {
    if (!session) return
    setSending(true)
    try {
      await api.sendTemplateMessage(
        session.session.token,
        session.account.id,
        conversationId,
        { templateId, variables },
      )
      await refresh()
      window.dispatchEvent(new Event('cosmika:refresh-conversations'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('conversations.forbidden'))
      } else if (apiErrorCode(err) === 'conversation_closed') {
        // It closed (by a colleague or by the inactivity timer) while this
        // screen was open: say so and show the conversation as it is now.
        setError(apiErrorText(t, err))
        void refresh()
      } else {
        setError(t('auth.generic_error'))
      }
    } finally {
      setSending(false)
    }
  }

  async function onStatusChange(s: ConversationStatus) {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { status: s },
      )
      setConversation((prev) =>
        prev
          ? { ...prev, status: updated.status, resolvedAt: updated.resolvedAt, reopenedAt: updated.reopenedAt, updatedAt: updated.updatedAt }
          : prev,
      )
      window.dispatchEvent(new Event('cosmika:refresh-conversations'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('conversations.forbidden'))
      } else if (apiErrorCode(err) === 'conversation_closed') {
        // Closed elsewhere while this screen was open: say so and catch up.
        setError(apiErrorText(t, err))
        void refresh()
      }
    }
  }

  async function onPriorityChange(p: Priority) {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { priority: p },
      )
      setConversation((prev) =>
        prev ? { ...prev, priority: updated.priority, updatedAt: updated.updatedAt } : prev,
      )
    } catch {
      /* keep silent for now */
    }
  }

  async function onAssignToMe() {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { assigneeId: session.user.id },
      )
      setConversation((prev) =>
        prev
          ? {
              ...prev,
              assigneeId: updated.assigneeId,
              // Assigning a human flips control to HUMAN server-side.
              controlMode: updated.controlMode,
              updatedAt: updated.updatedAt,
              assignee: {
                id: session.user.id,
                email: session.user.email,
                fullName: session.user.fullName,
              },
            }
          : prev,
      )
    } catch {
      /* keep silent for now */
    }
  }

  async function onControlModeChange(mode: 'BOT' | 'HUMAN') {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { controlMode: mode },
      )
      setConversation((prev) =>
        prev ? { ...prev, controlMode: updated.controlMode, updatedAt: updated.updatedAt } : prev,
      )
    } catch {
      /* keep silent for now */
    }
  }

  async function onAssign(
    assignee: { id: string; email: string; fullName: string | null } | null,
  ) {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { assigneeId: assignee?.id ?? null },
      )
      setConversation((prev) =>
        prev
          ? {
              ...prev,
              assigneeId: updated.assigneeId,
              // Assigning a human flips control to HUMAN server-side.
              controlMode: updated.controlMode,
              updatedAt: updated.updatedAt,
              assignee,
            }
          : prev,
      )
    } catch {
      /* keep silent for now */
    }
  }

  async function onTransfer(
    to: { id: string; email: string; fullName: string | null },
    note: string,
  ) {
    if (!session) return
    const updated = await api.updateConversation(
      session.session.token,
      session.account.id,
      conversationId,
      { assigneeId: to.id, ...(note && { transferNote: note }) },
    )
    setConversation((prev) =>
      prev
        ? {
            ...prev,
            assigneeId: updated.assigneeId,
            controlMode: updated.controlMode,
            updatedAt: updated.updatedAt,
            assignee: to,
          }
        : prev,
    )
  }

  async function onAssignTeam(teamId: string | null) {
    if (!session) return
    try {
      const updated = await api.updateConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { teamId },
      )
      setConversation((prev) =>
        prev ? { ...prev, teamId: updated.teamId, updatedAt: updated.updatedAt } : prev,
      )
    } catch {
      /* keep silent for now */
    }
  }

  async function onConfirmTools(toolCallIds: string[]) {
    if (!session || toolCallIds.length === 0) return
    setConfirmingTools(true)
    try {
      await api.confirmToolCalls(
        session.session.token,
        session.account.id,
        conversationId,
        { toolCallIds, decision: 'CONFIRM' },
      )
      await refresh()
    } catch {
      /* keep silent — surface via the panel if needed */
    } finally {
      setConfirmingTools(false)
    }
  }

  async function onRejectTools(toolCallIds: string[]) {
    if (!session || toolCallIds.length === 0) return
    setConfirmingTools(true)
    try {
      await api.confirmToolCalls(
        session.session.token,
        session.account.id,
        conversationId,
        { toolCallIds, decision: 'REJECT' },
      )
      await refresh()
    } catch {
      /* keep silent */
    } finally {
      setConfirmingTools(false)
    }
  }

  async function onToggleLabel(labelId: string, currentlyApplied: boolean) {
    if (!session) return
    try {
      if (currentlyApplied) {
        await api.removeLabel(
          session.session.token,
          session.account.id,
          conversationId,
          labelId,
        )
      } else {
        await api.applyLabel(
          session.session.token,
          session.account.id,
          conversationId,
          labelId,
        )
      }
      await refresh()
    } catch {
      /* silent */
    }
  }

  const meAssigned = conversation.assignee?.id === session.user.id
  const meName = session.user.fullName ?? session.user.email

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Thread header */}
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarFallback>{initialsOf(name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                <span className="mr-1.5 font-normal text-muted-foreground/70">
                  #{conversation.displayId}
                </span>
                {name}
              </p>
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <span className="truncate">
                  {conversation.inbox?.name ?? ''} ·{' '}
                  {conversation.contact.email ||
                    conversation.contact.phoneNumber ||
                    '-'}
                </span>
                <ProtocolBadge conversationId={conversation.id} protocol={conversation.protocol} />
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {conversation.forwardedFrom ? (
              <a
                href={`/conversations/${conversation.forwardedFrom.id}`}
                title={t('conversations.open_source_conversation')}
                className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-muted/80"
                data-testid="forwarded-from-pill"
              >
                ← {t('conversations.forwarded_from', { id: conversation.forwardedFrom.displayId })}
              </a>
            ) : null}
            <Badge variant={statusBadge(conversation.status)}>
              {t(`conversation.${conversation.status.toLowerCase() as 'open' | 'pending' | 'resolved'}`)}
            </Badge>
          </div>
        </header>

        {/* Thread */}
        <Thread
          messages={messages}
          meName={meName}
          onReply={setReplyTo}
          onUseDraft={onSendDraft}
          onEditDraft={(messageId, text) =>
            setPrefill((p) => ({ text, nonce: (p?.nonce ?? 0) + 1, draftId: messageId }))
          }
          onDiscardDraft={onDiscardDraft}
          onReact={
            conversation.inbox.channelType === 'WHATSAPP' && !closed ? onReact : undefined
          }
          onRetry={onRetry}
          conversationId={conversationId}
        />

        {notice ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 border-t border-border bg-destructive/10 px-4 py-2 text-xs text-destructive"
          >
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 font-medium underline-offset-2 hover:underline"
            >
              {t('common.close')}
            </button>
          </div>
        ) : null}

        {/* Composer */}
        <Composer
          prefill={prefill}
          closed={closed}
          messagingWindow={conversation.messagingWindow}
          onSend={onSend}
          onUpload={onUpload}
          sending={sending}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          cannedResponses={cannedResponses}
          accountMembers={accountMembers}
          currentUserId={session.user.id}
          templates={templates}
          onSendTemplate={onSendTemplate}
        />
      </div>

      {/* Right details sidebar */}
      <ConversationSidebar
        conversation={conversation}
        newConversationHref={closed?.newConversationHref ?? null}
        onStatusChange={onStatusChange}
        onPriorityChange={onPriorityChange}
        onAssignToMe={onAssignToMe}
        onAssign={onAssign}
        onAssignTeam={onAssignTeam}
        onTransfer={onTransfer}
        onControlModeChange={onControlModeChange}
        meAssigned={meAssigned}
        aiSession={aiSession}
        aiToolCalls={aiToolCalls}
        onConfirmTools={onConfirmTools}
        onRejectTools={onRejectTools}
        confirmingTools={confirmingTools}
        previousConversations={previousConversations}
        accountLabels={accountLabels}
        onToggleLabel={onToggleLabel}
      />
    </div>
  )
}
