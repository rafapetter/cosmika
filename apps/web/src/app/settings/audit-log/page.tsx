'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { AccountMemberDTO, AuditLogDTO } from '@cosmika/shared'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { dayBoundary } from '../../../lib/day-boundary'
import { useDateTime } from '../../../lib/format-datetime'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

type T = ReturnType<typeof useTranslations>

// Actions the filter offers. Every action the API records has a label below;
// an action this build does not know yet falls back to its raw name.
const FILTER_ACTIONS = [
  'auth.login',
  'auth.logout',
  'message.sent',
  'conversation.resolved',
  'conversation.assigned',
  'account.update',
  'member.invite',
  'custom_attribute.create',
  'custom_attribute.update',
  'custom_attribute.delete',
  'webhook.create',
  'webhook.update',
  'webhook.delete',
]

const KNOWN_ACTIONS = new Set([
  ...FILTER_ACTIONS,
  'account.backup_downloaded',
  'account_profile.saved',
  'onboarding_flow.completed',
  'onboarding_flow.skipped',
  'admin_agent.set_inbox_ai_mode',
  'api_key.create',
  'api_key.revoke',
  'article.create',
  'article.delete',
  'article.update',
  'broadcast.send',
  'contact.anonymize',
  'contact.export',
  'data.export',
  'contact.import',
  'conversation.draft_discarded',
  'conversation.forward',
  'inbox.delete',
  'member.remove',
  'member.role',
  'message.retried',
  'sla_policy.create',
  'sla_policy.delete',
  'sla_policy.update',
  'system.cron',
  'ticket.updated',
])

function actionLabel(t: T, action: string): string {
  if (!KNOWN_ACTIONS.has(action)) return action
  return t(`auditLog.action_${action.replace(/\./g, '_')}` as never)
}



export default function AuditLogPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<AuditLogDTO[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [actionFilter, setActionFilter] = React.useState('')
  const [actorFilter, setActorFilter] = React.useState('')
  const [fromDay, setFromDay] = React.useState('')
  const [toDay, setToDay] = React.useState('')
  const [members, setMembers] = React.useState<AccountMemberDTO[]>([])

  React.useEffect(() => {
    if (!session) return
    api
      .listAccountMembers(session.session.token, session.account.id)
      .then(setMembers)
      .catch(() => setMembers([]))
  }, [session])

  const load = React.useCallback(
    async (reset: boolean) => {
      if (!session) return
      setLoading(true)
      setError(null)
      try {
        const page = await api.listAuditLogs(
          session.session.token,
          session.account.id,
          {
            cursor: reset ? undefined : cursor ?? undefined,
            action: actionFilter || undefined,
            actorId: actorFilter || undefined,
            from: fromDay ? dayBoundary(fromDay) : undefined,
            to: toDay ? dayBoundary(toDay, true) : undefined,
            limit: 50,
          },
        )
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]))
        setCursor(page.nextCursor)
      } catch (err) {
        setError(apiErrorText(t, err))
      } finally {
        setLoading(false)
      }
    },
    [session, cursor, actionFilter, actorFilter, fromDay, toDay, t],
  )

  React.useEffect(() => {
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.session.token, session?.account.id, actionFilter, actorFilter, fromDay, toDay])

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader title={t('auditLog.title')} subtitle={t('auditLog.subtitle')} />
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div
        className="grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="audit-filters"
      >
        <FormField label={t('auditLog.filter_by_action')} htmlFor="audit-action">
          <Select
            value={actionFilter === '' ? '__all__' : actionFilter}
            onValueChange={(v) => setActionFilter(v === '__all__' ? '' : v)}
          >
            <SelectTrigger id="audit-action" className="h-8 text-xs" aria-label={t('auditLog.filter_by_action')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('auditLog.filter_all')}</SelectItem>
              {FILTER_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {actionLabel(t, a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('auditLog.filter_by_user')} htmlFor="audit-actor">
          <Select
            value={actorFilter === '' ? '__all__' : actorFilter}
            onValueChange={(v) => setActorFilter(v === '__all__' ? '' : v)}
          >
            <SelectTrigger id="audit-actor" className="h-8 text-xs" aria-label={t('auditLog.filter_by_user')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('auditLog.filter_all_users')}</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  {m.user.fullName ?? m.user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('auditLog.filter_from')} htmlFor="audit-from">
          <Input
            id="audit-from"
            type="date"
            className="h-8 text-xs"
            value={fromDay}
            max={toDay || undefined}
            onChange={(e) => setFromDay(e.target.value)}
          />
        </FormField>
        <FormField label={t('auditLog.filter_to')} htmlFor="audit-to">
          <Input
            id="audit-to"
            type="date"
            className="h-8 text-xs"
            value={toDay}
            min={fromDay || undefined}
            onChange={(e) => setToDay(e.target.value)}
          />
        </FormField>
      </div>

      <div className="rounded-lg border border-border">
        {items.length === 0 && !loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {t('auditLog.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((row) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 text-sm">
                    <span className="text-xs font-medium text-primary">
                      {actionLabel(t, row.action)}
                    </span>
                    {row.target ? (
                      <span className="ml-2 break-all font-mono text-xs text-muted-foreground">
                        {row.target}
                      </span>
                    ) : null}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {fmt.dateTime(row.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('auditLog.by')}{' '}
                  {row.actor
                    ? `${row.actor.fullName ?? row.actor.email} (${row.actor.email})`
                    : t('auditLog.system')}
                </p>
                {row.metadata ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t('auditLog.payload')}
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-[11px]">
                      {JSON.stringify(row.metadata, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => load(false)}
            disabled={loading}
          >
            {loading ? t('common.loading') : t('auditLog.load_more')}
          </Button>
        </div>
      ) : null}
    </PageContainer>
  )
}
