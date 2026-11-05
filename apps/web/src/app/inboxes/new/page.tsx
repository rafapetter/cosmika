'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { ChannelType, CreateInboxInput } from '@cosmika/shared'
import {
  Button,
  FormField,
  FormSection,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@cosmika/ui'

import { WhatsappEmbeddedSignup } from '../../../components/whatsapp-embedded-signup'
import { ApiError, api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'

// META_PAGE is not a channel type: one Facebook Page opens a Messenger inbox,
// an Instagram Direct inbox, or both, through POST /inboxes/meta.
type ChannelChoice = ChannelType | 'META_PAGE'

const SUPPORTED_CHANNELS: ChannelChoice[] = [
  'WEB_WIDGET',
  'WHATSAPP',
  'META_PAGE',
  'TELEGRAM',
  'API',
  'EMAIL',
]

function channelTypeLabelKey(ch: ChannelChoice): string {
  switch (ch) {
    case 'WEB_WIDGET':
      return 'inboxes.channel_web_widget'
    case 'WHATSAPP':
      return 'inboxes.channel_whatsapp'
    case 'API':
      return 'inboxes.channel_api'
    case 'EMAIL':
      return 'inboxes.channel_email'
    case 'TELEGRAM':
      return 'inboxes.channel_telegram'
    case 'FACEBOOK':
      return 'inboxes.channel_facebook'
    case 'INSTAGRAM':
      return 'inboxes.channel_instagram'
    case 'META_PAGE':
      return 'inboxes.channel_meta_page'
  }
}

export default function NewInboxPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()

  const [name, setName] = useState('')
  const [channelType, setChannelType] = useState<ChannelChoice>('WEB_WIDGET')
  // WEB_WIDGET fields
  const [websiteName, setWebsiteName] = useState('')
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [primaryColor, setPrimaryColor] = useState('#4F46E5')
  const [welcomeMessage, setWelcomeMessage] = useState('')
  // EMAIL fields
  const [replyToAddress, setReplyToAddress] = useState('')
  const [signature, setSignature] = useState('')
  // WHATSAPP fields
  const [waPhoneNumberId, setWaPhoneNumberId] = useState('')
  const [waBusinessAccountId, setWaBusinessAccountId] = useState('')
  const [waAccessToken, setWaAccessToken] = useState('')
  const [waAppSecret, setWaAppSecret] = useState('')
  const [waWebhookVerifyToken, setWaWebhookVerifyToken] = useState('')
  // API fields
  const [apiWebhookUrl, setApiWebhookUrl] = useState('')
  // TELEGRAM fields
  const [telegramBotToken, setTelegramBotToken] = useState('')
  // Facebook Page (Messenger / Instagram) fields
  const [metaPageId, setMetaPageId] = useState('')
  const [metaPageToken, setMetaPageToken] = useState('')
  const [metaMessenger, setMetaMessenger] = useState(true)
  const [metaInstagram, setMetaInstagram] = useState(true)

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
      if (channelType === 'META_PAGE') {
        await api.connectMetaPage(session.session.token, session.account.id, {
          pageId: metaPageId.trim(),
          pageAccessToken: metaPageToken.trim(),
          messenger: metaMessenger,
          instagram: metaInstagram,
          ...(name && metaMessenger && { messengerName: name }),
        })
        router.push('/inboxes')
        return
      }
      let body: CreateInboxInput
      if (channelType === 'WEB_WIDGET') {
        body = {
          name,
          channelType: 'WEB_WIDGET',
          channelConfig: {
            websiteName: websiteName || name,
            ...(websiteUrl && { websiteUrl }),
            ...(primaryColor && { primaryColor }),
            ...(welcomeMessage && { welcomeMessage }),
          },
        }
      } else if (channelType === 'WHATSAPP') {
        body = {
          name,
          channelType: 'WHATSAPP',
          channelConfig: {
            phoneNumberId: waPhoneNumberId,
            businessAccountId: waBusinessAccountId,
            ...(waAccessToken && { accessToken: waAccessToken }),
            ...(waAppSecret && { appSecret: waAppSecret }),
            ...(waWebhookVerifyToken && {
              webhookVerifyToken: waWebhookVerifyToken,
            }),
          },
        }
      } else if (channelType === 'TELEGRAM') {
        body = {
          name,
          channelType: 'TELEGRAM',
          channelConfig: { botToken: telegramBotToken.trim() },
        }
      } else if (channelType === 'API') {
        body = {
          name,
          channelType: 'API',
          channelConfig: {
            ...(apiWebhookUrl && { webhookUrl: apiWebhookUrl }),
          },
        }
      } else {
        body = {
          name,
          channelType: 'EMAIL',
          channelConfig: {
            ...(replyToAddress && { replyToAddress }),
            ...(signature && { signature }),
          },
        }
      }
      const inbox = await api.createInbox(
        session.session.token,
        session.account.id,
        body,
      )
      router.push(`/inboxes/${inbox.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('inboxes.forbidden'))
      } else if (err instanceof ApiError) {
        setError(apiErrorText(t, err))
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
            {t('inboxes.new_title')}
          </h1>
        </header>

        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">{t('inboxes.name')}</Label>
            <Input
              id="name"
              name="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('inboxes.name_help')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="channelType">{t('inboxes.channel_type')}</Label>
            <Select
              value={channelType}
              onValueChange={(v) => setChannelType(v as ChannelChoice)}
              name="channelType"
            >
              <SelectTrigger id="channelType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_CHANNELS.map((ch) => (
                  <SelectItem key={ch} value={ch}>
                    {t(channelTypeLabelKey(ch))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {channelType === 'WEB_WIDGET' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <div className="space-y-2">
                <Label htmlFor="websiteName">{t('inboxes.website_name')}</Label>
                <Input
                  id="websiteName"
                  name="websiteName"
                  value={websiteName}
                  onChange={(e) => setWebsiteName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="websiteUrl">{t('inboxes.website_url')}</Label>
                <Input
                  id="websiteUrl"
                  name="websiteUrl"
                  type="url"
                  placeholder="https://example.com"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="primaryColor">
                  {t('inboxes.primary_color')}
                </Label>
                <Input
                  id="primaryColor"
                  name="primaryColor"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="welcomeMessage">
                  {t('inboxes.welcome_message')}
                </Label>
                <Input
                  id="welcomeMessage"
                  name="welcomeMessage"
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                />
              </div>
            </fieldset>
          ) : null}

          {channelType === 'WHATSAPP' ? (
            <WhatsappEmbeddedSignup
              token={session.session.token}
              accountId={session.account.id}
              name={name}
              onConnected={(inbox) => router.push(`/inboxes/${inbox.id}`)}
            />
          ) : null}

          {channelType === 'WHATSAPP' ? (
            <fieldset className="rounded-md border border-border p-4">
              <FormSection>
                <p className="text-xs text-muted-foreground">
                  {t('inboxes.whatsapp_credentials.hint')}
                </p>
                <FormField
                  label={t('inboxes.whatsapp_credentials.phone_number_id')}
                  htmlFor="waPhoneNumberId"
                  required
                >
                  <Input
                    id="waPhoneNumberId"
                    name="waPhoneNumberId"
                    required
                    value={waPhoneNumberId}
                    onChange={(e) => setWaPhoneNumberId(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('inboxes.whatsapp_credentials.business_account_id')}
                  htmlFor="waBusinessAccountId"
                  required
                >
                  <Input
                    id="waBusinessAccountId"
                    name="waBusinessAccountId"
                    required
                    value={waBusinessAccountId}
                    onChange={(e) => setWaBusinessAccountId(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('inboxes.whatsapp_credentials.access_token')}
                  htmlFor="waAccessToken"
                  hint={t('inboxes.whatsapp_credentials.access_token_hint')}
                >
                  <Input
                    id="waAccessToken"
                    name="waAccessToken"
                    type="password"
                    autoComplete="off"
                    value={waAccessToken}
                    onChange={(e) => setWaAccessToken(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('inboxes.whatsapp_credentials.app_secret')}
                  htmlFor="waAppSecret"
                  hint={t('inboxes.whatsapp_credentials.app_secret_hint')}
                >
                  <Input
                    id="waAppSecret"
                    name="waAppSecret"
                    type="password"
                    autoComplete="off"
                    value={waAppSecret}
                    onChange={(e) => setWaAppSecret(e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t('inboxes.whatsapp_credentials.webhook_verify_token')}
                  htmlFor="waWebhookVerifyToken"
                  hint={t('inboxes.whatsapp_credentials.webhook_verify_token_hint')}
                >
                  <Input
                    id="waWebhookVerifyToken"
                    name="waWebhookVerifyToken"
                    type="password"
                    autoComplete="off"
                    value={waWebhookVerifyToken}
                    onChange={(e) => setWaWebhookVerifyToken(e.target.value)}
                  />
                </FormField>
              </FormSection>
            </fieldset>
          ) : null}

          {channelType === 'META_PAGE' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <p className="text-xs text-muted-foreground">{t('inboxes.meta_intro')}</p>
              <FormField label={t('inboxes.meta_page_id')} htmlFor="metaPageId">
                <Input
                  id="metaPageId"
                  name="metaPageId"
                  inputMode="numeric"
                  required
                  value={metaPageId}
                  onChange={(e) => setMetaPageId(e.target.value)}
                />
              </FormField>
              <FormField
                label={t('inboxes.meta_page_token')}
                htmlFor="metaPageToken"
                hint={t('inboxes.meta_page_token_hint')}
              >
                <Input
                  id="metaPageToken"
                  name="metaPageToken"
                  type="password"
                  autoComplete="off"
                  required
                  value={metaPageToken}
                  onChange={(e) => setMetaPageToken(e.target.value)}
                />
              </FormField>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">{t('inboxes.meta_open_messenger')}</span>
                <Switch
                  checked={metaMessenger}
                  onCheckedChange={setMetaMessenger}
                  aria-label={t('inboxes.meta_open_messenger')}
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">{t('inboxes.meta_open_instagram')}</span>
                <Switch
                  checked={metaInstagram}
                  onCheckedChange={setMetaInstagram}
                  aria-label={t('inboxes.meta_open_instagram')}
                />
              </label>
            </fieldset>
          ) : null}

          {channelType === 'TELEGRAM' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <p className="text-xs text-muted-foreground">{t('inboxes.telegram_intro')}</p>
              <FormField
                label={t('inboxes.telegram_bot_token')}
                htmlFor="telegramBotToken"
                hint={t('inboxes.telegram_bot_token_hint')}
              >
                <Input
                  id="telegramBotToken"
                  name="telegramBotToken"
                  type="password"
                  autoComplete="off"
                  required
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                />
              </FormField>
            </fieldset>
          ) : null}

          {channelType === 'API' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <p className="text-xs text-muted-foreground">{t('inboxes.api_intro')}</p>
              <FormField
                label={t('inboxes.api_webhook_url')}
                htmlFor="apiWebhookUrl"
                hint={t('inboxes.api_webhook_url_hint')}
              >
                <Input
                  id="apiWebhookUrl"
                  name="apiWebhookUrl"
                  type="url"
                  placeholder={t('inboxes.api_webhook_url_placeholder')}
                  value={apiWebhookUrl}
                  onChange={(e) => setApiWebhookUrl(e.target.value)}
                />
              </FormField>
            </fieldset>
          ) : null}

          {channelType === 'EMAIL' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <div className="space-y-2">
                <Label htmlFor="replyToAddress">
                  {t('inboxes.reply_to_address')}
                </Label>
                <Input
                  id="replyToAddress"
                  name="replyToAddress"
                  type="email"
                  value={replyToAddress}
                  onChange={(e) => setReplyToAddress(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signature">{t('inboxes.signature')}</Label>
                <Input
                  id="signature"
                  name="signature"
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                />
              </div>
            </fieldset>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between">
            <Link
              href="/inboxes"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('inboxes.back_to_list')}
            </Link>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.loading') : t('inboxes.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
      </main>
  )
}
