'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type {
  AccountProfileDTO,
  BusinessIndustry,
  CompanySize,
  ConversationVolume,
  ExpectedAiShare,
  IntendedFeature,
  SupportChannel,
  SupportToday,
} from '@cosmika/shared'
import { Button } from '@cosmika/ui'

import { api } from '../lib/api'
import { apiErrorText } from '../lib/api-error'
import { useStoredSession } from '../lib/session-store'

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
 * "About the business" in Settings > Account: the same questions the welcome
 * flow asks, editable afterwards.
 *
 * This is what stops "skip for now" being a dead end, and it is where the
 * skip notice points. It saves without touching the flow's end timestamps, so
 * editing here never puts the account back into the funnel as unfinished.
 */
export function BusinessProfileForm({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [profile, setProfile] = React.useState<AccountProfileDTO | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [industry, setIndustry] = React.useState<BusinessIndustry | null>(null)
  const [size, setSize] = React.useState<CompanySize | null>(null)
  const [description, setDescription] = React.useState('')
  const [supportToday, setSupportToday] = React.useState<SupportToday | null>(null)
  const [channels, setChannels] = React.useState<SupportChannel[]>([])
  const [volume, setVolume] = React.useState<ConversationVolume | null>(null)
  const [features, setFeatures] = React.useState<IntendedFeature[]>([])
  const [expectedVolume, setExpectedVolume] =
    React.useState<ConversationVolume | null>(null)
  const [aiShare, setAiShare] = React.useState<ExpectedAiShare | null>(null)

  const token = session?.session.token
  const accountId = session?.account.id

  React.useEffect(() => {
    if (!token || !accountId || !isAdmin) return
    api
      .getAccountProfile(token, accountId)
      .catch(() => null)
      .then((p: AccountProfileDTO | null) => {
        setProfile(p)
        if (p) {
          setIndustry(p.businessIndustry)
          setSize(p.companySize)
          setDescription(p.businessDescription ?? '')
          setSupportToday(p.supportToday)
          setChannels(p.channelsToday as SupportChannel[])
          setVolume(p.conversationVolume)
          setFeatures(p.intendedFeatures as IntendedFeature[])
          setExpectedVolume(p.expectedVolume)
          setAiShare(p.expectedAiShare)
        }
        setLoaded(true)
      })
  }, [token, accountId, isAdmin])

  // The commercial profile is administrator-only, on read as well as write,
  // so for anyone else the section does not exist at all.
  if (!session || !isAdmin || !loaded) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaved(false)
    setSaving(true)
    try {
      // No `state`: this screen edits answers, it does not move the flow.
      const updated = await api.saveAccountProfile(
        session.session.token,
        session.account.id,
        {
          businessIndustry: industry,
          companySize: size,
          businessDescription: description.trim() ? description.trim() : null,
          supportToday,
          channelsToday: channels,
          conversationVolume: volume,
          intendedFeatures: features,
          expectedVolume,
          expectedAiShare: features.includes('aiAgent') ? aiShare : null,
        },
      )
      setProfile(updated)
      setSaved(true)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
      data-testid="business-profile-form"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t('onboardingFlow.settings.title')}
        </h2>
        <p className="pt-1 text-xs text-muted-foreground">
          {profile === null
            ? t('onboardingFlow.settings.empty')
            : t('onboardingFlow.settings.subtitle')}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <IndustryField t={t} value={industry} onChange={setIndustry} />
        <CompanySizeField t={t} value={size} onChange={setSize} />
      </div>

      <BusinessDescriptionField t={t} value={description} onChange={setDescription} />

      <div className="grid gap-4 sm:grid-cols-2">
        <SupportTodayField t={t} value={supportToday} onChange={setSupportToday} />
        <VolumeField
          t={t}
          id="settings-volume"
          label={t('onboardingFlow.business.volume')}
          value={volume}
          onChange={setVolume}
        />
      </div>

      <ChannelsField t={t} values={channels} onChange={setChannels} />
      <FeaturesField t={t} values={features} onChange={setFeatures} />

      <div className="grid gap-4 sm:grid-cols-2">
        <VolumeField
          t={t}
          id="settings-expected-volume"
          label={t('onboardingFlow.intent.expected_volume')}
          value={expectedVolume}
          onChange={setExpectedVolume}
        />
        {features.includes('aiAgent') ? (
          <AiShareField t={t} value={aiShare} onChange={setAiShare} />
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-muted-foreground">
          {t('onboardingFlow.settings.saved')}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving
            ? t('onboardingFlow.settings.saving')
            : t('onboardingFlow.settings.save')}
        </Button>
      </div>
    </form>
  )
}
