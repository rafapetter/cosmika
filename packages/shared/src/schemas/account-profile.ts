import { z } from 'zod'

/**
 * The commercial profile of an account, collected by the welcome flow.
 *
 * Everything here is a closed list on purpose. Nobody knows their own
 * conversation volume to the unit, and what we act on is the band; free text
 * would only produce answers nothing can be counted from. The single free
 * text field is `businessDescription`, which is the one answer whose value is
 * precisely that it is not a category.
 *
 * Operational configuration does NOT live here: company name, site, timezone
 * and language stay on `Account`, and the admin's name and phone stay on
 * `User`. See docs/plan-onboarding-flow.md, decision 1.
 */

export const BusinessIndustry = z.enum([
  'healthcare',
  'education',
  'retail',
  'professionalServices',
  'technology',
  'finance',
  'realEstate',
  'logistics',
  'manufacturing',
  'association',
  'tourism',
  'government',
  'other',
])
export type BusinessIndustry = z.infer<typeof BusinessIndustry>

export const CompanySize = z.enum(['solo', 'upTo5', 'upTo15', 'upTo50', 'over50'])
export type CompanySize = z.infer<typeof CompanySize>

export const SupportToday = z.enum([
  'myself',
  'internalTeam',
  'outsourcedTeam',
  'bot',
  'nobody',
])
export type SupportToday = z.infer<typeof SupportToday>

export const SupportChannel = z.enum([
  'whatsapp',
  'instagram',
  'messenger',
  'telegram',
  'email',
  'webchat',
  'phone',
  'other',
])
export type SupportChannel = z.infer<typeof SupportChannel>

/**
 * Volume bands. The boundaries are the PLAN_CAPS boundaries (50 / 500 / 1500
 * / 5000) so an answer can be read against a plan ceiling without arithmetic
 * that pretends to a precision the answer does not have. `unknown` is a real
 * answer, not a missing one: plenty of people genuinely do not know.
 */
export const ConversationVolume = z.enum([
  'upTo50',
  'upTo500',
  'upTo1500',
  'upTo5000',
  'over5000',
  'unknown',
])
export type ConversationVolume = z.infer<typeof ConversationVolume>

export const IntendedFeature = z.enum([
  'humanSupport',
  'flows',
  'aiAgent',
  'knowledgeBase',
  'broadcasts',
  'reports',
])
export type IntendedFeature = z.infer<typeof IntendedFeature>

export const ExpectedAiShare = z.enum(['minimal', 'upToAThird', 'aboutHalf', 'most'])
export type ExpectedAiShare = z.infer<typeof ExpectedAiShare>

/** Screens of the welcome flow, in order. `done` is the closing screen. */
export const OnboardingFlowStep = z.enum([
  'company',
  'admin',
  'business',
  'intent',
  'done',
])
export type OnboardingFlowStep = z.infer<typeof OnboardingFlowStep>

/**
 * What the row means, not what the screen did:
 * - `in_progress` — someone is partway through, resume at `lastStep`
 * - `completed` — they reached the end
 * - `skipped` — they pressed "skip for now"; the flow never asks again
 */
export const OnboardingFlowState = z.enum(['in_progress', 'completed', 'skipped'])
export type OnboardingFlowState = z.infer<typeof OnboardingFlowState>

const nullableText = (max: number) =>
  z.string().max(max).nullable().optional()

/**
 * One endpoint writes the whole profile, with every field optional. Three
 * endpoints (save / complete / skip) would be a state machine for four
 * screens; `state` carries that instead.
 */
export const UpsertAccountProfileInput = z.object({
  businessIndustry: BusinessIndustry.nullable().optional(),
  companySize: CompanySize.nullable().optional(),
  businessDescription: nullableText(2000),
  supportToday: SupportToday.nullable().optional(),
  channelsToday: z.array(SupportChannel).max(20).optional(),
  conversationVolume: ConversationVolume.nullable().optional(),
  intendedFeatures: z.array(IntendedFeature).max(20).optional(),
  expectedVolume: ConversationVolume.nullable().optional(),
  expectedAiShare: ExpectedAiShare.nullable().optional(),
  lastStep: OnboardingFlowStep.optional(),
  state: OnboardingFlowState.optional(),
})
export type UpsertAccountProfileInput = z.infer<typeof UpsertAccountProfileInput>

export const AccountProfileDTO = z.object({
  accountId: z.string(),
  businessIndustry: BusinessIndustry.nullable(),
  companySize: CompanySize.nullable(),
  businessDescription: z.string().nullable(),
  supportToday: SupportToday.nullable(),
  channelsToday: z.array(z.string()),
  conversationVolume: ConversationVolume.nullable(),
  intendedFeatures: z.array(z.string()),
  expectedVolume: ConversationVolume.nullable(),
  expectedAiShare: ExpectedAiShare.nullable(),
  version: z.number(),
  lastStep: OnboardingFlowStep.nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  skippedAt: z.string().nullable(),
})
export type AccountProfileDTO = z.infer<typeof AccountProfileDTO>

/** Pending = nobody finished it and nobody dismissed it. */
export const isProfilePending = (p: AccountProfileDTO | null): boolean =>
  p === null || (p.completedAt === null && p.skippedAt === null)
