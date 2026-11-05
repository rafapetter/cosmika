'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button, Input, Label } from '@cosmika/ui'

import { api } from '../../lib/api'

export default function ForgotPasswordPage() {
  const t = useTranslations()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await api.forgotPassword(email.trim())
      setSent(true)
    } catch {
      // The endpoint never reveals account existence; any failure here is
      // transport-level.
      setError(t('auth.generic_error'))
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
            {t('auth.forgot_title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('auth.forgot_subtitle')}</p>
        </header>
        {sent ? (
          <p
            className="rounded-md bg-success/10 px-3 py-2 text-sm text-success"
            data-testid="forgot-sent"
          >
            {t('auth.forgot_sent')}
          </p>
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
                data-testid="forgot-email"
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
              disabled={submitting || !email}
              data-testid="forgot-submit"
            >
              {submitting ? t('common.loading') : t('auth.forgot_submit')}
            </Button>
          </form>
        )}
        <p className="text-center text-sm text-muted-foreground">
          <a
            href="/sign-in"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {t('auth.back_to_sign_in')}
          </a>
        </p>
      </div>
    </main>
  )
}
