'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { CreateContactInput } from '@cosmika/shared'
import { Button, Input, Label } from '@cosmika/ui'

import { ApiError, api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'

export default function NewContactPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!ready) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }
  if (!session) {
    router.replace('/sign-in')
    return null
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return
    if (!email && !phoneNumber && !identifier) {
      setError(t('contacts.at_least_one_required'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: CreateContactInput = {
        ...(name && { name }),
        ...(email && { email }),
        ...(phoneNumber && { phoneNumber }),
        ...(identifier && { identifier }),
      }
      const contact = await api.createContact(
        session.session.token,
        session.account.id,
        body,
      )
      router.push(`/contacts/${contact.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('contacts.forbidden'))
      } else if (err instanceof ApiError && err.status === 400) {
        setError(t('contacts.at_least_one_required'))
      } else {
        setError(t('auth.generic_error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('contacts.new_title')}
          </h1>
        </header>

        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">{t('contacts.name')}</Label>
            <Input
              id="name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t('contacts.email')}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phoneNumber">{t('contacts.phone_number')}</Label>
            <Input
              id="phoneNumber"
              name="phoneNumber"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="identifier">{t('contacts.identifier')}</Label>
            <Input
              id="identifier"
              name="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('contacts.identifier_help')}
            </p>
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between">
            <Link
              href="/contacts"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('contacts.back_to_list')}
            </Link>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.loading') : t('contacts.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
      </main>
  )
}
