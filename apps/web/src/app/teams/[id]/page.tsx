'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import type {
  AccountWithMembers,
  TeamWithMembersDTO,
} from '@cosmika/shared'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { ApiError, api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'

export default function TeamDetailPage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const teamId = params.id
  const { session, ready } = useStoredSession()

  const [team, setTeam] = useState<TeamWithMembersDTO | null>(null)
  const [account, setAccount] = useState<AccountWithMembers | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [memberToAdd, setMemberToAdd] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!session) return
    const [tm, acc] = await Promise.all([
      api.getTeam(session.session.token, session.account.id, teamId),
      api.getAccount(session.session.token, session.account.id),
    ])
    setTeam(tm)
    setAccount(acc)
    setName(tm.name)
    setDescription(tm.description ?? '')
  }, [session, teamId])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    refresh().catch((err) => {
      if (err instanceof ApiError && err.status === 403) {
        setLoadError(t('teams.forbidden'))
      } else if (err instanceof ApiError && err.status === 404) {
        router.replace('/teams')
      } else {
        setLoadError(t('auth.generic_error'))
      }
    })
  }, [ready, session, router, refresh, t])

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }
  if (loadError) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
        <Link
          href="/teams"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('teams.back_to_list')}
        </Link>
      </div>
      </main>
    )
  }
  if (!team || !account) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
      </main>
    )
  }

  const invitable = account.members.filter(
    (m) => !team.members.some((tm) => tm.userId === m.userId),
  )

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return
    setActionError(null)
    setSaving(true)
    try {
      await api.updateTeam(session.session.token, session.account.id, teamId, {
        name,
        description: description || null,
      })
      await refresh()
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 403
          ? t('teams.forbidden')
          : t('auth.generic_error'),
      )
    } finally {
      setSaving(false)
    }
  }

  async function onAddMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !memberToAdd) return
    setActionError(null)
    try {
      await api.addTeamMember(
        session.session.token,
        session.account.id,
        teamId,
        { userId: memberToAdd },
      )
      setMemberToAdd('')
      await refresh()
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 403
          ? t('teams.forbidden')
          : t('auth.generic_error'),
      )
    }
  }

  async function onRemoveMember(userId: string) {
    if (!session) return
    setActionError(null)
    try {
      await api.removeTeamMember(
        session.session.token,
        session.account.id,
        teamId,
        userId,
      )
      await refresh()
    } catch {
      setActionError(t('auth.generic_error'))
    }
  }

  async function onDelete() {
    if (!session) return
    if (!window.confirm(t('teams.confirm_delete'))) return
    try {
      await api.deleteTeam(session.session.token, session.account.id, teamId)
      router.push('/teams')
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status === 403
          ? t('teams.forbidden')
          : t('auth.generic_error'),
      )
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('teams.edit_title')}
          </h1>
        </header>
        {actionError ? (
          <p className="text-sm text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}
        <form onSubmit={onSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('teams.name')}</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">{t('teams.description')}</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Link
              href="/teams"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('teams.back_to_list')}
            </Link>
            <Button type="submit" disabled={saving} data-testid="save-team">
              {saving ? t('common.loading') : t('teams.save_changes')}
            </Button>
          </div>
        </form>

        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="font-semibold">{t('teams.members')}</h2>
          {team.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('teams.members_empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {team.members.map((m) => (
                <li key={m.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm font-medium">
                      {m.user.fullName ?? m.user.email}
                    </p>
                    <p className="text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemoveMember(m.userId)}
                    data-testid={`remove-${m.userId}`}
                  >
                    {t('teams.remove_member')}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {invitable.length > 0 ? (
            <form onSubmit={onAddMember} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="member">{t('teams.add_member')}</Label>
                <Select value={memberToAdd} onValueChange={setMemberToAdd}>
                  <SelectTrigger id="member">
                    <SelectValue placeholder={t('teams.select_member')} />
                  </SelectTrigger>
                  <SelectContent>
                    {invitable.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.user.fullName ?? m.user.email} ({t(`members.role_${m.role.toLowerCase()}` as never)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={!memberToAdd} data-testid="add-member">
                {t('teams.add_member')}
              </Button>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('teams.no_invitable_members')}
            </p>
          )}
        </section>

        <section className="rounded-md border border-destructive/30 p-4">
          <Button
            variant="destructive"
            onClick={onDelete}
            data-testid="delete-team"
          >
            {t('teams.delete')}
          </Button>
        </section>
      </div>
    </div>
      </main>
  )
}
