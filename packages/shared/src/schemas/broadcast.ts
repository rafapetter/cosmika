import { z } from 'zod'

export const BroadcastStatus = z.enum(['DRAFT', 'SENDING', 'SENT', 'FAILED'])
export type BroadcastStatus = z.infer<typeof BroadcastStatus>

// Audience selector. Empty object = every contact reachable on the inbox.
export const BroadcastAudience = z.object({
  country: z.string().min(2).max(2).optional(),
})
export type BroadcastAudience = z.infer<typeof BroadcastAudience>

export const CreateBroadcastInput = z.object({
  name: z.string().min(1).max(120),
  inboxId: z.string().min(1),
  templateId: z.string().min(1),
  variables: z.array(z.string()).max(20).default([]),
  audience: BroadcastAudience.default({}),
})
export type CreateBroadcastInput = z.infer<typeof CreateBroadcastInput>

export const BroadcastDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  inboxId: z.string(),
  name: z.string(),
  templateId: z.string(),
  variables: z.array(z.string()),
  audience: BroadcastAudience,
  status: BroadcastStatus,
  totalRecipients: z.number().int(),
  sentCount: z.number().int(),
  failedCount: z.number().int(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
})
export type BroadcastDTO = z.infer<typeof BroadcastDTO>

// Request to count recipients for a (inbox, audience) pair before sending.
export const PreviewAudienceInput = z.object({
  inboxId: z.string().min(1),
  audience: BroadcastAudience.default({}),
})
export type PreviewAudienceInput = z.infer<typeof PreviewAudienceInput>

// Recipient count for a (inbox, audience) pair — shown before sending.
export const BroadcastAudiencePreview = z.object({
  count: z.number().int(),
})
export type BroadcastAudiencePreview = z.infer<typeof BroadcastAudiencePreview>
