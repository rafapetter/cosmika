'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { AccountDTO, Locale } from '@cosmika/shared'
import { TIMEZONE_PRESETS } from '@cosmika/shared'
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
import { BusinessProfileForm } from '../../../components/business-profile-form'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
]

export default function AccountSettingsPage() {
  const t = useTranslations()
  const { session, setSession } = useStoredSession()

  if (!session) return null

  const isAdmin = session.membership.role === 'ADMINISTRATOR'

  return (
    <PageContainer>
      <PageHeader
        title={t('accountPage.title')}
        subtitle={t('accountPage.subtitle')}
      />
      {!isAdmin ? (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('accountPage.readonly_notice')}
        </p>
      ) : null}
      <AccountForm session={session} setSession={setSession} isAdmin={isAdmin} t={t} />
      <BusinessProfileForm isAdmin={isAdmin} />
    </PageContainer>
  )
}

type Session = NonNullable<ReturnType<typeof useStoredSession>['session']>
type SetSession = ReturnType<typeof useStoredSession>['setSession']
type T = ReturnType<typeof useTranslations>

function AccountForm({
  session,
  setSession,
  isAdmin,
  t,
}: {
  session: Session
  setSession: SetSession
  isAdmin: boolean
  t: T
}) {
  const account = session.account
  const [name, setName] = React.useState(account.name)
  const [domain, setDomain] = React.useState(account.domain ?? '')
  const validLocales: Locale[] = ['pt-BR', 'es', 'en']
  const [defaultLocale, setDefaultLocale] = React.useState<Locale>(
    validLocales.includes(account.defaultLocale as Locale)
      ? (account.defaultLocale as Locale)
      : 'en',
  )
  const [defaultTimezone, setDefaultTimezone] = React.useState(
    account.defaultTimezone || 'UTC',
  )
  // A session stored before this field existed has it undefined. Treat that as
  // "ask me" — the cautious reading, and what the database defaults to.
  const [requiresApproval, setRequiresApproval] = React.useState(
    account.adminAgentRequiresApproval !== false,
  )
  const [teamScoped, setTeamScoped] = React.useState(account.teamScopedVisibility === true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!isAdmin) return
    setError(null)
    setSaved(false)
    setSaving(true)
    try {
      const updated: AccountDTO = await api.updateAccount(
        session.session.token,
        account.id,
        {
          name: name.trim(),
          domain: domain.trim() ? domain.trim() : null,
          defaultLocale,
          defaultTimezone,
          adminAgentRequiresApproval: requiresApproval,
          teamScopedVisibility: teamScoped,
        },
      )
      const next = { ...session, account: updated }
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

  const fieldsetClass = !isAdmin ? 'pointer-events-none opacity-60' : ''

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 className="text-sm font-semibold text-foreground">{t('accountPage.workspace')}</h2>
      <div className={`grid gap-3 sm:grid-cols-2 ${fieldsetClass}`}>
        <FormField label={t('accountPage.account_name')} htmlFor="account-name" required>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('accountPage.account_name_placeholder')}
            required
            disabled={!isAdmin}
          />
        </FormField>
        <FormField
          label={t('accountPage.slug')}
          htmlFor="account-slug"
          hint={t('accountPage.slug_hint')}
        >
          <Input id="account-slug" value={account.slug} disabled />
        </FormField>
        <FormField label={t('accountPage.domain')} htmlFor="account-domain">
          <Input
            id="account-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.com"
            disabled={!isAdmin}
          />
        </FormField>
        <FormField label={t('accountPage.plan')} htmlFor="account-plan">
          <Input id="account-plan" value={account.plan} disabled />
        </FormField>
        <FormField label={t('accountPage.default_language')} htmlFor="account-locale">
          <Select
            value={defaultLocale}
            onValueChange={(v) => setDefaultLocale(v as Locale)}
            disabled={!isAdmin}
          >
            <SelectTrigger id="account-locale">
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
        <FormField
          label={t('accountPage.default_timezone')}
          htmlFor="account-timezone"
          hint={t('accountPage.timezone_hint')}
        >
          {/* Free text with suggestions: the IANA list is far too long for a
              Select, but operators usually want one of a handful. */}
          <Input
            id="account-timezone"
            list="cosmika-timezones"
            value={defaultTimezone}
            onChange={(e) => setDefaultTimezone(e.target.value)}
            disabled={!isAdmin}
            placeholder="UTC"
          />
          <datalist id="cosmika-timezones">
            {TIMEZONE_PRESETS.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </FormField>
      </div>

      <div className={`space-y-3 border-t border-border pt-4 ${fieldsetClass}`}>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('assistantSettings.heading')}
          </h2>
          <p className="pt-1 text-xs text-muted-foreground">
            {t('assistantSettings.description')}
          </p>
        </div>
        <ApprovalChoice
          checked={requiresApproval}
          onSelect={() => setRequiresApproval(true)}
          disabled={!isAdmin}
          label={t('assistantSettings.approval_label')}
          help={t('assistantSettings.approval_help')}
          testId="admin-agent-approval"
        />
        <ApprovalChoice
          checked={!requiresApproval}
          onSelect={() => setRequiresApproval(false)}
          disabled={!isAdmin}
          label={t('assistantSettings.auto_label')}
          help={t('assistantSettings.auto_help')}
          testId="admin-agent-auto"
        />
      </div>

      <div className={`space-y-3 border-t border-border pt-4 ${fieldsetClass}`}>
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('accountPage.queues_heading')}
          </h2>
          <p className="pt-1 text-xs text-muted-foreground">
            {t('accountPage.queues_description')}
          </p>
        </div>
        <label className="flex items-start gap-3 rounded-md border border-border p-3">
          <input
            type="checkbox"
            checked={teamScoped}
            onChange={(e) => setTeamScoped(e.target.checked)}
            disabled={!isAdmin}
            data-testid="team-scoped-visibility"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium text-foreground">
              {t('accountPage.team_scoped_label')}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t('accountPage.team_scoped_help')}
            </span>
          </span>
        </label>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('accountPage.saved')}</p>
      ) : null}

      {isAdmin ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim()}
          >
            {saving ? t('accountPage.saving') : t('accountPage.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

function ApprovalChoice({
  checked,
  onSelect,
  disabled,
  label,
  help,
  testId,
}: {
  checked: boolean
  onSelect: () => void
  disabled: boolean
  label: string
  help: string
  testId: string
}) {
  return (
    <label
      className={`flex gap-3 rounded-md border p-3 ${
        checked ? 'border-primary/60 bg-primary/5' : 'border-border'
      } ${disabled ? '' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name="adminAgentRequiresApproval"
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        data-testid={testId}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  )
}
