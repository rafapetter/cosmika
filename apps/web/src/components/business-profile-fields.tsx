'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import {
  BusinessIndustry,
  CompanySize,
  ConversationVolume,
  ExpectedAiShare,
  IntendedFeature,
  SupportChannel,
  SupportToday,
} from '@cosmika/shared'
import {
  Checkbox,
  FormField,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

// The controls for the commercial profile, in one place, because two screens
// ask the same questions: the welcome flow and the "About the business"
// section in Settings. Keeping one copy is what stops the two drifting into
// different option lists for the same column.
//
// Every list is closed and every value is a key: the label comes from i18n,
// so the database never stores a Portuguese string that Spanish cannot read.

type T = ReturnType<typeof useTranslations>

// Nothing here is mandatory, so every Select starts unanswered and shows its
// placeholder. Radix has no empty option, which is why "unanswered" is
// `undefined` rather than a sentinel value in the list: an option that means
// "no answer" would read as an answer.
function OptionSelect<V extends string>({
  id,
  label,
  hint,
  placeholder,
  options,
  optionLabel,
  value,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  placeholder: string
  options: readonly V[]
  optionLabel: (v: V) => string
  value: V | null
  onChange: (v: V) => void
}) {
  return (
    <FormField label={label} htmlFor={id} hint={hint}>
      <Select
        value={value ?? undefined}
        onValueChange={(v) => onChange(v as V)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {optionLabel(o)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  )
}

/** A group of checkboxes. There is no multi-select primitive and this does
 *  not need one: eight options fit on the screen, and a list you can read at
 *  a glance answers faster than a control you have to open. */
function CheckboxGroup<V extends string>({
  legend,
  options,
  optionLabel,
  optionHelp,
  values,
  onChange,
  idPrefix,
}: {
  legend: string
  options: readonly V[]
  optionLabel: (v: V) => string
  optionHelp?: (v: V) => string
  values: V[]
  onChange: (next: V[]) => void
  idPrefix: string
}) {
  const toggle = (o: V) => {
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o])
  }
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">{legend}</legend>
      <div className={optionHelp ? 'space-y-3 pt-1' : 'grid gap-2 pt-1 sm:grid-cols-2'}>
        {options.map((o) => {
          const id = `${idPrefix}-${o}`
          return (
            <div key={o} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                checked={values.includes(o)}
                onCheckedChange={() => toggle(o)}
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={id} className="font-normal">
                  {optionLabel(o)}
                </Label>
                {optionHelp ? (
                  <p className="text-xs text-muted-foreground">{optionHelp(o)}</p>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

export function IndustryField({
  t,
  value,
  onChange,
}: {
  t: T
  value: BusinessIndustry | null
  onChange: (v: BusinessIndustry) => void
}) {
  return (
    <OptionSelect
      id="profile-industry"
      label={t('onboardingFlow.company.industry')}
      placeholder={t('onboardingFlow.company.industry_placeholder')}
      options={BusinessIndustry.options}
      optionLabel={(o) => t(`onboardingFlow.industries.${o}`)}
      value={value}
      onChange={onChange}
    />
  )
}

export function CompanySizeField({
  t,
  value,
  onChange,
}: {
  t: T
  value: CompanySize | null
  onChange: (v: CompanySize) => void
}) {
  return (
    <OptionSelect
      id="profile-size"
      label={t('onboardingFlow.company.size')}
      placeholder={t('onboardingFlow.company.size_placeholder')}
      options={CompanySize.options}
      optionLabel={(o) => t(`onboardingFlow.sizes.${o}`)}
      value={value}
      onChange={onChange}
    />
  )
}

export function BusinessDescriptionField({
  t,
  value,
  onChange,
}: {
  t: T
  value: string
  onChange: (v: string) => void
}) {
  return (
    <FormField
      label={t('onboardingFlow.business.description')}
      htmlFor="profile-description"
      hint={t('onboardingFlow.business.description_hint')}
    >
      <Textarea
        id="profile-description"
        rows={2}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </FormField>
  )
}

export function SupportTodayField({
  t,
  value,
  onChange,
}: {
  t: T
  value: SupportToday | null
  onChange: (v: SupportToday) => void
}) {
  return (
    <OptionSelect
      id="profile-support-today"
      label={t('onboardingFlow.business.support_today')}
      placeholder={t('onboardingFlow.business.support_today_placeholder')}
      options={SupportToday.options}
      optionLabel={(o) => t(`onboardingFlow.support.${o}`)}
      value={value}
      onChange={onChange}
    />
  )
}

export function ChannelsField({
  t,
  values,
  onChange,
}: {
  t: T
  values: SupportChannel[]
  onChange: (next: SupportChannel[]) => void
}) {
  return (
    <CheckboxGroup
      legend={t('onboardingFlow.business.channels')}
      idPrefix="profile-channel"
      options={SupportChannel.options}
      optionLabel={(o) => t(`onboardingFlow.channels.${o}`)}
      values={values}
      onChange={onChange}
    />
  )
}

export function VolumeField({
  t,
  id,
  label,
  hint,
  value,
  onChange,
}: {
  t: T
  id: string
  label: string
  hint?: string
  value: ConversationVolume | null
  onChange: (v: ConversationVolume) => void
}) {
  return (
    <OptionSelect
      id={id}
      label={label}
      hint={hint}
      placeholder={t('onboardingFlow.business.volume_placeholder')}
      options={ConversationVolume.options}
      optionLabel={(o) => t(`onboardingFlow.volumes.${o}`)}
      value={value}
      onChange={onChange}
    />
  )
}

export function FeaturesField({
  t,
  values,
  onChange,
}: {
  t: T
  values: IntendedFeature[]
  onChange: (next: IntendedFeature[]) => void
}) {
  return (
    <CheckboxGroup
      legend={t('onboardingFlow.intent.features')}
      idPrefix="profile-feature"
      options={IntendedFeature.options}
      optionLabel={(o) => t(`onboardingFlow.features.${o}`)}
      optionHelp={(o) => t(`onboardingFlow.features.${o}_help`)}
      values={values}
      onChange={onChange}
    />
  )
}

export function AiShareField({
  t,
  value,
  onChange,
}: {
  t: T
  value: ExpectedAiShare | null
  onChange: (v: ExpectedAiShare) => void
}) {
  return (
    <OptionSelect
      id="profile-ai-share"
      label={t('onboardingFlow.intent.ai_share')}
      hint={t('onboardingFlow.intent.ai_share_hint')}
      placeholder={t('onboardingFlow.intent.ai_share_placeholder')}
      options={ExpectedAiShare.options}
      optionLabel={(o) => t(`onboardingFlow.ai_shares.${o}`)}
      value={value}
      onChange={onChange}
    />
  )
}
