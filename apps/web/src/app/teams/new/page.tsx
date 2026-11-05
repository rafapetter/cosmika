'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button, Input, Label } from '@cosmika/ui'

import { ApiError, api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'

export default function NewTeamPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
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
    setError(null)
    setSubmitting(true)
    try {
      const team = await api.createTeam(
        session.session.token,
        session.account.id,
        { name, description: description || null },
      )
      router.push(`/teams/${team.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('teams.forbidden'))
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
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('teams.new_title')}
          </h1>
        </header>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between">
            <Link
              href="/teams"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('teams.back_to_list')}
            </Link>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.loading') : t('teams.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
      </main>
  )
}
