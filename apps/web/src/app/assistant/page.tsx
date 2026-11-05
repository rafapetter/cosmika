'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { AdminAgentSessionDTO, AdminAgentTurnDTO } from '@cosmika/shared'
import { ADMIN_AGENT_MAX_ATTACHMENTS, ADMIN_AGENT_MEDIA_TYPES } from '@cosmika/shared'
import { Button } from '@cosmika/ui'
import { MessageSquarePlus, ShieldCheck, Zap } from 'lucide-react'

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { PageContainer, PageHeader } from '../../components/page'
import { useStoredSession } from '../../lib/session-store'
import { Markdown } from '../../components/assistant/markdown'
import { ToolResults } from '../../components/assistant/tool-result'
import { ApprovalCard, type PendingCall } from '../../components/assistant/approval-card'
import {
  Composer,
  MAX_FILE_BYTES,
  readFileAsAttachment,
  type Draft,
} from '../../components/assistant/composer'

type ExecutedCall = AdminAgentTurnDTO['executed'][number]

type Turn =
  | { kind: 'user'; text: string; attachments?: Draft[] }
  | { kind: 'assistant'; text: string; calls: ExecutedCall[] }
  | { kind: 'event'; text: string }

export default function AssistantPage() {
  const t = useTranslations()
  const { session } = useStoredSession()

  if (!session) return null

  // The assistant can change anything in the workspace, so the page itself is
  // administrator-only. The API enforces this too, on every request — this is
  // just so a non-admin sees an explanation instead of a wall of 403s.
  if (session.membership?.role !== 'ADMINISTRATOR') {
    return (
      <PageContainer>
        <PageHeader title={t('assistant.title')} subtitle={t('assistant.subtitle')} />
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('assistant.admin_only')}
        </p>
      </PageContainer>
    )
  }

  return <Assistant session={session} t={t} />
}

type Session = NonNullable<ReturnType<typeof useStoredSession>['session']>
type T = ReturnType<typeof useTranslations>

function Assistant({ session, t }: { session: Session; t: T }) {
  const token = session.session.token
  const accountId = session.account.id
  const requiresApproval = session.account.adminAgentRequiresApproval !== false

  const [sessions, setSessions] = React.useState<AdminAgentSessionDTO[]>([])
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [pending, setPending] = React.useState<PendingCall[]>([])
  const [draft, setDraft] = React.useState('')
  const [attachments, setAttachments] = React.useState<Draft[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const endRef = React.useRef<HTMLDivElement>(null)

  const refreshSessions = React.useCallback(async () => {
    try {
      setSessions(await api.listAdminAgentSessions(token, accountId))
    } catch {
      /* the list is a convenience; a failure here shouldn't block chatting */
    }
  }, [token, accountId])

  React.useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, pending, busy])

  async function attach(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    const room = ADMIN_AGENT_MAX_ATTACHMENTS - attachments.length
    const accepted: Draft[] = []
    for (const file of Array.from(files).slice(0, room)) {
      if (!(ADMIN_AGENT_MEDIA_TYPES as readonly string[]).includes(file.type)) {
        setError(t('assistant.attach_bad_type', { name: file.name }))
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(t('assistant.attach_too_big', { name: file.name }))
        continue
      }
      try {
        accepted.push(await readFileAsAttachment(file))
      } catch {
        // A browser that cannot read the file must say so, in words.
        setError(t('assistant.attach_failed', { name: file.name }))
      }
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted])
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => {
      const target = prev[index]
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  async function openSession(id: string) {
    setError(null)
    setBusy(true)
    try {
      const detail = await api.getAdminAgentSession(token, accountId, id)
      setSessionId(detail.id)
      setTurns(
        detail.transcript.map((m) =>
          m.role === 'user'
            ? ({ kind: 'user', text: m.text } as const)
            : ({ kind: 'assistant', text: m.text, calls: [] } as const),
        ),
      )
      // Approvals outlive a page reload: anything still PENDING is a decision
      // nobody has made yet, and dropping it would strand the change.
      setPending(
        detail.toolCalls
          .filter((c) => c.status === 'PENDING')
          .map((c) => ({
            id: c.id,
            toolName: c.toolName,
            input: (c.input ?? {}) as Record<string, unknown>,
          })),
      )
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  function newSession() {
    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
    setSessionId(null)
    setTurns([])
    setPending([])
    setAttachments([])
    setError(null)
  }

  async function send() {
    const message = draft.trim()
    if ((!message && attachments.length === 0) || busy) return
    const sent = attachments
    setError(null)
    setDraft('')
    setAttachments([])
    setTurns((prev) => [...prev, { kind: 'user', text: message, attachments: sent }])
    setBusy(true)
    try {
      const turn = await api.sendAdminAgentMessage(token, accountId, {
        ...(sessionId ? { sessionId } : {}),
        message,
        ...(sent.length > 0
          ? {
              attachments: sent.map((a) => ({
                name: a.name,
                mediaType: a.mediaType,
                data: a.data,
              })),
            }
          : {}),
      })
      setSessionId(turn.sessionId)
      if (turn.reply || turn.executed.length > 0) {
        setTurns((prev) => [
          ...prev,
          { kind: 'assistant', text: turn.reply, calls: turn.executed },
        ])
      }
      setPending(turn.pending)
      void refreshSessions()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function decide(approve: boolean, only?: string) {
    if (!sessionId || pending.length === 0) return
    const targets = only ? pending.filter((p) => p.id === only) : pending
    setBusy(true)
    setError(null)
    try {
      const results = await api.decideAdminAgentCalls(
        token,
        accountId,
        sessionId,
        targets.map((p) => ({ id: p.id, approve })),
      )
      setPending((prev) => prev.filter((p) => !targets.some((x) => x.id === p.id)))
      setTurns((prev) => [
        ...prev,
        ...results.map(
          (r) =>
            ({
              kind: 'event',
              text: t(
                r.status === 'CONFIRMED'
                  ? 'assistant.applied'
                  : r.status === 'REJECTED'
                    ? 'assistant.rejected'
                    : 'assistant.failed',
                { tool: r.toolName },
              ),
            }) as const,
        ),
      ])
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('assistant.title')}
        subtitle={t('assistant.subtitle')}
        actions={
          <Button variant="secondary" onClick={newSession} disabled={busy}>
            <MessageSquarePlus className="mr-1.5 h-4 w-4" />
            {t('assistant.new_chat')}
          </Button>
        }
      />

      <div
        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
          requiresApproval
            ? 'border-border bg-muted/40 text-muted-foreground'
            : 'border-amber-500/40 bg-amber-500/5 text-foreground'
        }`}
        data-testid="assistant-mode"
      >
        {requiresApproval ? (
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        )}
        <span>{requiresApproval ? t('assistant.mode_approval') : t('assistant.mode_auto')}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <aside className="hidden lg:block">
          <h2 className="px-1 pb-2 text-xs font-medium text-muted-foreground">
            {t('assistant.recent')}
          </h2>
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => void openSession(s.id)}
                  className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    s.id === sessionId
                      ? 'bg-subtle text-foreground'
                      : 'text-muted-foreground hover:bg-subtle/60 hover:text-foreground'
                  }`}
                >
                  {s.title ?? t('assistant.untitled')}
                </button>
              </li>
            ))}
            {sessions.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('assistant.no_sessions')}
              </li>
            ) : null}
          </ul>
        </aside>

        <div className="flex min-h-[28rem] min-w-0 flex-col gap-3">
          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-4">
            {turns.length === 0 && !busy ? (
              <EmptyState t={t} onPick={(q) => setDraft(q)} />
            ) : null}

            {turns.map((turn, i) => (
              <TurnView key={i} turn={turn} t={t} />
            ))}

            {pending.map((p) => (
              <ApprovalCard
                key={p.id}
                call={p}
                busy={busy}
                t={t}
                onApprove={() => void decide(true, p.id)}
                onReject={() => void decide(false, p.id)}
              />
            ))}

            {pending.length > 1 ? (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => void decide(false)} disabled={busy}>
                  {t('assistant.reject_all')}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void decide(true)} disabled={busy}>
                  {t('assistant.approve_all')}
                </Button>
              </div>
            ) : null}

            {busy ? <Thinking t={t} /> : null}
            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div ref={endRef} />
          </div>

          <Composer
            value={draft}
            onChange={setDraft}
            attachments={attachments}
            onAttach={(f) => void attach(f)}
            onRemoveAttachment={removeAttachment}
            onSubmit={() => void send()}
            busy={busy}
            t={t}
          />
        </div>
      </div>
    </PageContainer>
  )
}

function TurnView({ turn, t }: { turn: Turn; t: T }) {
  if (turn.kind === 'event') {
    return (
      <p
        className="text-center text-[11px] text-muted-foreground"
        data-testid="assistant-turn-event"
      >
        {turn.text}
      </p>
    )
  }

  if (turn.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-1.5">
          {turn.attachments && turn.attachments.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              {turn.attachments.map((a, i) =>
                a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={a.previewUrl}
                    alt={a.name}
                    className="h-20 w-20 rounded-md border border-border object-cover"
                  />
                ) : (
                  <span
                    key={i}
                    className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px]"
                  >
                    {a.name}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {turn.text ? (
            <div
              className="whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground"
              data-testid="assistant-turn-user"
            >
              {turn.text}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] space-y-2" data-testid="assistant-turn-assistant">
        {turn.text ? (
          <div className="rounded-lg rounded-bl-sm bg-subtle px-3 py-2 text-foreground">
            <Markdown>{turn.text}</Markdown>
          </div>
        ) : null}
        <ToolResults
          calls={turn.calls}
          label={(n) => t('assistant.consulted', { count: n })}
        />
      </div>
    </div>
  )
}

function Thinking({ t }: { t: T }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      {t('assistant.thinking')}
    </div>
  )
}

const SUGGESTION_KEYS = [
  'assistant.suggest_overview',
  'assistant.suggest_volume',
  'assistant.suggest_spend',
  'assistant.suggest_csat',
]

function EmptyState({ t, onPick }: { t: T; onPick: (q: string) => void }) {
  return (
    <div className="space-y-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">{t('assistant.empty')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTION_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(t(key))}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-subtle/60 hover:text-foreground"
          >
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  )
}
