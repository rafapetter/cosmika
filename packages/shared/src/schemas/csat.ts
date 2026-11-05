import { z } from 'zod'

/** CSAT asks 1 to 5; NPS asks 0 to 10 ("how likely to recommend"). */
export const SurveyType = z.enum(['CSAT', 'NPS'])
export type SurveyType = z.infer<typeof SurveyType>

export const CsatSurveyDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  conversationId: z.string(),
  inboxId: z.string(),
  token: z.string(),
  assignedAgentId: z.string().nullable(),
  promptedAt: z.string(),
  respondedAt: z.string().nullable(),
  type: SurveyType,
  rating: z.number().int().min(0).max(10).nullable(),
  comment: z.string().nullable(),
})
export type CsatSurveyDTO = z.infer<typeof CsatSurveyDTO>

/**
 * Public-facing summary returned to the contact when they open /csat/[token].
 */
export const CsatPublicSurvey = z.object({
  type: SurveyType,
  alreadyResponded: z.boolean(),
  conversationDisplayId: z.number(),
  accountName: z.string(),
})
export type CsatPublicSurvey = z.infer<typeof CsatPublicSurvey>

// The range depends on the survey's type (CSAT 1..5, NPS 0..10); the service
// checks it against the stored survey.
export const SubmitCsatInput = z.object({
  rating: z.number().int().min(0).max(10),
  comment: z.string().max(1000).optional(),
})
export type SubmitCsatInput = z.infer<typeof SubmitCsatInput>

export const CsatStatsQuery = z.object({
  inboxId: z.string().optional(),
  agentId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})
export type CsatStatsQuery = z.infer<typeof CsatStatsQuery>

export const CsatBucket = z.object({
  key: z.string(),
  label: z.string(),
  responses: z.number(),
  averageRating: z.number().nullable(),
})
export type CsatBucket = z.infer<typeof CsatBucket>

export const CsatStats = z.object({
  totalPrompted: z.number(),
  totalResponded: z.number(),
  averageRating: z.number().nullable(),
  byInbox: z.array(CsatBucket),
  byAgent: z.array(CsatBucket),
})
export type CsatStats = z.infer<typeof CsatStats>

export const SurveySettingsDTO = z.object({ surveyType: SurveyType })
export type SurveySettingsDTO = z.infer<typeof SurveySettingsDTO>

export const NpsQuery = z.object({
  inboxId: z.string().optional(),
  teamId: z.string().optional(),
  agentId: z.string().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})
export type NpsQuery = z.infer<typeof NpsQuery>

/** 9-10 promoters, 7-8 passives, 0-6 detractors; NPS = %promoters - %detractors. */
export const NpsSummary = z.object({
  responses: z.number().int(),
  promoters: z.number().int(),
  passives: z.number().int(),
  detractors: z.number().int(),
  /** -100..100, rounded; null with no responses. */
  nps: z.number().nullable(),
})
export type NpsSummary = z.infer<typeof NpsSummary>

export const NpsBucket = NpsSummary.extend({ key: z.string(), label: z.string() })
export type NpsBucket = z.infer<typeof NpsBucket>

export const NpsStats = NpsSummary.extend({
  totalPrompted: z.number().int(),
  byTeam: z.array(NpsBucket),
  byAgent: z.array(NpsBucket),
})
export type NpsStats = z.infer<typeof NpsStats>
