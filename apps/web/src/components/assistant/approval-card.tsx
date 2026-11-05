'use client'

import * as React from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@cosmika/ui'

import { keyLabel, toolLabel } from './labels'
import { Value } from './tool-result'

export type PendingCall = {
  id: string
  toolName: string
  input: Record<string, unknown>
}

/**
 * The moment a human decides. Everything here serves one question: what
 * exactly will change if I click approve?
 *
 * So the tool name is spelled out in words, every argument is shown (never a
 * summary — a hidden field is a change nobody agreed to), and the two buttons
 * are visually unequal, because approving is the consequential one.
 */
export function ApprovalCard({
  call,
  busy,
  t,
  onApprove,
  onReject,
}: {
  call: PendingCall
  busy: boolean
  t: (key: string) => string
  onApprove: () => void
  onReject: () => void
}) {
  const entries = Object.entries(call.input ?? {})
  return (
    <div
      className="overflow-hidden rounded-lg border border-amber-500/50 bg-amber-500/[0.04]"
      data-testid="assistant-approval"
    >
      <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t('assistant.approval_needed')}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {toolLabel(t as never, call.toolName)}
          </p>
        </div>
      </div>

      {entries.length > 0 ? (
        <dl className="divide-y divide-border/60">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-3 px-3 py-1.5 text-xs">
              <dt className="w-32 shrink-0 text-muted-foreground">{keyLabel(t as never, k)}</dt>
              <dd className="min-w-0 flex-1 break-words font-medium text-foreground">
                <Value name={k} value={v} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t('assistant.approval_no_fields')}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
          {t('assistant.reject')}
        </Button>
        <Button variant="primary" size="sm" onClick={onApprove} disabled={busy}>
          {t('assistant.approve')}
        </Button>
      </div>
    </div>
  )
}
