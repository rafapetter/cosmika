'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { FlowCheckDTO } from '@cosmika/shared'

import { Button } from '@cosmika/ui'

/**
 * What the last publish found wrong with the flow.
 *
 * A warning, never a block: an author mid-build is entitled to publish half a
 * graph. What it must not do is stay quiet — the commercial menu carried an
 * orphan Condition chain from its import in April 2026 until a lead hit it in
 * September, and no screen ever said a word.
 *
 * Each line names the group so the author can find it on the canvas, and
 * clicking it scrolls there.
 */
export function PublishChecks({
  checks,
  onFocusGroup,
  onDismiss,
}: {
  checks: FlowCheckDTO[]
  onFocusGroup: (groupId: string) => void
  onDismiss: () => void
}) {
  const t = useTranslations()
  if (checks.length === 0) return null
  return (
    <div
      className="flex items-start gap-3 border-b bg-warning/10 px-3 py-2"
      data-testid="editor-checks"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t('flows.checks_title')}</p>
        <p className="text-[11px] text-muted-foreground">
          {t('flows.checks_intro', { count: checks.length })}
        </p>
        <ul className="mt-1 space-y-0.5">
          {checks.map((c, i) => (
            <li key={`${c.groupId}-${c.code}-${i}`} className="text-[11px]">
              <button
                type="button"
                className="underline underline-offset-2 hover:no-underline"
                onClick={() => onFocusGroup(c.groupId)}
                data-testid={`editor-check-${c.groupId}`}
              >
                {c.groupTitle}
              </button>
              {': '}
              <span className="text-muted-foreground">
                {t(`flows.check_${c.code}` as never)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onDismiss}
        data-testid="editor-checks-dismiss"
      >
        {t('common.close')}
      </Button>
    </div>
  )
}
