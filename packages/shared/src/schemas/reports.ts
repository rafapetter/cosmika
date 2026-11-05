import { z } from 'zod'

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

const baseRangeFilters = {
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  inboxId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
}

export const OverviewQuery = z.object(baseRangeFilters)
export type OverviewQuery = z.infer<typeof OverviewQuery>

export const TimeseriesMetric = z.enum([
  'conversations',
  'messages',
  'first_response_avg',
])
export type TimeseriesMetric = z.infer<typeof TimeseriesMetric>

export const TimeseriesBucket = z.enum(['day', 'week'])
export type TimeseriesBucket = z.infer<typeof TimeseriesBucket>

export const TimeseriesQuery = z.object({
  metric: TimeseriesMetric,
  bucket: TimeseriesBucket.default('day'),
  ...baseRangeFilters,
})
export type TimeseriesQuery = z.infer<typeof TimeseriesQuery>

export const LeaderboardQuery = z.object({
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
})
export type LeaderboardQuery = z.infer<typeof LeaderboardQuery>

export const BreakdownDimension = z.enum(['inbox', 'team', 'agent'])
export type BreakdownDimension = z.infer<typeof BreakdownDimension>

export const BreakdownQuery = z.object({
  dimension: BreakdownDimension,
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
})
export type BreakdownQuery = z.infer<typeof BreakdownQuery>

// Response shapes

export const ConversationStatusCounts = z.object({
  open: z.number().int(),
  pending: z.number().int(),
  resolved: z.number().int(),
})
export type ConversationStatusCounts = z.infer<typeof ConversationStatusCounts>

export const SentimentBreakdown = z.object({
  positive: z.number().int(),
  neutral: z.number().int(),
  negative: z.number().int(),
  unknown: z.number().int(),
})
export type SentimentBreakdown = z.infer<typeof SentimentBreakdown>

export const MessagesBySender = z.object({
  CONTACT: z.number().int(),
  USER: z.number().int(),
  AGENT_BOT: z.number().int(),
  SYSTEM: z.number().int(),
})
export type MessagesBySender = z.infer<typeof MessagesBySender>

export const TagCount = z.object({
  tag: z.string(),
  count: z.number().int(),
})
export type TagCount = z.infer<typeof TagCount>

export const AiUsageSummary = z.object({
  totalCostUsd: z.number(),
  totalTokensIn: z.number().int(),
  totalTokensOut: z.number().int(),
  sessions: z.number().int(),
})
export type AiUsageSummary = z.infer<typeof AiUsageSummary>

export const OverviewResponse = z.object({
  from: z.string(),
  to: z.string(),
  totalConversations: z.number().int(),
  statusCounts: ConversationStatusCounts,
  avgFirstResponseSeconds: z.number().nullable(),
  medianFirstResponseSeconds: z.number().nullable(),
  avgResolutionSeconds: z.number().nullable(),
  sentimentBreakdown: SentimentBreakdown,
  topTags: z.array(TagCount),
  ai: AiUsageSummary,
  messagesBySender: MessagesBySender,
})
export type OverviewResponse = z.infer<typeof OverviewResponse>

export const TimeseriesPoint = z.object({
  bucket: z.string(),
  value: z.number(),
})
export type TimeseriesPoint = z.infer<typeof TimeseriesPoint>

export const TimeseriesResponse = z.object({
  metric: TimeseriesMetric,
  bucket: TimeseriesBucket,
  from: z.string(),
  to: z.string(),
  points: z.array(TimeseriesPoint),
})
export type TimeseriesResponse = z.infer<typeof TimeseriesResponse>

export const LeaderboardEntry = z.object({
  userId: z.string(),
  userEmail: z.string(),
  userFullName: z.string().nullable(),
  resolvedCount: z.number().int(),
  avgFirstResponseSeconds: z.number().nullable(),
})
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>

export const LeaderboardResponse = z.object({
  from: z.string(),
  to: z.string(),
  entries: z.array(LeaderboardEntry),
})
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>

export const BreakdownRow = z.object({
  id: z.string().nullable(),
  label: z.string(),
  total: z.number().int(),
  open: z.number().int(),
  pending: z.number().int(),
  resolved: z.number().int(),
  avgFirstResponseSeconds: z.number().nullable(),
  avgResolutionSeconds: z.number().nullable(),
})
export type BreakdownRow = z.infer<typeof BreakdownRow>

export const BreakdownResponse = z.object({
  from: z.string(),
  to: z.string(),
  dimension: BreakdownDimension,
  rows: z.array(BreakdownRow),
})
export type BreakdownResponse = z.infer<typeof BreakdownResponse>
