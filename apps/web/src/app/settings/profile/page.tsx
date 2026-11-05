'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { Locale } from '@cosmika/shared'
import {
  Button,
  FormField,
  FormSection,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
]

export default function ProfileSettingsPage() {
  const t = useTranslations()
  const { session, setSession } = useStoredSession()

  if (!session) return null

  return (
    <PageContainer>
      <PageHeader
        title={t('profilePage.title')}
        subtitle={t('profilePage.subtitle')}
      />
      <ProfileForm
        session={session}
        setSession={setSession}
        t={t}
      />
      <NotificationPreferences session={session} />
      <PasswordForm session={session} t={t} />
    </PageContainer>
  )
}

function NotificationPreferences({ session }: { session: Session }) {
  const t = useTranslations()
  const [prefs, setPrefs] = React.useState<{
    mentionsEnabled: boolean
    assignmentsEnabled: boolean
  } | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    api
      .getNotificationPreferences(session.session.token, session.account.id)
      .then(setPrefs)
      .catch(() => setPrefs({ mentionsEnabled: true, assignmentsEnabled: true }))
  }, [session])

  async function toggle(field: 'mentionsEnabled' | 'assignmentsEnabled') {
    if (!prefs) return
    const next = { ...prefs, [field]: !prefs[field] }
    setPrefs(next) // optimistic
    setBusy(true)
    try {
      const saved = await api.updateNotificationPreferences(
        session.session.token,
        session.account.id,
        { [field]: next[field] },
      )
      setPrefs(saved)
    } catch {
      setPrefs(prefs) // revert
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="notification-preferences"
    >
      <div>
        <h2 className="text-sm font-semibold">{t('profilePage.notifications')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('profilePage.notifications_hint')}
        </p>
      </div>
      {prefs === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-2">
          <ToggleRow
            label={t('profilePage.pref_mentions')}
            help={t('profilePage.pref_mentions_help')}
            checked={prefs.mentionsEnabled}
            disabled={busy}
            onChange={() => toggle('mentionsEnabled')}
            testid="pref-mentions"
          />
          <ToggleRow
            label={t('profilePage.pref_assignments')}
            help={t('profilePage.pref_assignments_help')}
            checked={prefs.assignmentsEnabled}
            disabled={busy}
            onChange={() => toggle('assignmentsEnabled')}
            testid="pref-assignments"
          />
        </div>
      )}
    </section>
  )
}

function ToggleRow({
  label,
  help,
  checked,
  disabled,
  onChange,
  testid,
}: {
  label: string
  help: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
  testid: string
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
        data-testid={testid}
      />
    </label>
  )
}

type Session = NonNullable<ReturnType<typeof useStoredSession>['session']>
type SetSession = ReturnType<typeof useStoredSession>['setSession']
type T = ReturnType<typeof useTranslations>

function ProfileForm({
  session,
  setSession,
  t,
}: {
  session: Session
  setSession: SetSession
  t: T
}) {
  const [fullName, setFullName] = React.useState(session.user.fullName ?? '')
  const [avatarUrl, setAvatarUrl] = React.useState(session.user.avatarUrl ?? '')
  const validLocales: Locale[] = ['pt-BR', 'es', 'en']
  const [locale, setLocale] = React.useState<Locale>(
    validLocales.includes(session.user.locale as Locale)
      ? (session.user.locale as Locale)
      : 'en',
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    setSaving(true)
    try {
      const user = await api.updateMe(session.session.token, {
        fullName: fullName.trim(),
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
        locale,
      })
      const next = { ...session, user }
      setSession(next)
      window.localStorage.setItem('cosmika.session', JSON.stringify(next))
      setSaved(true)
    } catch (err) {
      setError(
        apiErrorText(t, err),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 className="text-sm font-semibold text-foreground">{t('profilePage.personal_info')}</h2>
      <FormSection className="grid gap-3 space-y-0 sm:grid-cols-2">
        <FormField label={t('profilePage.full_name')} htmlFor="profile-full-name" required>
          <Input
            id="profile-full-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t('profilePage.full_name_placeholder')}
            required
          />
        </FormField>
        <FormField label={t('profilePage.email')} htmlFor="profile-email">
          <Input id="profile-email" value={session.user.email} disabled />
        </FormField>
        <FormField label={t('profilePage.avatar_url')} htmlFor="profile-avatar">
          <Input
            id="profile-avatar"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            placeholder="https://…"
          />
        </FormField>
        <FormField label={t('profilePage.language')} htmlFor="profile-locale">
          <Select
            value={locale}
            onValueChange={(v) => setLocale(v as Locale)}
          >
            <SelectTrigger id="profile-locale" aria-label={t('profilePage.language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </FormSection>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('profilePage.saved')}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !fullName.trim()}
        >
          {saving ? t('profilePage.saving') : t('profilePage.save')}
        </Button>
      </div>
    </form>
  )
}

function PasswordForm({ session, t }: { session: Session; t: T }) {
  const [currentPassword, setCurrent] = React.useState('')
  const [newPassword, setNew] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (newPassword.length < 8) {
      setError(t('profilePage.password_too_short'))
      return
    }
    if (newPassword !== confirm) {
      setError(t('profilePage.password_mismatch'))
      return
    }
    setSaving(true)
    try {
      await api.changePassword(session.session.token, {
        currentPassword,
        newPassword,
      })
      setCurrent('')
      setNew('')
      setConfirm('')
      setSaved(true)
    } catch (err) {
      setError(
        apiErrorText(t, err),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-6 space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t('profilePage.change_password')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t('profilePage.password_hint', { email: session.user.email })}
        </p>
      </div>
      <FormSection className="grid gap-3 space-y-0 sm:grid-cols-2">
        <FormField
          label={t('profilePage.current_password')}
          htmlFor="pw-current"
          className="sm:col-span-2"
        >
          <Input
            id="pw-current"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </FormField>
        <FormField label={t('profilePage.new_password')} htmlFor="pw-new">
          <Input
            id="pw-new"
            type="password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </FormField>
        <FormField label={t('profilePage.confirm_password')} htmlFor="pw-confirm">
          <Input
            id="pw-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </FormField>
      </FormSection>
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('profilePage.password_updated')}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={
            saving ||
            !currentPassword ||
            newPassword.length < 8 ||
            newPassword !== confirm
          }
        >
          {saving ? t('profilePage.updating') : t('profilePage.update_password')}
        </Button>
      </div>
    </form>
  )
}
