'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { TotpSetupResponse } from '@cosmika/shared'
import { Button, Input } from '@cosmika/ui'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

export default function SecurityPage() {
  const t = useTranslations()
  const { session } = useStoredSession()

  if (!session) return null

  const enabled = session.user.totpEnabled === true

  return (
    <PageContainer>
      <PageHeader
        title={t('security.title')}
        subtitle={t('security.subtitle')}
      />
      {enabled ? <Disable2FA /> : <Enable2FA />}
    </PageContainer>
  )
}

function Enable2FA() {
  const t = useTranslations()
  const { session, setSession } = useStoredSession()
  const [setup, setSetup] = React.useState<TotpSetupResponse | null>(null)
  const [code, setCode] = React.useState('')
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [working, setWorking] = React.useState(false)

  async function start() {
    if (!session) return
    setWorking(true)
    setError(null)
    try {
      const s = await api.totpSetup(session.session.token)
      setSetup(s)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setWorking(false)
    }
  }

  async function verify() {
    if (!session || !setup) return
    setWorking(true)
    setError(null)
    try {
      const r = await api.totpVerify(session.session.token, code)
      setRecoveryCodes(r.recoveryCodes)
      // Reflect totpEnabled on the session so the page state updates.
      const next = {
        ...session,
        user: { ...session.user, totpEnabled: true },
      }
      setSession(next)
      window.localStorage.setItem('cosmika.session', JSON.stringify(next))
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setWorking(false)
    }
  }

  if (recoveryCodes) {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/30">
        <h2 className="text-base font-semibold">{t('security.on_title')}</h2>
        <p className="text-sm text-muted-foreground">{t('security.recovery_hint')}</p>
        <ul className="grid grid-cols-2 gap-1 rounded bg-background p-3 font-mono text-xs">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button
          variant="outline"
          onClick={() => {
            const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'cosmika-recovery-codes.txt'
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(url)
          }}
        >
          {t('security.download_txt')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-5">
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!setup ? (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t('security.setup_title')}</h2>
          <p className="text-xs text-muted-foreground">{t('security.setup_hint')}</p>
          <Button onClick={start} variant="primary" disabled={working}>
            {working ? t('security.starting') : t('security.start')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">{t('security.verify_title')}</h2>
          <p className="text-xs text-muted-foreground">{t('security.verify_hint')}</p>
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('security.otpauth_label')}
            </p>
            <code className="mt-1 block break-all font-mono text-[11px]">
              {setup.otpauthUrl}
            </code>
            <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t('security.secret_label')}
            </p>
            <code className="mt-1 block font-mono text-xs tracking-wider">
              {setup.secret}
            </code>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="block text-xs font-medium text-muted-foreground">
                {t('security.code_label')}
              </span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                pattern="[0-9]{6}"
                className="font-mono"
                data-testid="totp-code"
              />
            </label>
            <Button
              variant="primary"
              onClick={verify}
              disabled={code.length !== 6 || working}
              data-testid="totp-verify"
            >
              {working ? t('security.verifying') : t('security.activate')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Disable2FA() {
  const t = useTranslations()
  const { session, setSession } = useStoredSession()
  const [code, setCode] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [working, setWorking] = React.useState(false)

  async function disable() {
    if (!session) return
    setWorking(true)
    setError(null)
    try {
      await api.totpDisable(session.session.token, code)
      const next = {
        ...session,
        user: { ...session.user, totpEnabled: false },
      } as typeof session
      setSession(next)
      window.localStorage.setItem('cosmika.session', JSON.stringify(next))
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-semibold">{t('security.enabled_title')}</h2>
      <p className="text-xs text-muted-foreground">{t('security.disable_hint')}</p>
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="block text-xs font-medium text-muted-foreground">
            {t('security.disable_code_label')}
          </span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="font-mono"
            data-testid="totp-disable-code"
          />
        </label>
        <Button variant="destructive" onClick={disable} disabled={!code || working}>
          {working ? t('security.disabling') : t('security.disable')}
        </Button>
      </div>
    </div>
  )
}
