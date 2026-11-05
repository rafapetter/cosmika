'use client'

import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Suspense, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button, Input, Label } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'

function ResetPasswordForm() {
  const t = useTranslations()
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError(t('auth.passwords_dont_match'))
      return
    }
    if (password.length < 8) {
      setError(t('auth.password_min'))
      return
    }
    setSubmitting(true)
    try {
      await api.resetPassword({ token, password })
      setDone(true)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
        setError(t('auth.reset_invalid'))
      } else {
        setError(t('auth.generic_error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen w-full items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm space-y-7">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </span>
          {t('brand.name')}
        </div>
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('auth.reset_title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.reset_subtitle')}</p>
        </header>
        {done ? (
          <div className="space-y-4">
            <p
              className="rounded-md bg-success/10 px-3 py-2 text-sm text-success"
              data-testid="reset-done"
            >
              {t('auth.reset_done')}
            </p>
            <Button asChild variant="primary" className="w-full">
              <a href="/sign-in">{t('auth.sign_in')}</a>
            </Button>
          </div>
        ) : !token ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {t('auth.reset_invalid')}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="password">{t('auth.new_password')}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="reset-password"
              />
              <p className="text-xs text-muted-foreground">{t('auth.password_min')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">{t('auth.confirm_password')}</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                data-testid="reset-confirm"
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
              disabled={submitting || !password || !confirm}
              data-testid="reset-submit"
            >
              {submitting ? t('common.loading') : t('auth.reset_submit')}
            </Button>
          </form>
        )}
        <p className="text-center text-sm text-muted-foreground">
          <a
            href="/forgot-password"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t('auth.forgot_password')}
          </a>
        </p>
      </div>
    </main>
  )
}

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary during prerender.
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  )
}
