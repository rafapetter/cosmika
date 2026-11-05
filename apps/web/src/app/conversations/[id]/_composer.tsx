'use client'

import * as React from 'react'
import type { Route } from 'next'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertCircle, AtSign, Bookmark, CornerUpLeft, FileText, Loader2, Lock, MessageSquare, Paperclip, Send, X } from 'lucide-react'
import { Avatar, AvatarFallback, Button, cn, initialsOf } from '@cosmika/ui'
import type {
  CannedResponseDTO,
  MessageDTO,
  WhatsappTemplateDTO,
} from '@cosmika/shared'

import { apiErrorCode, apiErrorText } from '../../../lib/api-error'

export type ComposerMember = {
  id: string
  email: string
  fullName: string | null
}

/** Mirrors the API's `attachmentIds` cap on SendMessageInput. */
const MAX_ATTACHMENTS = 10

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** An attachment being uploaded, or already uploaded and ready to send. */
type PendingAttachment = {
  /** Stable key while uploading; replaced by the server id on success. */
  key: string
  fileName: string
  fileSize: number
  /** Set once the upload lands — this is what goes in `attachmentIds`. */
  id?: string
  error?: string
}

export function Composer({
  onSend,
  onUpload,
  sending,
  disabled,
  replyTo,
  onClearReply,
  cannedResponses,
  accountMembers,
  currentUserId,
  templates = [],
  onSendTemplate,
  prefill,
  messagingWindow,
  closed,
}: {
  onSend: (args: {
    content: string
    isPrivate: boolean
    inReplyToId?: string
    attachmentIds: string[]
    /** The AI suggestion this text started from, and whether it was changed. */
    fromDraft?: { id: string; edited: boolean }
  }) => Promise<boolean | void> | boolean | void
  /** Uploads one file and resolves to its attachment id. */
  onUpload?: (file: File) => Promise<string>
  sending: boolean
  disabled?: boolean
  replyTo: MessageDTO | null
  onClearReply: () => void
  cannedResponses: CannedResponseDTO[]
  accountMembers: ComposerMember[]
  currentUserId: string
  /**
   * Text to load into the box, e.g. an AI suggestion the agent chose to use.
   * Keyed by `nonce` so choosing the same suggestion twice still re-loads it,
   * and so a re-render never clobbers what the agent has since typed.
   */
  prefill?: { text: string; nonce: number; draftId?: string } | null
  /**
   * WhatsApp's 24h service window. When shut, a free-form reply is rejected
   * by Meta — only an approved template gets through — so say that before the
   * agent types one rather than after it fails.
   */
  messagingWindow?: {
    open: boolean
    lastInboundAt: string | null
    expiresAt: string | null
  } | null
  /**
   * Set when the conversation is closed. A closed conversation is never
   * reopened, so the box only takes internal notes and points to where a new
   * conversation with the same contact starts.
   */
  closed?: { newConversationHref: Route } | null
  templates?: WhatsappTemplateDTO[]
  onSendTemplate?: (args: {
    templateId: string
    variables: string[]
  }) => Promise<void> | void
}) {
  const t = useTranslations()
  const [content, setContent] = React.useState('')
  const lastPrefill = React.useRef<number | null>(null)
  // The AI suggestion loaded for editing, until it is sent or the box is
  // emptied: the sent reply is marked as coming from it, and it leaves the
  // thread.
  const fromDraft = React.useRef<{ id: string; text: string } | null>(null)
  React.useEffect(() => {
    if (!prefill || prefill.nonce === lastPrefill.current) return
    lastPrefill.current = prefill.nonce
    setContent(prefill.text)
    fromDraft.current = prefill.draftId ? { id: prefill.draftId, text: prefill.text.trim() } : null
  }, [prefill])
  const [privateChosen, setIsPrivate] = React.useState(false)
  // Closed conversation: notes only, whatever mode was picked before it closed.
  const isPrivate = privateChosen || closed != null
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([])
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 8 * 22) + 'px'
  }, [content])

  React.useEffect(() => {
    if (replyTo) textareaRef.current?.focus()
  }, [replyTo])

  // Canned-response suggestions: triggered when input starts with "/<query>"
  const slashMatch = React.useMemo(() => {
    const m = content.match(/^\/([a-z0-9_-]*)$/i)
    if (!m) return null
    const q = (m[1] ?? '').toLowerCase()
    return {
      query: q,
      results: cannedResponses.filter((c) =>
        c.shortcode.toLowerCase().startsWith(q),
      ),
    }
  }, [content, cannedResponses])

  // Mention suggestions: triggered when caret follows `@<query>` token.
  // Only active in private-note mode.
  const [caretPos, setCaretPos] = React.useState(0)
  const mentionMatch = React.useMemo(() => {
    if (!isPrivate) return null
    const upto = content.slice(0, caretPos)
    const m = upto.match(/(^|\s)@([a-z0-9._-]*)$/i)
    if (!m) return null
    const q = (m[2] ?? '').toLowerCase()
    return {
      query: q,
      start: caretPos - q.length - 1, // index of the `@`
      results: accountMembers
        .filter((u) => u.id !== currentUserId)
        .filter((u) => {
          const local = (u.email.split('@')[0] ?? '').toLowerCase()
          return (
            local.startsWith(q) ||
            (u.fullName ?? '').toLowerCase().startsWith(q)
          )
        }),
    }
  }, [content, caretPos, isPrivate, accountMembers, currentUserId])

  function expandShortcode(c: CannedResponseDTO) {
    setContent(c.content)
    textareaRef.current?.focus()
  }

  function insertMention(u: ComposerMember) {
    if (!mentionMatch) return
    const local = (u.email.split('@')[0] ?? '')
    const before = content.slice(0, mentionMatch.start)
    const after = content.slice(caretPos)
    const inserted = `@${local} `
    setContent(before + inserted + after)
    // Move caret right after the inserted token + space.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const pos = before.length + inserted.length
      el.selectionStart = el.selectionEnd = pos
      el.focus()
    })
  }

  // Upload as soon as a file is picked, so sending is instant and the agent
  // sees failures (too large, wrong type) before they commit to the message.
  async function addFiles(files: FileList | null) {
    if (!files || !onUpload) return
    const picked = Array.from(files).slice(0, MAX_ATTACHMENTS - attachments.length)
    for (const file of picked) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`
      setAttachments((prev) => [
        ...prev,
        { key, fileName: file.name, fileSize: file.size },
      ])
      try {
        const id = await onUpload(file)
        setAttachments((prev) =>
          prev.map((a) => (a.key === key ? { ...a, id } : a)),
        )
      } catch (err) {
        const message =
          apiErrorCode(err) ? apiErrorText(t, err) : t('conversations.attachment_failed')
        setAttachments((prev) =>
          prev.map((a) => (a.key === key ? { ...a, error: message } : a)),
        )
      }
    }
  }

  function removeAttachment(key: string) {
    setAttachments((prev) => prev.filter((a) => a.key !== key))
  }

  const readyIds = attachments.flatMap((a) => (a.id ? [a.id] : []))
  const uploading = attachments.some((a) => !a.id && !a.error)
  // An attachment-only message is valid; a message that is only a failed
  // upload is not.
  const canSend =
    (content.trim().length > 0 || readyIds.length > 0) &&
    !uploading &&
    !sending &&
    !disabled

  async function submit() {
    const text = content.trim()
    if (!canSend) return
    // Clear at once: the thread already shows the message as sending. If it
    // does not go, the text comes back, unless something new was typed.
    const sentAttachments = attachments
    const draft = isPrivate ? null : fromDraft.current
    setContent('')
    setAttachments([])
    onClearReply()
    fromDraft.current = null
    const ok = await onSend({
      content: text,
      isPrivate,
      inReplyToId: replyTo?.id,
      attachmentIds: readyIds,
      ...(draft ? { fromDraft: { id: draft.id, edited: text !== draft.text } } : {}),
    })
    if (ok === false) {
      setContent((now) => (now.trim() ? now : text))
      setAttachments((now) => (now.length > 0 ? now : sentAttachments))
      if (draft && !fromDraft.current) fromDraft.current = draft
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mention suggestions take priority over slash + submit.
    if (
      mentionMatch &&
      mentionMatch.results.length > 0 &&
      (e.key === 'Tab' || e.key === 'Enter') &&
      !e.shiftKey
    ) {
      e.preventDefault()
      insertMention(mentionMatch.results[0]!)
      return
    }
    if (
      slashMatch &&
      slashMatch.results.length > 0 &&
      (e.key === 'Tab' || e.key === 'Enter') &&
      !e.shiftKey
    ) {
      e.preventDefault()
      expandShortcode(slashMatch.results[0]!)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  function handleSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaretPos(e.currentTarget.selectionStart ?? 0)
  }

  const windowShut = messagingWindow != null && !messagingWindow.open

  return (
    <div className="border-t border-border bg-card">
      {closed ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          data-testid="composer-closed"
        >
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{t('conversations.closed_notice')}</span>
          <Link
            href={closed.newConversationHref}
            className="font-medium text-primary hover:underline"
            data-testid="composer-new-conversation"
          >
            {t('conversations.closed_start_new')}
          </Link>
        </div>
      ) : windowShut ? (
        <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('conversations.window_closed')}</span>
        </div>
      ) : null}
      {/* Reply-to banner */}
      {replyTo ? (
        <div className="flex items-center gap-2 border-l-2 border-primary bg-muted/40 px-3 py-1.5">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="text-[10px] font-medium uppercase tracking-wide text-primary">
              {t('conversations.composer_replying_to')}{' '}
              {replyTo.senderType === 'CONTACT'
                ? t('conversations.inbound_label')
                : replyTo.senderType === 'AGENT_BOT'
                  ? t('conversations.bot_label')
                  : t('conversations.you')}
            </p>
            <p className="line-clamp-1 text-muted-foreground">
              {replyTo.content ?? '-'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('conversations.composer_clear_reply')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {/* Mode toggle row */}
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          type="button"
          onClick={() => setIsPrivate(false)}
          disabled={closed != null}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            !isPrivate
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:bg-muted',
            closed != null && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          )}
          data-testid="composer-mode-reply"
        >
          <MessageSquare className="h-3.5 w-3.5" /> {t('conversations.composer_reply')}
        </button>
        <button
          type="button"
          onClick={() => setIsPrivate(true)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
            isPrivate
              ? 'bg-warning/80 text-warning-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
          data-testid="composer-mode-note"
        >
          <Lock className="h-3.5 w-3.5" /> {t('conversations.composer_internal_note')}
        </button>
      </div>

      {/* Mention suggestions — only in internal-note mode */}
      {mentionMatch && mentionMatch.results.length > 0 ? (
        <div className="mx-3 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-card shadow-md animate-fade-in">
          {mentionMatch.results.slice(0, 6).map((u, i) => (
            <button
              key={u.id}
              type="button"
              onClick={() => insertMention(u)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted',
                i === 0 && 'bg-muted/40',
              )}
              data-testid={`mention-${u.id}`}
            >
              <Avatar className="h-5 w-5">
                <AvatarFallback className="text-[9px]">
                  {initialsOf(u.fullName ?? u.email)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {u.fullName ?? u.email}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  @{u.email.split('@')[0]}
                </p>
              </div>
              {i === 0 ? (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  Tab
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* Canned-response suggestions */}
      {slashMatch && slashMatch.results.length > 0 ? (
        <div className="mx-3 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-card shadow-md animate-fade-in">
          {slashMatch.results.slice(0, 8).map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => expandShortcode(c)}
              className={cn(
                'flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs hover:bg-muted',
                i === 0 && 'bg-muted/40',
              )}
            >
              <Bookmark className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-primary">/{c.shortcode}</p>
                <p className="mt-0.5 line-clamp-2 text-muted-foreground">
                  {c.content}
                </p>
              </div>
              {i === 0 ? (
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  Tab
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* WhatsApp template picker */}
      {templateOpen && onSendTemplate && !closed ? (
        <TemplatePicker
          templates={templates}
          disabled={disabled || sending}
          onClose={() => setTemplateOpen(false)}
          onSend={async (args) => {
            await onSendTemplate(args)
            setTemplateOpen(false)
          }}
        />
      ) : null}

      {/* Staged attachments */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2" data-testid="composer-attachments">
          {attachments.map((a) => (
            <span
              key={a.key}
              className={cn(
                'flex max-w-[220px] items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                a.error
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border bg-muted/50',
              )}
              data-testid="composer-attachment-chip"
            >
              {a.error ? (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              ) : a.id ? (
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              )}
              <span className="truncate" title={a.error ?? a.fileName}>
                {a.fileName}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {a.error ? a.error : formatBytes(a.fileSize)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.key)}
                className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
                aria-label={t('conversations.attachment_remove')}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Textarea + send */}
      <div className="flex items-end gap-2 px-3 py-2.5">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="composer-file-input"
          onChange={(e) => {
            void addFiles(e.target.files)
            // Reset so picking the same file twice still fires onChange.
            e.target.value = ''
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('conversations.attachment_add')}
          title={t('conversations.attachment_add')}
          disabled={
            disabled || sending || !onUpload || attachments.length >= MAX_ATTACHMENTS
          }
          onClick={() => fileInputRef.current?.click()}
          data-testid="composer-attach"
        >
          <Paperclip />
        </Button>
        {templates.length > 0 && onSendTemplate && !closed ? (
          <Button
            type="button"
            size="icon-sm"
            variant={templateOpen ? 'primary' : 'ghost'}
            aria-label={t('conversations.template_send')}
            title={t('conversations.template_send')}
            onClick={() => setTemplateOpen((o) => !o)}
            data-testid="composer-template-toggle"
          >
            <FileText />
          </Button>
        ) : null}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value)
            if (!e.target.value.trim()) fromDraft.current = null
            setCaretPos(e.target.selectionStart ?? 0)
          }}
          onSelect={handleSelect}
          onKeyUp={handleSelect}
          onClick={handleSelect}
          onKeyDown={handleKeyDown}
          placeholder={
            isPrivate
              ? t('conversations.composer_placeholder_internal')
              : t('conversations.composer_placeholder')
          }
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-snug',
            'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
            isPrivate && 'bg-chat-private/60',
          )}
          disabled={disabled || sending}
          data-testid="composer-input"
        />
        <Button
          type="button"
          variant="primary"
          size="icon"
          aria-label={t('conversations.send')}
          onClick={submit}
          disabled={!canSend}
          data-testid="composer-send"
        >
          <Send />
        </Button>
      </div>
    </div>
  )
}

function renderPreview(body: string, vars: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, idx: string) => {
    const v = vars[Number(idx) - 1]
    return v ? v : whole
  })
}

function TemplatePicker({
  templates,
  disabled,
  onClose,
  onSend,
}: {
  templates: WhatsappTemplateDTO[]
  disabled?: boolean
  onClose: () => void
  onSend: (args: { templateId: string; variables: string[] }) => Promise<void> | void
}) {
  const t = useTranslations()
  const approved = templates.filter((tpl) => tpl.status === 'APPROVED')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [vars, setVars] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const selected = approved.find((tpl) => tpl.id === selectedId) ?? null

  function pick(tpl: WhatsappTemplateDTO) {
    setSelectedId(tpl.id)
    setVars(Array.from({ length: tpl.variableCount }, () => ''))
  }

  const ready =
    selected !== null && vars.every((v) => v.trim().length > 0) && !busy

  async function doSend() {
    if (!selected || !ready) return
    setBusy(true)
    try {
      await onSend({ templateId: selected.id, variables: vars })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="mx-3 mb-1 rounded-md border border-border bg-card p-2 shadow-md animate-fade-in"
      data-testid="template-picker"
    >
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('conversations.template_title')}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('conversations.composer_clear_reply')}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {approved.length === 0 ? (
        <p className="py-2 text-[11px] text-muted-foreground/70">
          {t('conversations.template_none')}
        </p>
      ) : !selected ? (
        <div className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
          {approved.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => pick(tpl)}
              data-testid={`template-${tpl.id}`}
              className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            >
              <span className="font-medium">
                {tpl.name}{' '}
                <span className="text-[10px] text-muted-foreground">
                  {tpl.language}
                </span>
              </span>
              <span className="line-clamp-2 text-[11px] text-muted-foreground">
                {tpl.body}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 space-y-2">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← {selected.name}
          </button>
          {vars.map((v, i) => (
            <input
              key={i}
              value={v}
              onChange={(e) =>
                setVars((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))
              }
              placeholder={`{{${i + 1}}}`}
              data-testid={`template-var-${i + 1}`}
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
            />
          ))}
          <div className="rounded bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
            {renderPreview(selected.body, vars)}
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={doSend}
            disabled={!ready || disabled}
            data-testid="template-send"
          >
            <Send className="h-3.5 w-3.5" /> {t('conversations.template_send')}
          </Button>
        </div>
      )}
    </div>
  )
}
