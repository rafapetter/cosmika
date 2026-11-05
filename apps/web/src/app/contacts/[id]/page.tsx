'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import type {
  ContactDTO,
  ContactWithInboxesDTO,
  UpdateContactInput,
  CustomAttributeDTO,
} from '@cosmika/shared'
import { Button, Input, Label, buttonVariants } from '@cosmika/ui'

import {
  ContactAttributeFields,
  mergeDefinedAttributes,
} from './_attribute-fields'
import { ApiError, api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'

export default function ContactDetailPage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const contactId = params.id
  const { session, ready } = useStoredSession()

  const [contact, setContact] = useState<ContactWithInboxesDTO | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  // Structured attribute editing (F3): the account's CONTACT definitions plus
  // this contact's stored values. Undefined keys ride along untouched.
  const [attrDefs, setAttrDefs] = useState<CustomAttributeDTO[]>([])
  const [attrValues, setAttrValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeResults, setMergeResults] = useState<ContactDTO[] | null>(null)
  const [selectedMerge, setSelectedMerge] = useState<string[]>([])
  const [merging, setMerging] = useState(false)

  const refresh = useCallback(async () => {
    if (!session) return
    const c = await api.getContact(
      session.session.token,
      session.account.id,
      contactId,
    )
    setContact(c)
    setName(c.name ?? '')
    setEmail(c.email ?? '')
    setPhoneNumber(c.phoneNumber ?? '')
    setIdentifier(c.identifier ?? '')
    setAvatarUrl(c.avatarUrl ?? '')
    setAttrValues((c.customAttributes ?? {}) as Record<string, unknown>)
    // Definitions are an enhancement: if they fail to load the contact still
    // edits, it just falls back to showing stored values as undefined extras.
    await api
      .listCustomAttributes(session.session.token, session.account.id, 'CONTACT')
      .then(setAttrDefs)
      .catch(() => setAttrDefs([]))
  }, [session, contactId])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    refresh().catch((err) => {
      if (err instanceof ApiError && err.status === 403) {
        setLoadError(t('contacts.forbidden'))
      } else if (err instanceof ApiError && err.status === 404) {
        router.replace('/contacts')
      } else {
        setLoadError(t('auth.generic_error'))
      }
    })
  }, [ready, session, router, refresh, t])

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
        <Link
          href="/contacts"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('contacts.back_to_list')}
        </Link>
      </div>
      </main>
    )
  }

  if (!contact) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
      </main>
    )
  }

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return
    setActionError(null)
    const parsedCustom = mergeDefinedAttributes(
      (contact?.customAttributes ?? {}) as Record<string, unknown>,
      attrValues,
    )

    setSaving(true)
    try {
      const body: UpdateContactInput = {
        name: name || null,
        email: email || null,
        phoneNumber: phoneNumber || null,
        identifier: identifier || null,
        avatarUrl: avatarUrl || null,
        customAttributes: parsedCustom,
      }
      await api.updateContact(
        session.session.token,
        session.account.id,
        contactId,
        body,
      )
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('contacts.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function onExport() {
    if (!session) return
    try {
      const bundle = await api.exportContact(
        session.session.token,
        session.account.id,
        contactId,
      )
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `contact-${contactId}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setActionError(apiErrorText(t, err))
    }
  }

  async function onAnonymize() {
    if (!session) return
    if (
      !window.confirm(
        t('contacts.anonymize_confirm'),
      )
    )
      return
    try {
      await api.anonymizeContact(
        session.session.token,
        session.account.id,
        contactId,
      )
      router.push('/contacts')
    } catch (err) {
      setActionError(apiErrorText(t, err))
    }
  }

  async function onDelete() {
    if (!session) return
    if (!window.confirm(t('contacts.confirm_delete'))) return
    try {
      await api.deleteContact(
        session.session.token,
        session.account.id,
        contactId,
      )
      router.push('/contacts')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('contacts.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    }
  }

  async function runMergeSearch() {
    if (!session) return
    try {
      const page = await api.listContacts(
        session.session.token,
        session.account.id,
        { q: mergeQuery.trim() || undefined, limit: 25 },
      )
      setMergeResults(page.data.filter((c) => c.id !== contactId))
    } catch {
      setMergeResults([])
    }
  }

  function toggleMerge(id: string) {
    setSelectedMerge((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= 5
          ? prev
          : [...prev, id],
    )
  }

  async function onMerge() {
    if (!session || selectedMerge.length === 0) {
      setActionError(t('contacts.merge_empty_selection'))
      return
    }
    setActionError(null)
    setMerging(true)
    try {
      await api.mergeContacts(
        session.session.token,
        session.account.id,
        contactId,
        { sourceContactIds: selectedMerge },
      )
      setSelectedMerge([])
      setMergeQuery('')
      setMergeResults(null)
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('contacts.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    } finally {
      setMerging(false)
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('contacts.edit_title')}
          </h1>
          {contact.lastActivityAt ? (
            <p className="text-xs text-muted-foreground">
              {t('contacts.last_activity')}: {contact.lastActivityAt}
            </p>
          ) : null}
        </header>

        {actionError ? (
          <p className="text-sm text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}

        <form onSubmit={onSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('contacts.name')}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t('contacts.email')}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phoneNumber">{t('contacts.phone_number')}</Label>
            <Input
              id="phoneNumber"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="identifier">{t('contacts.identifier')}</Label>
            <Input
              id="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="avatarUrl">{t('contacts.avatar_url')}</Label>
            <Input
              id="avatarUrl"
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('contacts.custom_attributes')}</Label>
            <ContactAttributeFields
              definitions={attrDefs}
              values={attrValues}
              disabled={saving}
              onChange={(key, value) =>
                setAttrValues((prev) => ({ ...prev, [key]: value }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Link
              href="/contacts"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('contacts.back_to_list')}
            </Link>
            <Button type="submit" disabled={saving} data-testid="save-contact">
              {saving ? t('common.loading') : t('contacts.save_changes')}
            </Button>
          </div>
        </form>

        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="font-semibold">{t('contacts.inboxes_using')}</h2>
          {contact.contactInboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('contacts.inboxes_using_empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {contact.contactInboxes.map((ci) => (
                <li
                  key={ci.id}
                  className="flex items-center justify-between py-2"
                >
                  <div>
                    <p className="text-sm font-medium">{ci.inboxName}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`inboxes.channel_${ci.channelType.toLowerCase()}` as never)}
                      {ci.sourceId ? ` · ${ci.sourceId}` : ''}
                    </p>
                  </div>
                  <Link
                    href={`/conversations/new?contactId=${contact.id}&inboxId=${ci.inboxId}`}
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'sm',
                    })}
                    data-testid={`open-conversation-${ci.inboxId}`}
                  >
                    {t('conversations.open_for')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="font-semibold">{t('contacts.merge_title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('contacts.merge_help')}
          </p>
          <div className="flex gap-2">
            <Input
              placeholder={t('contacts.merge_picker_placeholder')}
              value={mergeQuery}
              onChange={(e) => setMergeQuery(e.target.value)}
              data-testid="merge-search-input"
            />
            <Button
              type="button"
              variant="outline"
              onClick={runMergeSearch}
              data-testid="merge-search"
            >
              ⌕
            </Button>
          </div>
          {mergeResults && mergeResults.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('contacts.no_results')}
            </p>
          ) : null}
          {mergeResults && mergeResults.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {mergeResults.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between p-2"
                >
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedMerge.includes(c.id)}
                      onChange={() => toggleMerge(c.id)}
                      data-testid={`merge-checkbox-${c.id}`}
                    />
                    <span>
                      {c.name ?? c.email ?? c.phoneNumber ?? c.identifier ?? c.id}
                      <span className="text-xs text-muted-foreground ml-2">
                        {[c.email, c.phoneNumber].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            type="button"
            onClick={onMerge}
            disabled={merging || selectedMerge.length === 0}
            data-testid="merge-submit"
          >
            {merging ? t('common.loading') : t('contacts.merge_submit')}
          </Button>
        </section>

        <section className="space-y-2 rounded-md border border-border p-4">
          <p className="text-sm font-medium">{t('contacts.privacy_title')}</p>
          <p className="text-xs text-muted-foreground">{t('contacts.privacy_hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              data-testid="export-contact"
            >
              {t('contacts.privacy_export')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onAnonymize}
              data-testid="anonymize-contact"
            >
              {t('contacts.privacy_anonymize')}
            </Button>
          </div>
        </section>

        <section className="rounded-md border border-destructive/30 p-4">
          <Button
            variant="destructive"
            onClick={onDelete}
            data-testid="delete-contact"
          >
            {t('contacts.delete')}
          </Button>
        </section>
      </div>
    </div>
      </main>
  )
}
