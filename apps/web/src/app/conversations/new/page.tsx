'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import type {
  ContactDTO,
  CreateConversationInput,
  InboxDTO,
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

export default function NewConversationPage() {
  const t = useTranslations()
  const router = useRouter()
  const search = useSearchParams()
  const { session, ready } = useStoredSession()
  const [contacts, setContacts] = useState<ContactDTO[]>([])
  const [inboxes, setInboxes] = useState<InboxDTO[]>([])
  const [contactId, setContactId] = useState(search.get('contactId') ?? '')
  const [inboxId, setInboxId] = useState(search.get('inboxId') ?? '')
  const [initialMessage, setInitialMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    Promise.all([
      api.listContacts(session.session.token, session.account.id, {
        limit: 50,
      }),
      api.listInboxes(session.session.token, session.account.id),
    ])
      .then(([contactsPage, inboxesList]) => {
        setContacts(contactsPage.data)
        setInboxes(inboxesList)
      })
      .catch(() => {
        setError(t('auth.generic_error'))
      })
  }, [ready, session, router, t])

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
    if (!session || !contactId || !inboxId) {
      setError(t('conversations.no_contact_inbox'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: CreateConversationInput = {
        contactId,
        inboxId,
        ...(initialMessage && {
          initialMessage: {
            senderType: 'USER',
            content: initialMessage,
            contentType: 'TEXT',
            isPrivate: false,
          },
        }),
      }
      const conv = await api.createConversation(
        session.session.token,
        session.account.id,
        body,
      )
      router.push(`/conversations/${conv.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('conversations.forbidden'))
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
            {t('conversations.new_title')}
          </h1>
        </header>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="contactId">{t('conversations.contact')}</Label>
            <Select value={contactId} onValueChange={setContactId} required>
              <SelectTrigger id="contactId">
                <SelectValue placeholder={t('conversations.select_contact')} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name ?? c.email ?? c.phoneNumber ?? c.identifier ?? c.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inboxId">{t('conversations.inbox')}</Label>
            <Select value={inboxId} onValueChange={setInboxId} required>
              <SelectTrigger id="inboxId">
                <SelectValue placeholder={t('conversations.select_inbox')} />
              </SelectTrigger>
              <SelectContent>
                {inboxes.map((ib) => (
                  <SelectItem key={ib.id} value={ib.id}>
                    {ib.name} ({t(`inboxes.channel_${ib.channelType.toLowerCase()}` as never)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="initialMessage">
              {t('conversations.initial_message')}
            </Label>
            <Input
              id="initialMessage"
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between">
            <Link
              href="/conversations"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('conversations.back_to_list')}
            </Link>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.loading') : t('conversations.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
      </main>
  )
}
