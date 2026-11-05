'use client'

import type { Route } from 'next'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button, Input, Label } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { writeSession } from '../../lib/session-store'

export default function SignInPage() {
  const t = useTranslations()
  const router = useRouter()
  const searchParams = useSearchParams()
  // Where an expired session bounced the user from; same-origin paths only,
  // so a crafted `next` can't turn sign-in into an open redirect.
  const raw = searchParams.get('next')
  // `typedRoutes` can't know a runtime path; the guards above are the check.
  const next = (
    raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/inbox'
  ) as Route
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')

  // Same reason as sign-up: have the destination loaded before it is needed.
  useEffect(() => {
    router.prefetch(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await api.signIn({ email, password })
      if ('kind' in result && result.kind === 'totp') {
        setChallengeToken(result.challengeToken)
        setSubmitting(false)
      } else if ('session' in result) {
        writeSession(result)
        // Stays disabled until the page goes away (see sign-up).
        router.push(next)
      }
    } catch (err) {
      setSubmitting(false)
      if (err instanceof ApiError && err.status === 401) {
        setError(t('auth.invalid_credentials'))
      } else {
        setError(t('auth.generic_error'))
      }
    }
  }

  async function onTotpSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challengeToken) return
    setError(null)
    setSubmitting(true)
    try {
      const envelope = await api.totpChallenge(challengeToken, totpCode.trim())
      writeSession(envelope)
      router.push(next)
    } catch (err) {
      setSubmitting(false)
      if (err instanceof ApiError && err.status === 401) {
        setError(t('auth.totp_invalid'))
      } else {
        setError(t('auth.generic_error'))
      }
    }
  }

  return (
    <main className="flex min-h-screen w-full">
      {/* Left: form */}
      <div className="flex w-full flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-7">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" />
            </span>
            {t('brand.name')}
          </div>
          <header className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('auth.sign_in_title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('auth.sign_in_subtitle')}
            </p>
          </header>
          {challengeToken ? (
            <form onSubmit={onTotpSubmit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="totp">{t('auth.totp_label')}</Label>
                <Input
                  id="totp"
                  name="totp"
                  required
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder={t('auth.totp_placeholder')}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  className="font-mono"
                  data-testid="signin-totp"
                />
                <p className="text-xs text-muted-foreground">
                  {t('auth.totp_hint')}
                </p>
              </div>
              {error ? (
                <p
                  className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                disabled={submitting || !totpCode}
              >
                {submitting ? t('common.loading') : t('auth.continue')}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setChallengeToken(null)
                  setTotpCode('')
                  setError(null)
                }}
                className="block w-full text-center text-xs text-muted-foreground hover:underline"
              >
                ← {t('auth.back_to_password')}
              </button>
            </form>
          ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <a
                  href="/forgot-password"
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  data-testid="signin-forgot"
                >
                  {t('auth.forgot_password')}
                </a>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={submitting}
            >
              {submitting ? t('common.loading') : t('auth.submit_sign_in')}
            </Button>
          </form>
          )}
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.no_account')}{' '}
            <a
              href="/sign-up"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('auth.sign_up')}
            </a>
          </p>
        </div>
      </div>

      {/* Right: brand panel (hidden on small) */}
      <aside className="relative hidden flex-1 items-center justify-center overflow-hidden border-l border-border bg-surface lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--primary)/0.12),transparent_55%)]" />
        <div className="relative max-w-md px-12">
          <p className="text-sm uppercase tracking-wider text-muted-foreground">
            {t('brand.name')}
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight">
            {t('brand.tagline')}
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            {t('auth.sign_in_aside')}
          </p>
        </div>
      </aside>
    </main>
  )
}
