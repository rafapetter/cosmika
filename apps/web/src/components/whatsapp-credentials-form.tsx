'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type {
  InboxDTO,
  UpdateWhatsappCredentialsInput,
  WhatsappSecretField,
  WhatsappSecretsStatus,
} from '@cosmika/shared'
import { Badge, Button, FormField, FormSection, Input } from '@cosmika/ui'

import { ApiError, api } from '../lib/api'

// Lets an administrator rotate a WhatsApp channel's credentials in place.
// Secrets are write-only: the API only says whether each one is stored, so a
// stored secret shows as "configured" and is replaced by typing a new value.
// Only fields the admin actually changed are sent; the API keeps the rest.

type Props = {
  token: string
  accountId: string
  inboxId: string
  canEdit: boolean
  phoneNumberId: string
  businessAccountId: string
  secrets: WhatsappSecretsStatus | null | undefined
  onSaved: (inbox: InboxDTO) => void
}

const SECRETS: Array<{ field: WhatsappSecretField; label: string; hint: string }> = [
  { field: 'accessToken', label: 'access_token', hint: 'access_token_hint' },
  { field: 'appSecret', label: 'app_secret', hint: 'app_secret_hint' },
  {
    field: 'webhookVerifyToken',
    label: 'webhook_verify_token',
    hint: 'webhook_verify_token_hint',
  },
]

type FieldErrors = Partial<Record<keyof UpdateWhatsappCredentialsInput, string>>

const EMPTY_SECRETS: Record<WhatsappSecretField, string> = {
  accessToken: '',
  appSecret: '',
  webhookVerifyToken: '',
}

export function WhatsappCredentialsForm(props: Props) {
  const t = useTranslations('inboxes.whatsapp_credentials')
  const [phoneNumberId, setPhoneNumberId] = useState(props.phoneNumberId)
  const [businessAccountId, setBusinessAccountId] = useState(props.businessAccountId)
  const [secretValues, setSecretValues] = useState(EMPTY_SECRETS)
  const [replacing, setReplacing] = useState<Partial<Record<WhatsappSecretField, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  function buildBody(): UpdateWhatsappCredentialsInput {
    const body: UpdateWhatsappCredentialsInput = {}
    const phone = phoneNumberId.trim()
    const waba = businessAccountId.trim()
    if (phone && phone !== props.phoneNumberId) body.phoneNumberId = phone
    if (waba && waba !== props.businessAccountId) body.businessAccountId = waba
    for (const { field } of SECRETS) {
      const value = secretValues[field].trim()
      if (value) body[field] = value
    }
    return body
  }

  const body = buildBody()
  const dirty = Object.keys(body).length > 0

  function setSecret(field: WhatsappSecretField, value: string) {
    setSaved(false)
    setSecretValues((prev) => ({ ...prev, [field]: value }))
  }

  function stopReplacing(field: WhatsappSecretField) {
    setSecret(field, '')
    setReplacing((prev) => ({ ...prev, [field]: false }))
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dirty) return
    setSaving(true)
    setSaved(false)
    setError(null)
    setFieldErrors({})
    try {
      const inbox = await api.updateWhatsappCredentials(
        props.token,
        props.accountId,
        props.inboxId,
        body,
      )
      // Show what the server stored (it trims), not what was typed.
      const cfg = inbox.channelConfig as { phoneNumberId?: string; businessAccountId?: string }
      setPhoneNumberId(cfg.phoneNumberId ?? phoneNumberId)
      setBusinessAccountId(cfg.businessAccountId ?? businessAccountId)
      setSecretValues(EMPTY_SECRETS)
      setReplacing({})
      setSaved(true)
      props.onSaved(inbox)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSaving(false)
    }
  }

  function describeError(err: unknown): string {
    if (!(err instanceof ApiError)) return t('error_generic')
    if (err.status === 403) return t('admin_only')
    if (err.status === 409) return t('error_phone_in_use')
    if (err.status !== 400) return t('error_generic')
    // The API names the offending fields (never their values); mark each one.
    const issues = (err.payload as { issues?: Array<{ path?: string }> } | null)?.issues ?? []
    const next: FieldErrors = {}
    for (const issue of issues) {
      if (issue.path) next[issue.path as keyof FieldErrors] = t('invalid_field')
    }
    setFieldErrors(next)
    return t('error_invalid')
  }

  return (
    <section
      className="space-y-4 rounded-md border border-border p-4"
      data-testid="whatsapp-credentials"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t('title')}</h2>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>

      {!props.canEdit ? (
        <p className="text-xs text-muted-foreground">{t('admin_only')}</p>
      ) : null}

      <form onSubmit={onSubmit} noValidate>
        <FormSection>
          <FormField
            label={t('phone_number_id')}
            htmlFor="waCredPhoneNumberId"
            error={fieldErrors.phoneNumberId}
          >
            <Input
              id="waCredPhoneNumberId"
              value={phoneNumberId}
              disabled={!props.canEdit}
              autoComplete="off"
              onChange={(e) => {
                setSaved(false)
                setPhoneNumberId(e.target.value)
              }}
            />
          </FormField>

          <FormField
            label={t('business_account_id')}
            htmlFor="waCredBusinessAccountId"
            hint={t('business_account_id_hint')}
            error={fieldErrors.businessAccountId}
          >
            <Input
              id="waCredBusinessAccountId"
              value={businessAccountId}
              disabled={!props.canEdit}
              autoComplete="off"
              onChange={(e) => {
                setSaved(false)
                setBusinessAccountId(e.target.value)
              }}
            />
          </FormField>

          {SECRETS.map(({ field, label, hint }) => {
            const configured = props.secrets?.[field] === true
            const editing = props.canEdit && (!configured || replacing[field] === true)
            const id = `waCred-${field}`
            return (
              <FormField
                key={field}
                label={t(label)}
                htmlFor={editing ? id : undefined}
                hint={editing && configured ? t('blank_keeps') : t(hint)}
                error={fieldErrors[field]}
              >
                {editing ? (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      placeholder={configured ? t('new_value_placeholder') : undefined}
                      // Only mounts on a click of "replace" when a value is
                      // stored, so focusing it follows the admin's action.
                      autoFocus={configured}
                      value={secretValues[field]}
                      onChange={(e) => setSecret(field, e.target.value)}
                      className="min-w-0 flex-1"
                    />
                    {configured ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => stopReplacing(field)}
                      >
                        {t('keep_current')}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2" data-testid={`secret-${field}`}>
                    {configured ? (
                      <span className="text-sm text-muted-foreground">
                        <span aria-hidden="true">••••• </span>
                        {t('configured')}
                      </span>
                    ) : (
                      <Badge variant="warning">{t('not_configured')}</Badge>
                    )}
                    {props.canEdit ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setReplacing((prev) => ({ ...prev, [field]: true }))}
                      >
                        {t('replace')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </FormField>
            )
          })}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="text-sm text-success">
              {t('saved')}
            </p>
          ) : null}

          {props.canEdit ? (
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                disabled={!dirty || saving}
                data-testid="save-whatsapp-credentials"
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          ) : null}
        </FormSection>
      </form>
    </section>
  )
}
