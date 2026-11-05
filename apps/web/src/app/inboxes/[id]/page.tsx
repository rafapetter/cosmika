'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import type {
  AccountWithMembers,
  AgentBotDTO,
  AiAutoreplyMode,
  DeviationPolicy,
  FlowMode,
  FlowSummaryDTO,
  InboxWithMembersDTO,
  SlaPolicyDTO,
  UpdateInboxInput,
  WhatsappTemplateDTO,
  WidgetPreChatField,
} from '@cosmika/shared'
import { AUTO_RESOLVE_MAX_MINUTES } from '@cosmika/shared'
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

import { WhatsappCredentialsForm } from '../../../components/whatsapp-credentials-form'
import { API_BASE, ApiError, api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'
import { whatsappWebhookUrl } from '../../../lib/whatsapp-webhook'

import { autoResolveChoices, autoResolveLabel, clampAutoResolve } from './auto-resolve'

// Radix Select reserves '', so "no SLA policy" travels as a sentinel.
const NONE = '__none__'

// Meta template statuses we have words for; anything else shows as sent.
const TEMPLATE_STATUSES = new Set(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL'])

const AUTOREPLY_MODES: AiAutoreplyMode[] = [
  'DRAFT',
  'AUTO_SAFE',
  'AUTO_FULL',
]

export default function InboxDetailPage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const inboxId = params.id
  const { session, ready } = useStoredSession()

  const [inbox, setInbox] = useState<InboxWithMembersDTO | null>(null)
  const [account, setAccount] = useState<AccountWithMembers | null>(null)
  const [bots, setBots] = useState<AgentBotDTO[]>([])
  const [agentBotId, setAgentBotId] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [primaryColor, setPrimaryColor] = useState('')
  const [websiteName, setWebsiteName] = useState('')
  const [welcomeMessage, setWelcomeMessage] = useState('')
  const [launcherText, setLauncherText] = useState('')
  const [preChatFields, setPreChatFields] = useState<WidgetPreChatField[]>([])
  const [replyToAddress, setReplyToAddress] = useState('')
  const [signature, setSignature] = useState('')
  const [autoreplyMode, setAutoreplyMode] = useState<AiAutoreplyMode>('DRAFT')
  const [greetingEnabled, setGreetingEnabled] = useState(false)
  const [greetingMessage, setGreetingMessage] = useState('')
  const [csatEnabled, setCsatEnabled] = useState(false)
  const [closingMessage, setClosingMessage] = useState('')
  const [autoResolveMinutes, setAutoResolveMinutes] = useState<number>(AUTO_RESOLVE_MAX_MINUTES)
  const [slaPolicyId, setSlaPolicyId] = useState<string>('')
  const [slaPolicies, setSlaPolicies] = useState<SlaPolicyDTO[]>([])
  const [flows, setFlows] = useState<FlowSummaryDTO[]>([])
  const [defaultFlowId, setDefaultFlowId] = useState<string>('')
  const [flowMode, setFlowMode] = useState<FlowMode>('OFF')
  const [deviationPolicy, setDeviationPolicy] =
    useState<DeviationPolicy>('answer_and_return')
  const [maxDeviations, setMaxDeviations] = useState<number>(3)

  const [saving, setSaving] = useState(false)
  const [memberToAdd, setMemberToAdd] = useState('')
  const [addingMember, setAddingMember] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!session) return
    const [inboxData, accountData, botsList, slaList, flowList] = await Promise.all([
      api.getInbox(session.session.token, session.account.id, inboxId),
      api.getAccount(session.session.token, session.account.id),
      api
        .listAgentBots(session.session.token, session.account.id)
        .catch(() => [] as AgentBotDTO[]),
      api
        .listSlaPolicies(session.session.token, session.account.id)
        .catch(() => [] as SlaPolicyDTO[]),
      api
        .listFlows(session.session.token, session.account.id)
        .catch(() => [] as FlowSummaryDTO[]),
    ])
    setSlaPolicies(slaList)
    setSlaPolicyId(inboxData.slaPolicyId ?? '')
    setFlows(flowList)
    setDefaultFlowId(inboxData.defaultFlowId ?? '')
    setFlowMode(inboxData.flowMode)
    setDeviationPolicy(inboxData.deviationPolicy)
    setMaxDeviations(inboxData.maxDeviations)
    setInbox(inboxData)
    setAccount(accountData)
    setBots(botsList)
    setAgentBotId(inboxData.agentBotId ?? '')
    setName(inboxData.name)
    setAutoreplyMode(inboxData.aiAutoreplyMode)
    setGreetingEnabled(inboxData.greetingEnabled)
    setGreetingMessage(inboxData.greetingMessage ?? '')
    const config = inboxData.channelConfig as Record<string, unknown>
    setWebsiteName(typeof config.websiteName === 'string' ? config.websiteName : '')
    setPrimaryColor(typeof config.primaryColor === 'string' ? config.primaryColor : '')
    setWelcomeMessage(
      typeof config.welcomeMessage === 'string' ? config.welcomeMessage : '',
    )
    setLauncherText(
      typeof config.launcherText === 'string' ? config.launcherText : '',
    )
    setPreChatFields(
      Array.isArray(config.preChatFields)
        ? (config.preChatFields as WidgetPreChatField[])
        : [],
    )
    setReplyToAddress(
      typeof config.replyToAddress === 'string' ? config.replyToAddress : '',
    )
    setSignature(typeof config.signature === 'string' ? config.signature : '')
    setCsatEnabled(inboxData.csatEnabled === true)
    setClosingMessage(inboxData.closingMessage ?? '')
    setAutoResolveMinutes(clampAutoResolve(inboxData.autoResolveMinutes))
  }, [session, inboxId])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    refresh().catch((err) => {
      if (err instanceof ApiError && err.status === 403) {
        setLoadError(t('inboxes.forbidden'))
      } else if (err instanceof ApiError && err.status === 404) {
        router.replace('/inboxes')
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
          href="/inboxes"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('inboxes.back_to_list')}
        </Link>
        </div>
      </main>
    )
  }

  if (!inbox || !account) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        </div>
      </main>
    )
  }

  const channelType = inbox.channelType
  const forwardingAddress =
    typeof (inbox.channelConfig as Record<string, unknown>).forwardingAddress ===
    'string'
      ? ((inbox.channelConfig as Record<string, unknown>)
          .forwardingAddress as string)
      : null

  const invitableMembers = account.members.filter(
    (m) => !inbox.members.some((im) => im.userId === m.userId),
  )

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !inbox) return
    setActionError(null)
    setSaving(true)
    try {
      const channelConfig: Record<string, unknown> = {}
      if (channelType === 'WEB_WIDGET') {
        if (websiteName) channelConfig.websiteName = websiteName
        if (primaryColor) channelConfig.primaryColor = primaryColor
        if (welcomeMessage) channelConfig.welcomeMessage = welcomeMessage
        if (launcherText) channelConfig.launcherText = launcherText
        // Only keep fully-specified pre-chat rows (a key + a label).
        const cleanFields = preChatFields.filter(
          (f) => f.key.trim() && f.label.trim(),
        )
        channelConfig.preChatFields = cleanFields
      } else if (channelType === 'EMAIL') {
        if (replyToAddress) channelConfig.replyToAddress = replyToAddress
        if (signature) channelConfig.signature = signature
      }
      const body: UpdateInboxInput = {
        name,
        aiAutoreplyMode: autoreplyMode,
        greetingEnabled,
        greetingMessage: greetingMessage || null,
        agentBotId: agentBotId || null,
        csatEnabled,
        closingMessage: closingMessage.trim() || null,
        autoResolveMinutes,
        slaPolicyId: slaPolicyId || null,
        defaultFlowId: defaultFlowId || null,
        flowMode,
        deviationPolicy,
        maxDeviations,
        ...(Object.keys(channelConfig).length > 0 ? { channelConfig } : {}),
      }
      await api.updateInbox(
        session.session.token,
        session.account.id,
        inboxId,
        body,
      )
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('inboxes.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function onAddMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !memberToAdd) return
    setActionError(null)
    setAddingMember(true)
    try {
      await api.addInboxMember(
        session.session.token,
        session.account.id,
        inboxId,
        { userId: memberToAdd },
      )
      setMemberToAdd('')
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('inboxes.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    } finally {
      setAddingMember(false)
    }
  }

  async function onRemoveMember(userId: string) {
    if (!session) return
    setActionError(null)
    try {
      await api.removeInboxMember(
        session.session.token,
        session.account.id,
        inboxId,
        userId,
      )
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('inboxes.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    }
  }

  async function onDelete() {
    if (!session || !inbox) return
    if (!window.confirm(t('inboxes.confirm_delete'))) return
    try {
      await api.deleteInbox(session.session.token, session.account.id, inboxId)
      router.push('/inboxes')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setActionError(t('inboxes.forbidden'))
      } else {
        setActionError(t('auth.generic_error'))
      }
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('inboxes.edit_title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {inbox.channelType === 'WEB_WIDGET'
              ? t('inboxes.channel_web_widget')
              : inbox.channelType === 'EMAIL'
                ? t('inboxes.channel_email')
                : inbox.channelType === 'WHATSAPP'
                  ? t('inboxes.channel_whatsapp')
                  : inbox.channelType === 'TELEGRAM'
                    ? t('inboxes.channel_telegram')
                    : inbox.channelType === 'FACEBOOK'
                      ? t('inboxes.channel_facebook')
                      : inbox.channelType === 'INSTAGRAM'
                        ? t('inboxes.channel_instagram')
                        : t('inboxes.channel_api')}
          </p>
          {inbox.channelType === 'TELEGRAM' &&
          typeof inbox.channelConfig.botUsername === 'string' ? (
            <p className="text-sm">
              {t('inboxes.telegram_connected_as', {
                username: inbox.channelConfig.botUsername,
              })}
            </p>
          ) : null}
        </header>

        {actionError ? (
          <p className="text-sm text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}

        <form onSubmit={onSave} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">{t('inboxes.name')}</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {channelType === 'WEB_WIDGET' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              <div className="space-y-2">
                <Label htmlFor="websiteName">{t('inboxes.website_name')}</Label>
                <Input
                  id="websiteName"
                  value={websiteName}
                  onChange={(e) => setWebsiteName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="primaryColor">
                  {t('inboxes.primary_color')}
                </Label>
                <Input
                  id="primaryColor"
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
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="launcherText">
                  {t('inboxes.launcher_text')}
                </Label>
                <Input
                  id="launcherText"
                  value={launcherText}
                  onChange={(e) => setLauncherText(e.target.value)}
                  placeholder={t('inboxes.launcher_text_placeholder')}
                />
              </div>

              {/* Pre-chat fields builder */}
              <div className="space-y-2" data-testid="prechat-builder">
                <Label>{t('inboxes.prechat_fields')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('inboxes.prechat_help')}
                </p>
                {preChatFields.map((f, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                    data-testid={`prechat-row-${i}`}
                  >
                    <Input
                      className="w-32"
                      value={f.key}
                      placeholder={t('inboxes.prechat_key')}
                      onChange={(e) =>
                        setPreChatFields((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, key: e.target.value } : r,
                          ),
                        )
                      }
                    />
                    <Input
                      className="w-40"
                      value={f.label}
                      placeholder={t('inboxes.prechat_label')}
                      onChange={(e) =>
                        setPreChatFields((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, label: e.target.value } : r,
                          ),
                        )
                      }
                    />
                    <Select
                      value={f.type}
                      onValueChange={(v) =>
                        setPreChatFields((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, type: v as 'text' | 'email' | 'phone' } : r,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="w-32" aria-label={t('inboxes.prechat_field_type')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text">{t('inboxes.prechat_type_text')}</SelectItem>
                        <SelectItem value="email">{t('inboxes.prechat_type_email')}</SelectItem>
                        <SelectItem value="phone">{t('inboxes.prechat_type_phone')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1 text-xs">
                      <Checkbox
                        checked={f.required}
                        onCheckedChange={(v) =>
                          setPreChatFields((rows) =>
                            rows.map((r, j) =>
                              j === i
                                ? { ...r, required: v === true }
                                : r,
                            ),
                          )
                        }
                      />
                      {t('inboxes.prechat_required')}
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setPreChatFields((rows) =>
                          rows.filter((_, j) => j !== i),
                        )
                      }
                      data-testid={`prechat-remove-${i}`}
                    >
                      {t('inboxes.prechat_remove')}
                    </Button>
                  </div>
                ))}
                {preChatFields.length < 10 ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPreChatFields((rows) => [
                        ...rows,
                        { key: '', label: '', type: 'text', required: false },
                      ])
                    }
                    data-testid="prechat-add"
                  >
                    {t('inboxes.prechat_add')}
                  </Button>
                ) : null}
              </div>
            </fieldset>
          ) : null}

          {channelType === 'EMAIL' ? (
            <fieldset className="space-y-4 rounded-md border border-border p-4">
              {forwardingAddress ? (
                <div className="space-y-1">
                  <Label>{t('inboxes.forwarding_address')}</Label>
                  <p className="text-sm font-mono">{forwardingAddress}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('inboxes.forwarding_help')}
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="replyToAddress">
                  {t('inboxes.reply_to_address')}
                </Label>
                <Input
                  id="replyToAddress"
                  type="email"
                  value={replyToAddress}
                  onChange={(e) => setReplyToAddress(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signature">{t('inboxes.signature')}</Label>
                <Input
                  id="signature"
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                />
              </div>
            </fieldset>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="agentBot">{t('agentBots.title')}</Label>
            <Select
              value={agentBotId === '' ? NONE : agentBotId}
              onValueChange={(v) => setAgentBotId(v === NONE ? '' : v)}
            >
              <SelectTrigger id="agentBot" data-testid="agent-bot-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('agentBots.none_attached')}</SelectItem>
                {bots.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} ({b.model})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Bot flow (hybrid deterministic flow + AI agent) */}
          <fieldset
            className="space-y-4 rounded-md border border-border p-4"
            data-testid="flow-config"
          >
            <legend className="px-1 text-sm font-medium">
              {t('inboxes.flow_section')}
            </legend>
            <div className="space-y-2">
              <Label htmlFor="defaultFlow">{t('inboxes.flow_default')}</Label>
              <Select
                value={defaultFlowId === '' ? NONE : defaultFlowId}
                onValueChange={(v) => setDefaultFlowId(v === NONE ? '' : v)}
              >
                <SelectTrigger id="defaultFlow" data-testid="flow-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('inboxes.flow_none')}</SelectItem>
                  {flows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                      {f.hasPublished ? '' : ` (${t('inboxes.flow_unpublished')})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="flowMode">{t('inboxes.flow_mode')}</Label>
              <Select value={flowMode} onValueChange={(v) => setFlowMode(v as FlowMode)}>
                <SelectTrigger id="flowMode" data-testid="flow-mode-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OFF">{t('inboxes.flow_mode_off')}</SelectItem>
                  <SelectItem value="STRICT">{t('inboxes.flow_mode_strict')}</SelectItem>
                  <SelectItem value="GUIDED">{t('inboxes.flow_mode_guided')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {flowMode === 'GUIDED' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="deviationPolicy">
                    {t('inboxes.flow_deviation_policy')}
                  </Label>
                  <Select
                    value={deviationPolicy}
                    onValueChange={(v) => setDeviationPolicy(v as DeviationPolicy)}
                  >
                    <SelectTrigger id="deviationPolicy" data-testid="deviation-policy-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="answer_and_return">
                        {t('inboxes.flow_policy_answer_return')}
                      </SelectItem>
                      <SelectItem value="answer_and_advance">
                        {t('inboxes.flow_policy_answer_advance')}
                      </SelectItem>
                      <SelectItem value="free_until_done">
                        {t('inboxes.flow_policy_free')}
                      </SelectItem>
                      <SelectItem value="escalate">
                        {t('inboxes.flow_policy_escalate')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxDeviations">
                    {t('inboxes.flow_max_deviations')}
                  </Label>
                  <Input
                    id="maxDeviations"
                    type="number"
                    min={0}
                    max={20}
                    value={maxDeviations}
                    onChange={(e) =>
                      setMaxDeviations(Number(e.target.value) || 0)
                    }
                  />
                </div>
              </>
            ) : null}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="autoreply">{t('inboxes.autoreply_mode')}</Label>
            <Select
              value={autoreplyMode}
              onValueChange={(v) => setAutoreplyMode(v as AiAutoreplyMode)}
            >
              <SelectTrigger id="autoreply">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOREPLY_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode === 'DRAFT'
                      ? t('inboxes.autoreply_draft')
                      : mode === 'AUTO_SAFE'
                        ? t('inboxes.autoreply_auto_safe')
                        : t('inboxes.autoreply_auto_full')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={greetingEnabled}
                onCheckedChange={(v) => setGreetingEnabled(v === true)}
              />
              {t('inboxes.greeting_enabled')}
            </label>
            {greetingEnabled ? (
              <Input
                value={greetingMessage}
                onChange={(e) => setGreetingMessage(e.target.value)}
                placeholder={t('inboxes.greeting_message')}
              />
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="sla-policy">{t('inboxes.sla_policy')}</Label>
            <Select
              value={slaPolicyId === '' ? NONE : slaPolicyId}
              onValueChange={(v) => setSlaPolicyId(v === NONE ? '' : v)}
            >
              <SelectTrigger id="sla-policy" data-testid="sla-policy-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('inboxes.sla_none')}</SelectItem>
                {slaPolicies.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('inboxes.sla_hint')}{' '}
              <a href="/settings/sla" className="underline">
                {t('inboxes.sla_hint_link')}
              </a>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auto-close">{t('inboxes.auto_close_label')}</Label>
            <Select
              value={String(autoResolveMinutes)}
              onValueChange={(v) => setAutoResolveMinutes(Number(v))}
            >
              <SelectTrigger id="auto-close" data-testid="auto-close">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {autoResolveChoices(autoResolveMinutes).map((m) => (
                  <SelectItem key={m} value={String(m)} data-testid={`auto-close-${m}`}>
                    {autoResolveLabel(t, m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('inboxes.auto_close_hint')}</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="closing-message">{t('inboxes.closing_message')}</Label>
            <Textarea
              id="closing-message"
              rows={3}
              maxLength={1000}
              value={closingMessage}
              onChange={(e) => setClosingMessage(e.target.value)}
              placeholder={t('inboxes.closing_message_placeholder')}
              data-testid="closing-message"
            />
            <p className="text-xs text-muted-foreground">{t('inboxes.closing_message_hint')}</p>
          </div>

          <div className="space-y-1">
            <label className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={csatEnabled}
                onCheckedChange={(v) => setCsatEnabled(v === true)}
                data-testid="csat-toggle"
              />
              {t('inboxes.csat_enabled')}
            </label>
            <p className="text-xs text-muted-foreground">{t('inboxes.csat_hint')}</p>
          </div>

          <div className="flex items-center justify-between">
            <Link
              href="/inboxes"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('inboxes.back_to_list')}
            </Link>
            <Button type="submit" disabled={saving} data-testid="save-inbox">
              {saving ? t('common.loading') : t('inboxes.save_changes')}
            </Button>
          </div>
        </form>

        <section className="space-y-3 rounded-md border border-border p-4">
          <h2 className="font-semibold">{t('inboxes.members')}</h2>
          {inbox.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('inboxes.members_empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {inbox.members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between py-2"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {m.user.fullName ?? m.user.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.user.email}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemoveMember(m.userId)}
                    data-testid={`remove-${m.userId}`}
                  >
                    {t('inboxes.remove_member')}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {invitableMembers.length > 0 ? (
            <form onSubmit={onAddMember} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor="member">{t('inboxes.add_member')}</Label>
                <Select value={memberToAdd} onValueChange={setMemberToAdd}>
                  <SelectTrigger id="member">
                    <SelectValue placeholder={t('inboxes.select_member')} />
                  </SelectTrigger>
                  <SelectContent>
                    {invitableMembers.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.user.fullName ?? m.user.email} ({t(`members.role_${m.role.toLowerCase()}` as never)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                disabled={!memberToAdd || addingMember}
                data-testid="add-member"
              >
                {addingMember ? t('common.loading') : t('inboxes.add_member')}
              </Button>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('inboxes.no_invitable_members')}
            </p>
          )}
        </section>

        <WorkingHoursEditor accountId={session.account.id} inboxId={inboxId} />

        {channelType === 'WHATSAPP' ? (
          <WhatsappCredentialsForm
            token={session.session.token}
            accountId={session.account.id}
            inboxId={inboxId}
            // The API enforces this too; the flag only avoids offering a
            // save that would be refused.
            canEdit={session.membership.role === 'ADMINISTRATOR'}
            phoneNumberId={stringField(inbox.channelConfig, 'phoneNumberId')}
            businessAccountId={stringField(inbox.channelConfig, 'businessAccountId')}
            secrets={inbox.whatsappSecrets}
            onSaved={(saved) =>
              setInbox((prev) => (prev ? { ...prev, ...saved, members: prev.members } : prev))
            }
          />
        ) : null}

        {channelType === 'WHATSAPP' ? <WhatsappWebhookCard inboxId={inboxId} /> : null}

        {channelType === 'WHATSAPP' ? (
          <WhatsappTemplatesEditor
            accountId={session.account.id}
            inboxId={inboxId}
          />
        ) : null}

        <section className="rounded-md border border-destructive/30 p-4">
          <Button
            variant="destructive"
            onClick={onDelete}
            data-testid="delete-inbox"
          >
            {t('inboxes.delete')}
          </Button>
        </section>
      </div>
      </div>
    </main>
  )
}

function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function WhatsappWebhookCard(props: { inboxId: string }) {
  const t = useTranslations()
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setUrl(whatsappWebhookUrl(API_BASE, window.location.origin, props.inboxId))
  }, [props.inboxId])

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked: the field is still selectable */
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-4" data-testid="whatsapp-webhook">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t('inboxes.webhook_title')}</h2>
        <p className="text-xs text-muted-foreground">{t('inboxes.webhook_hint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="whatsappWebhookUrl">{t('inboxes.webhook_url')}</Label>
        <div className="flex gap-2">
          <Input
            id="whatsappWebhookUrl"
            readOnly
            value={url}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button type="button" variant="outline" onClick={() => void onCopy()}>
            {copied ? t('inboxes.webhook_copied') : t('inboxes.webhook_copy')}
          </Button>
        </div>
      </div>
    </section>
  )
}

function WorkingHoursEditor(props: { accountId: string; inboxId: string }) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [rows, setRows] = useState<
    Array<{
      dayOfWeek: number
      closedAllDay: boolean
      openHour: number
      openMinute: number
      closeHour: number
      closeMinute: number
    }>
  >([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    api
      .getWorkingHours(session.session.token, props.accountId, props.inboxId)
      .then((existing) => {
        const map = new Map(existing.map((r) => [r.dayOfWeek, r]))
        const filled = [0, 1, 2, 3, 4, 5, 6].map((d) => {
          const r = map.get(d)
          return r
            ? {
                dayOfWeek: d,
                closedAllDay: r.closedAllDay,
                openHour: r.openHour,
                openMinute: r.openMinute,
                closeHour: r.closeHour,
                closeMinute: r.closeMinute,
              }
            : {
                dayOfWeek: d,
                closedAllDay: d === 0 || d === 6,
                openHour: 9,
                openMinute: 0,
                closeHour: 18,
                closeMinute: 0,
              }
        })
        setRows(filled)
      })
      .catch(() => undefined)
  }, [session, props.accountId, props.inboxId])

  async function onSave() {
    if (!session) return
    setError(null)
    setSaving(true)
    try {
      const hours = rows
        .filter((r) => !r.closedAllDay)
        .map((r) => ({
          dayOfWeek: r.dayOfWeek,
          closedAllDay: false,
          openHour: r.openHour,
          openMinute: r.openMinute,
          closeHour: r.closeHour,
          closeMinute: r.closeMinute,
        }))
      await api.setWorkingHours(
        session.session.token,
        props.accountId,
        props.inboxId,
        { hours },
      )
    } catch {
      setError(t('auth.generic_error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-md border border-border p-4 space-y-3">
      <div>
        <h2 className="font-semibold">{t('workingHours.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('workingHours.subtitle')}
        </p>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.dayOfWeek}
            className="flex items-center gap-3 text-sm"
            data-testid={`wh-row-${r.dayOfWeek}`}
          >
            <span className="w-24">
              {t(`workingHours.day_${r.dayOfWeek}` as `workingHours.day_0`)}
            </span>
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={r.closedAllDay}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((row, i) =>
                      i === r.dayOfWeek
                        ? { ...row, closedAllDay: e.target.checked }
                        : row,
                    ),
                  )
                }
              />
              <span className="text-xs">{t('workingHours.closed')}</span>
            </label>
            {!r.closedAllDay ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {t('workingHours.open_at')}
                </span>
                <Input
                  type="number"
                  className="h-8 w-16"
                  min={0}
                  max={23}
                  value={r.openHour}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((row, i) =>
                        i === r.dayOfWeek
                          ? { ...row, openHour: Number(e.target.value) }
                          : row,
                      ),
                    )
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {t('workingHours.close_at')}
                </span>
                <Input
                  type="number"
                  className="h-8 w-16"
                  min={0}
                  max={23}
                  value={r.closeHour}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((row, i) =>
                        i === r.dayOfWeek
                          ? { ...row, closeHour: Number(e.target.value) }
                          : row,
                      ),
                    )
                  }
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        onClick={onSave}
        disabled={saving}
        data-testid="save-working-hours"
      >
        {saving ? t('common.loading') : t('workingHours.save_changes')}
      </Button>
    </section>
  )
}

function WhatsappTemplatesEditor(props: { accountId: string; inboxId: string }) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [templates, setTemplates] = useState<WhatsappTemplateDTO[]>([])
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [synced, setSynced] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!session) return
    try {
      setTemplates(
        await api.listWhatsappTemplates(
          session.session.token,
          props.accountId,
          props.inboxId,
        ),
      )
    } catch {
      setTemplates([])
    }
  }, [session, props.accountId, props.inboxId])

  useEffect(() => {
    void load()
  }, [load])

  async function onSync() {
    if (!session) return
    setSyncing(true)
    setError(null)
    try {
      const r = await api.syncWhatsappTemplates(
        session.session.token,
        props.accountId,
        props.inboxId,
      )
      setSynced(r.synced)
      await load()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t('conversations.template_title')}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={onSync}
          disabled={syncing}
          data-testid="sync-templates"
        >
          {syncing ? t('common.loading') : t('inboxes.templates_sync')}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {synced !== null ? (
        <p className="text-xs text-muted-foreground">
          {t('inboxes.templates_synced', { count: synced })}
        </p>
      ) : null}
      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('inboxes.templates_empty')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((tpl) => (
            <li key={tpl.id} className="py-2" data-testid={`tpl-${tpl.id}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{tpl.name}</span>
                <span className="text-xs text-muted-foreground">{tpl.language}</span>
                <span
                  className={
                    'rounded px-1.5 py-0 text-[10px] uppercase ' +
                    (tpl.status === 'APPROVED'
                      ? 'bg-success/15 text-success'
                      : 'bg-muted text-muted-foreground')
                  }
                >
                  {TEMPLATE_STATUSES.has(tpl.status)
                    ? t(`inboxes.template_status_${tpl.status.toLowerCase()}` as never)
                    : tpl.status}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{tpl.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
