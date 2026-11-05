'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button, Input, Label } from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { writeSession } from '../../lib/session-store'

export default function SignUpPage() {
  const t = useTranslations()
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch /welcome while the person is still typing. Over a slow or lossy
  // link (20/10/2026: 500 ms round trip and 35% loss to the box) the route's
  // payload and chunks cost seconds AFTER the account already existed.
  useEffect(() => {
    router.prefetch('/welcome')
    // Once per mount; the router object is not a reason to fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError(t('auth.password_min'))
      return
    }
    setSubmitting(true)
    try {
      const envelope = await api.signUp({
        fullName,
        accountName,
        email,
        password,
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
      })
      writeSession(envelope)
      // Straight into the welcome flow. The account already exists and the
      // session is live, so every answer from here on is saved and attributed,
      // and anyone who walks away costs us nothing.
      router.push('/welcome')
      // The button stays disabled until the page goes away. router.push does
      // not wait for the navigation, so re-enabling it here offered "Create
      // account" again while /welcome loaded, and the second click answered
      // "email already registered" for the account just created.
    } catch (err) {
      setSubmitting(false)
      if (err instanceof ApiError && err.status === 403) {
        setError(t('auth.invite_required'))
      } else if (err instanceof ApiError && err.status === 409) {
        setError(t('auth.email_taken'))
      } else {
        setError(t('auth.generic_error'))
      }
    }
  }

  return (
    <main className="flex min-h-screen w-full">
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
              {t('auth.sign_up_title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('auth.sign_up_subtitle')}
            </p>
          </header>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="fullName">{t('auth.full_name')}</Label>
              <Input
                id="fullName"
                name="fullName"
                required
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="accountName">{t('auth.account_name')}</Label>
              <Input
                id="accountName"
                name="accountName"
                required
                autoComplete="organization"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
              />
            </div>
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
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inviteCode">{t('auth.invite_code')}</Label>
              <Input
                id="inviteCode"
                name="inviteCode"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                data-testid="signup-invite"
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
              {submitting ? t('common.loading') : t('auth.submit_sign_up')}
            </Button>
          </form>
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.have_account')}{' '}
            <a
              href="/sign-in"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t('auth.sign_in')}
            </a>
          </p>
        </div>
      </div>

      <aside className="relative hidden flex-1 items-center justify-center overflow-hidden border-l border-border bg-surface lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_30%,hsl(var(--primary)/0.12),transparent_55%)]" />
        <div className="relative max-w-md px-12">
          <p className="text-sm uppercase tracking-wider text-muted-foreground">
            {t('brand.name')}
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight">
            {t('brand.tagline')}
          </h2>
          <p className="mt-4 text-sm text-muted-foreground">
            {t('auth.sign_up_aside')}
          </p>
        </div>
      </aside>
    </main>
  )
}
