'use client'

// "Test bot" chat panel — the builder's viewer. Runs the DRAFT definition
// through the real FlowEngine via the stateless preview endpoint; the panel
// holds the runtime state between steps. Page-coupled component (e2e-tested).

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { FlowPreviewEmission, FlowPreviewResultDTO } from '@cosmika/shared'
import { Button, Input } from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'

type ChatItem =
  | { role: 'bot'; text: string }
  | { role: 'bot-media'; url: string; caption?: string | null }
  | { role: 'user'; text: string }
  | {
      role: 'bot-buttons'
      body: string
      buttons: { id: string; label: string }[]
      answered: boolean
    }

export function PreviewPanel({
  token,
  accountId,
  flowId,
  onClose,
}: {
  token: string
  accountId: string
  flowId: string
  onClose: () => void
}) {
  const t = useTranslations()
  const [items, setItems] = React.useState<ChatItem[]>([])
  const [state, setState] = React.useState<FlowPreviewResultDTO['state'] | null>(null)
  const [status, setStatus] = React.useState<string>('running')
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const ingest = React.useCallback((r: FlowPreviewResultDTO) => {
    const additions: ChatItem[] = []
    for (const e of r.emissions as FlowPreviewEmission[]) {
      if (e.kind === 'text') additions.push({ role: 'bot', text: e.text })
      else if (e.kind === 'media') additions.push({ role: 'bot-media', url: e.url, caption: e.caption })
      else if (e.kind === 'interactive') {
        const buttons =
          e.content.kind === 'buttons'
            ? (e.content.buttons ?? [])
            : (e.content.sections ?? []).flatMap((s) => s.rows)
        additions.push({ role: 'bot-buttons', body: e.content.body, buttons, answered: false })
      }
    }
    setItems((prev) => [...prev, ...additions])
    setState(r.state)
    setStatus(r.status)
  }, [])

  const start = React.useCallback(async () => {
    setItems([])
    setState(null)
    setStatus('running')
    setError(null)
    setBusy(true)
    try {
      ingest(await api.previewFlow(token, accountId, flowId, {}))
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }, [token, accountId, flowId, ingest, t])

  React.useEffect(() => {
    void start()
  }, [start])

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  async function reply(text: string, interactiveReplyId?: string) {
    if (!state || busy) return
    setBusy(true)
    setError(null)
    setItems((prev) =>
      prev
        .map((it) => (it.role === 'bot-buttons' ? { ...it, answered: true } : it))
        .concat([{ role: 'user', text }]),
    )
    try {
      ingest(
        await api.previewFlow(token, accountId, flowId, {
          state: state as never,
          input: { text, interactiveReplyId: interactiveReplyId ?? null },
        }),
      )
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const waiting = status === 'waiting'

  return (
    <div
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-card"
      data-testid="preview-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">{t('flows.test_bot')}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            waiting
              ? 'bg-warning/15 text-warning'
              : status === 'completed'
                ? 'bg-success/15 text-success'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {t(`flows.preview_status_${status}` as never)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void start()}
            className="h-7 px-2 text-xs"
            data-testid="preview-restart"
          >
            {t('flows.preview_restart')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="h-7 px-2 text-xs text-muted-foreground"
            aria-label={t('flows.close')}
          >
            ✕
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {items.map((it, i) => {
          if (it.role === 'user') {
            return (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-xs text-primary-foreground">
                  {it.text}
                </div>
              </div>
            )
          }
          if (it.role === 'bot-media') {
            return (
              <div key={i} className="flex">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-xs">
                  <a href={it.url} target="_blank" rel="noreferrer" className="underline">
                    {it.caption || it.url}
                  </a>
                </div>
              </div>
            )
          }
          if (it.role === 'bot-buttons') {
            return (
              <div key={i} className="space-y-1.5">
                <div className="flex">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-xs">
                    {it.body}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 pl-1">
                  {it.buttons.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      disabled={it.answered || busy}
                      onClick={() => void reply(b.label, b.id)}
                      className="rounded-full border border-primary/40 px-2.5 py-1 text-[11px] text-primary hover:bg-primary/10 disabled:opacity-40"
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          }
          return (
            <div key={i} className="flex">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5 text-xs">
                {it.text}
              </div>
            </div>
          )
        })}
        {status === 'completed' ? (
          <p className="pt-1 text-center text-[11px] text-muted-foreground">{t('flows.preview_completed')}</p>
        ) : null}
        {status === 'handoff' ? (
          <p className="pt-1 text-center text-[11px] text-muted-foreground">{t('flows.preview_handoff')}</p>
        ) : null}
        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      </div>

      <form
        className="flex gap-1.5 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault()
          const value = draft.trim()
          if (!value) return
          setDraft('')
          void reply(value)
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={waiting ? t('flows.preview_placeholder') : t('flows.preview_not_waiting')}
          disabled={!waiting || busy}
          className="h-8 min-w-0 flex-1 px-2 text-xs"
          data-testid="preview-input"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!waiting || busy} className="h-8 px-3 text-xs">
          {t('flows.preview_send')}
        </Button>
      </form>
    </div>
  )
}
