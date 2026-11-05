'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { AccountWithMembers, Role } from '@cosmika/shared'
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
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR', 'AGENT', 'BOT']

export default function MembersPage() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [account, setAccount] = React.useState<AccountWithMembers | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      const a = await api.getAccount(
        session.session.token,
        session.account.id,
      )
      setAccount(a)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void reload()
  }, [reload])

  if (!session) return null

  const isAdmin = session.membership.role === 'ADMINISTRATOR'

  async function onInvite(email: string, fullName: string, role: Role) {
    if (!session) return
    try {
      await api.inviteMember(session.session.token, session.account.id, {
        email,
        fullName,
        role,
      })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onChangeRole(userId: string, role: Role) {
    if (!session) return
    try {
      await api.changeMemberRole(session.session.token, session.account.id, userId, {
        role,
      })
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onRemove(userId: string, email: string) {
    if (!session) return
    if (!confirm(t('members.remove_confirm', { email }))) return
    try {
      await api.removeMember(session.session.token, session.account.id, userId)
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('members.title')}
        subtitle={t('members.subtitle')}
      />

      {!isAdmin ? (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('members.admin_only')}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {isAdmin ? <InviteForm onInvite={onInvite} /> : null}

      {account === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {account.members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {m.user.fullName ?? m.user.email}
                  {m.userId === session.user.id ? (
                    <span className="ml-2 text-xs text-muted-foreground">{t('members.you')}</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.user.email}
                </p>
              </div>
              {isAdmin && m.userId !== session.user.id ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={m.role}
                    onValueChange={(v) => onChangeRole(m.userId, v as Role)}
                  >
                    <SelectTrigger
                      className="h-8 w-36 text-xs"
                      aria-label={t('members.role_for', { email: m.user.email })}
                      data-testid={`role-${m.userId}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {t(`members.role_${r.toLowerCase()}` as never)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRemove(m.userId, m.user.email)}
                  >
                    {t('members.remove')}
                  </Button>
                </div>
              ) : (
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t(`members.role_${m.role.toLowerCase()}` as never)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  )
}

function InviteForm({
  onInvite,
}: {
  onInvite: (email: string, fullName: string, role: Role) => Promise<void>
}) {
  const t = useTranslations()
  const [email, setEmail] = React.useState('')
  const [fullName, setFullName] = React.useState('')
  const [role, setRole] = React.useState<Role>('AGENT')
  const [submitting, setSubmitting] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setSubmitting(true)
    try {
      await onInvite(email.trim(), fullName.trim(), role)
      setEmail('')
      setFullName('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid items-end gap-2 rounded-lg border border-border bg-card p-4 sm:grid-cols-[1fr_1fr_140px_auto]"
    >
      <FormField label={t('members.invite_email')} htmlFor="invite-email" required>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('members.invite_email_placeholder')}
          required
        />
      </FormField>
      <FormField label={t('members.invite_name')} htmlFor="invite-name">
        <Input
          id="invite-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder={t('members.invite_name_placeholder')}
        />
      </FormField>
      <FormField label={t('members.invite_role')} htmlFor="invite-role">
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger id="invite-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`members.role_${r.toLowerCase()}` as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <Button
        type="submit"
        variant="primary"
        disabled={submitting || !email.trim()}
        data-testid="invite-member"
      >
        {submitting ? t('members.inviting') : t('members.invite')}
      </Button>
    </form>
  )
}
