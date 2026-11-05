'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  BusinessIndustry,
  CompanySize,
  ConversationVolume,
  ExpectedAiShare,
  IntendedFeature,
  SupportChannel,
  SupportToday,
  TIMEZONE_PRESETS,
  isValidTimezone,
  type AccountProfileDTO,
  type Locale,
  type OnboardingFlowStep,
  type UpsertAccountProfileInput,
} from '@cosmika/shared'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  FormSection,
  Input,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

import { api } from '../lib/api'
import { supportEmail } from '../lib/instance'
import { useStoredSession, writeSession } from '../lib/session-store'

import {
  AiShareField,
  BusinessDescriptionField,
  ChannelsField,
  CompanySizeField,
  FeaturesField,
  IndustryField,
  SupportTodayField,
  VolumeField,
} from './business-profile-fields'

/**
 * The welcome flow: four screens plus a closing one, shown right after
 * signup.
 *
 * Two rules the whole file is built around:
 *
 * 1. **Nothing is required, and skipping never blocks access.** The person
 *    just created the account; losing them here costs more than any answer is
 *    worth. "Skip for now" is on every screen including the first, and even a
 *    failed save lets them out.
 * 2. **Each screen saves on Continue, not the flow at the end.** Somebody who
 *    gives up on screen three still leaves screens one and two with us.
 *
 * Operational answers (company name, site, timezone, language, the admin's
 * name and phone) go to the endpoints that already own them, PATCH /accounts
 * and PATCH /me, rather than through a second write path. The commercial ones
 * go to PUT /accounts/:id/profile.
 */

const SCREENS = ['company', 'admin', 'business', 'intent'] as const
type Screen = (typeof SCREENS)[number]

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
]

/**
 * What the browser thinks, used only to prefill screen one on a first visit.
 * This is the point of that screen: without it every account in the world
 * silently runs on America/Sao_Paulo, which has already confused working
 * hours. An unresolvable or unsupported guess falls back to what the account
 * already has, so the worst case is today's behaviour.
 */
export function guessTimezone(fallback: string): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && isValidTimezone(tz) ? tz : fallback
  } catch {
    return fallback
  }
}

export function guessLocale(fallback: Locale): Locale {
  const lower = navigator.language.toLowerCase()
  if (lower.startsWith('pt')) return 'pt-BR'
  if (lower.startsWith('es')) return 'es'
  if (lower.startsWith('en')) return 'en'
  return fallback
}

/** Only checked when something was typed, and only for shape. */
export function looksLikeDomain(value: string): boolean {
  const v = value.trim()
  if (!v) return true
  return !/\s/.test(v) && /\.[a-z]{2,}/i.test(v.replace(/^https?:\/\//i, ''))
}

type Answers = {
  name: string
  domain: string
  industry: BusinessIndustry | null
  size: CompanySize | null
  timezone: string
  locale: Locale
  fullName: string
  phone: string
  description: string
  supportToday: SupportToday | null
  channels: SupportChannel[]
  volume: ConversationVolume | null
  features: IntendedFeature[]
  expectedVolume: ConversationVolume | null
  aiShare: ExpectedAiShare | null
}

export function OnboardingFlow() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready, setSession } = useStoredSession()

  const [screen, setScreen] = React.useState<Screen | 'done'>('company')
  const [loaded, setLoaded] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [domainError, setDomainError] = React.useState<string | null>(null)
  const [answers, setAnswers] = React.useState<Answers | null>(null)

  const isAdmin = session?.membership.role === 'ADMINISTRATOR'

  // Read once, on the first render where the stored session is available.
  //
  // Guarded by a ref rather than by the dependency list because this effect
  // SETS the answers: anything that makes it run twice retypes the form from
  // the server and throws away what the person was in the middle of writing.
  // `useRouter()` hands back a fresh object on every render, which is exactly
  // that, and it cost an afternoon.
  const sessionRef = React.useRef(session)
  sessionRef.current = session
  const started = React.useRef(false)

  React.useEffect(() => {
    if (!ready || started.current) return
    started.current = true
    const current = sessionRef.current
    if (!current) {
      router.replace('/sign-in')
      return
    }
    // Somebody who joined by invitation never sees the account questions.
    // They did not choose to be here and cannot answer most of them anyway.
    if (current.membership.role !== 'ADMINISTRATOR') {
      router.replace('/inbox')
      return
    }
    api
      .getAccountProfile(current.session.token, current.account.id)
      .catch(() => null)
      .then((profile: AccountProfileDTO | null) => {
        // Finished or dismissed: the flow never captures the route again.
        // Skipping is skipping.
        if (profile && (profile.completedAt || profile.skippedAt)) {
          router.replace('/inbox')
          return
        }
        setAnswers(initialAnswers(current, profile))
        const resumeAt = profile?.lastStep
        setScreen(
          resumeAt && resumeAt !== 'done' ? (resumeAt as Screen) : 'company',
        )
        setLoaded(true)
      })
  }, [ready, router])

  if (!ready || !session || !isAdmin || !loaded || !answers) return null

  const set = <K extends keyof Answers>(key: K, value: Answers[K]) =>
    setAnswers({ ...answers, [key]: value })

  if (screen === 'done') {
    const firstName = (session.user.fullName ?? '').trim().split(' ')[0]
    return (
      <Card className="w-full max-w-xl" data-screen="done">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            {firstName
              ? t('onboardingFlow.done.title', { name: firstName })
              : t('onboardingFlow.done.title_anonymous')}
          </CardTitle>
          <CardDescription>{t('onboardingFlow.done.body')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button variant="primary" asChild>
              <Link href="/inboxes/new">{t('onboardingFlow.done.primary')}</Link>
            </Button>
            <Button variant="link" asChild>
              <Link href="/inbox">{t('onboardingFlow.done.secondary')}</Link>
            </Button>
          </div>
          {/* No price and no plan name, deliberately. What a plan costs and
              what it is called change, and the authority for both is the
              pricing page plus cosmo-admin; a number copied into the product
              goes stale where nobody is looking. What somebody needs at this
              exact moment is only that nothing is about to be charged. */}
          <p className="text-xs text-muted-foreground" data-testid="trial-note">
            {t('onboardingFlow.done.trial')}
          </p>
        </CardContent>
      </Card>
    )
  }


  // Everything below runs on a real question screen. Declaring the handlers
  // here, after the closing card has returned, is what lets `screen` be one
  // of the four and keeps a pile of "if we are on the last screen" guards out
  // of code that can never see it.
  const token = session.session.token
  const accountId = session.account.id

  const index = SCREENS.indexOf(screen)
  const stepLabel = t('onboardingFlow.step_of', {
    current: index + 1,
    total: SCREENS.length,
  })

  /** Which screen to resume at if they close the browser now. */
  const nextStepKey = (from: Screen): OnboardingFlowStep =>
    from === 'intent' ? 'done' : SCREENS[SCREENS.indexOf(from) + 1]!

  const saveScreen = async (current: Screen): Promise<boolean> => {
    setError(null)
    setSaving(true)
    try {
      const profile: UpsertAccountProfileInput = {
        lastStep: nextStepKey(current),
        ...(current === 'intent'
          ? { state: 'completed' as const }
          : { state: 'in_progress' as const }),
      }

      if (current === 'company') {
        const updated = await api.updateAccount(token, accountId, {
          name: answers.name.trim() || session.account.name,
          domain: answers.domain.trim() ? answers.domain.trim() : null,
          defaultLocale: answers.locale,
          defaultTimezone: answers.timezone,
        })
        // The shell reads the account out of the stored session, so a name or
        // language changed here has to reach it now, not on next sign-in.
        const next = { ...session, account: updated }
        setSession(next)
        writeSession(next)
        profile.businessIndustry = answers.industry
        profile.companySize = answers.size
      }

      if (current === 'admin') {
        const user = await api.updateMe(token, {
          ...(answers.fullName.trim() ? { fullName: answers.fullName.trim() } : {}),
          phone: answers.phone.trim() ? answers.phone.trim() : null,
        })
        const next = { ...session, user }
        setSession(next)
        writeSession(next)
      }

      if (current === 'business') {
        profile.businessDescription = answers.description.trim()
          ? answers.description.trim()
          : null
        profile.supportToday = answers.supportToday
        profile.channelsToday = answers.channels
        profile.conversationVolume = answers.volume
      }

      if (current === 'intent') {
        profile.intendedFeatures = answers.features
        profile.expectedVolume = answers.expectedVolume
        // Only meaningful when they said they want the AI agent at all.
        profile.expectedAiShare = answers.features.includes('aiAgent')
          ? answers.aiShare
          : null
      }

      await api.saveAccountProfile(token, accountId, profile)
      setSaving(false)
      return true
    } catch {
      setError(t('onboardingFlow.save_error'))
      setSaving(false)
      return false
    }
  }

  const onContinue = async () => {
    if (screen === 'company' && !looksLikeDomain(answers.domain)) {
      setDomainError(t('onboardingFlow.company.domain_error'))
      return
    }
    setDomainError(null)
    const ok = await saveScreen(screen)
    if (!ok) return
    setScreen(screen === 'intent' ? 'done' : (nextStepKey(screen) as Screen))
  }

  const onSkip = async () => {
    // Skipping must never be able to fail: a dead API cannot be what keeps
    // somebody out of the product they just signed up for.
    await api
      .saveAccountProfile(token, accountId, { state: 'skipped', lastStep: screen })
      .catch(() => null)
    router.push('/inbox')
  }

  // Only reachable from the Back button, which screen one does not render.
  const onBack = () => {
    setError(null)
    setScreen(SCREENS[SCREENS.indexOf(screen) - 1]!)
  }

  return (
    <Card className="w-full max-w-xl" data-screen={screen}>
      <CardHeader className="space-y-3">
        <div className="space-y-1.5">
          <Progress value={index + 1} max={SCREENS.length} label={stepLabel} />
          <p className="text-xs text-muted-foreground">{stepLabel}</p>
        </div>
        <div className="space-y-1">
          <CardTitle className="text-lg font-semibold">
            {t(`onboardingFlow.${screen}.title`)}
          </CardTitle>
          <CardDescription>
            {t(`onboardingFlow.${screen}.subtitle`)}
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <FormSection>
          {screen === 'company' ? (
            <>
              <FormField
                label={t('onboardingFlow.company.name')}
                htmlFor="welcome-name"
              >
                <Input
                  id="welcome-name"
                  value={answers.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              </FormField>
              <FormField
                label={t('onboardingFlow.company.domain')}
                htmlFor="welcome-domain"
                error={domainError}
              >
                <Input
                  id="welcome-domain"
                  placeholder="suaempresa.com.br"
                  value={answers.domain}
                  onChange={(e) => set('domain', e.target.value)}
                />
              </FormField>
              <IndustryField
                t={t}
                value={answers.industry}
                onChange={(v) => set('industry', v)}
              />
              <CompanySizeField
                t={t}
                value={answers.size}
                onChange={(v) => set('size', v)}
              />
              <FormField
                label={t('onboardingFlow.company.timezone')}
                htmlFor="welcome-timezone"
                hint={t('onboardingFlow.company.timezone_hint')}
              >
                {/* Free text with suggestions, like Settings: the full IANA
                    list does not fit in a Select. */}
                <Input
                  id="welcome-timezone"
                  list="welcome-timezones"
                  value={answers.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                />
                <datalist id="welcome-timezones">
                  {TIMEZONE_PRESETS.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </FormField>
              <FormField
                label={t('onboardingFlow.company.locale')}
                htmlFor="welcome-locale"
                hint={t('onboardingFlow.company.locale_hint')}
              >
                <Select
                  value={answers.locale}
                  onValueChange={(v) => set('locale', v as Locale)}
                >
                  <SelectTrigger id="welcome-locale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </>
          ) : null}

          {screen === 'admin' ? (
            <>
              <FormField
                label={t('onboardingFlow.admin.full_name')}
                htmlFor="welcome-full-name"
              >
                <Input
                  id="welcome-full-name"
                  autoComplete="name"
                  value={answers.fullName}
                  onChange={(e) => set('fullName', e.target.value)}
                />
              </FormField>
              <FormField
                label={t('onboardingFlow.admin.phone')}
                htmlFor="welcome-phone"
                hint={t('onboardingFlow.admin.phone_hint')}
              >
                <Input
                  id="welcome-phone"
                  type="tel"
                  autoComplete="tel"
                  value={answers.phone}
                  onChange={(e) => set('phone', e.target.value)}
                />
              </FormField>
            </>
          ) : null}

          {screen === 'business' ? (
            <>
              <BusinessDescriptionField
                t={t}
                value={answers.description}
                onChange={(v) => set('description', v)}
              />
              <SupportTodayField
                t={t}
                value={answers.supportToday}
                onChange={(v) => set('supportToday', v)}
              />
              <ChannelsField
                t={t}
                values={answers.channels}
                onChange={(v) => set('channels', v)}
              />
              <VolumeField
                t={t}
                id="welcome-volume"
                label={t('onboardingFlow.business.volume')}
                value={answers.volume}
                onChange={(v) => set('volume', v)}
              />
            </>
          ) : null}

          {screen === 'intent' ? (
            <>
              <FeaturesField
                t={t}
                values={answers.features}
                onChange={(v) => set('features', v)}
              />
              <VolumeField
                t={t}
                id="welcome-expected-volume"
                label={t('onboardingFlow.intent.expected_volume')}
                value={answers.expectedVolume}
                onChange={(v) => set('expectedVolume', v)}
              />
              {answers.features.includes('aiAgent') ? (
                <AiShareField
                  t={t}
                  value={answers.aiShare}
                  onChange={(v) => set('aiShare', v)}
                />
              ) : null}
              {/* The address for correcting or deleting what the flow collected:
                  the install's support (NEXT_PUBLIC_SUPPORT_EMAIL). An install
                  that set none shows no line rather than someone else's. */}
              {supportEmail() ? (
                <p className="text-xs text-muted-foreground">
                  {t('onboardingFlow.intent.privacy', { contact: supportEmail()! })}
                </p>
              ) : null}
            </>
          ) : null}
        </FormSection>

        {error ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Button variant="link" size="sm" className="h-auto px-0" onClick={onSkip}>
              {t('onboardingFlow.skip')}
            </Button>
            {/* Said before the click, not after: what skipping costs is
                exactly nothing, and knowing that is what makes the button
                safe to press instead of abandoning the tab. */}
            <p className="text-xs text-muted-foreground">
              {t('onboardingFlow.skipped_notice')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {screen !== 'company' ? (
              <Button variant="outline" onClick={onBack} disabled={saving}>
                {t('onboardingFlow.back')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={onContinue} disabled={saving}>
              {saving
                ? t('onboardingFlow.saving')
                : screen === 'intent'
                  ? t('onboardingFlow.finish')
                  : t('onboardingFlow.continue')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

type Session = NonNullable<ReturnType<typeof useStoredSession>['session']>

function initialAnswers(
  session: Session,
  profile: AccountProfileDTO | null,
): Answers {
  // No row means the flow has never saved anything, so screen one has never
  // been answered and the browser's guess is the best we have. On a resume,
  // the account already holds what was saved.
  const first = profile === null
  return {
    name: session.account.name,
    domain: session.account.domain ?? '',
    industry: profile?.businessIndustry ?? null,
    size: profile?.companySize ?? null,
    timezone: first
      ? guessTimezone(session.account.defaultTimezone)
      : session.account.defaultTimezone,
    locale: first
      ? guessLocale(session.account.defaultLocale as Locale)
      : (session.account.defaultLocale as Locale),
    fullName: session.user.fullName ?? '',
    phone: session.user.phone ?? '',
    description: profile?.businessDescription ?? '',
    supportToday: profile?.supportToday ?? null,
    channels: (profile?.channelsToday ?? []) as SupportChannel[],
    volume: profile?.conversationVolume ?? null,
    features: (profile?.intendedFeatures ?? []) as IntendedFeature[],
    expectedVolume: profile?.expectedVolume ?? null,
    aiShare: profile?.expectedAiShare ?? null,
  }
}
