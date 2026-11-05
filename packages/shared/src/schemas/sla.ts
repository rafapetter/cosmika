import { z } from 'zod'

export const SlaPolicyDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  firstResponseLowMinutes: z.number().int(),
  firstResponseNormalMinutes: z.number().int(),
  firstResponseHighMinutes: z.number().int(),
  firstResponseUrgentMinutes: z.number().int(),
  resolutionLowMinutes: z.number().int(),
  resolutionNormalMinutes: z.number().int(),
  resolutionHighMinutes: z.number().int(),
  resolutionUrgentMinutes: z.number().int(),
  // First-response target in seconds for every priority, overriding the
  // minute targets. Null when the policy works in minutes only.
  firstResponseSeconds: z.number().int().nullable(),
  createdAt: z.string(),
})
export type SlaPolicyDTO = z.infer<typeof SlaPolicyDTO>

const minutesField = z.number().int().min(1).max(60 * 24 * 30) // 1m..30d

export const CreateSlaPolicyInput = z.object({
  name: z.string().min(1).max(120),
  firstResponseLowMinutes: minutesField.optional(),
  firstResponseNormalMinutes: minutesField.optional(),
  firstResponseHighMinutes: minutesField.optional(),
  firstResponseUrgentMinutes: minutesField.optional(),
  resolutionLowMinutes: minutesField.optional(),
  resolutionNormalMinutes: minutesField.optional(),
  resolutionHighMinutes: minutesField.optional(),
  resolutionUrgentMinutes: minutesField.optional(),
  // 10 s to 24 h. Null clears it back to the minute targets.
  firstResponseSeconds: z.number().int().min(10).max(86_400).nullable().optional(),
})
export type CreateSlaPolicyInput = z.infer<typeof CreateSlaPolicyInput>

export const UpdateSlaPolicyInput = CreateSlaPolicyInput.partial()
export type UpdateSlaPolicyInput = z.infer<typeof UpdateSlaPolicyInput>

export const SlaState = z.enum([
  'NOT_APPLICABLE',  // inbox has no policy, or already resolved
  'ON_TRACK',
  'AT_RISK',         // within 80% of target
  'BREACHED',
])
export type SlaState = z.infer<typeof SlaState>

export const SlaStatusDTO = z.object({
  state: SlaState,
  // The dimension that's most pressing right now: 'firstResponse' until a
  // first reply lands, then 'resolution'. NOT_APPLICABLE has dimension=null.
  dimension: z.enum(['firstResponse', 'resolution']).nullable(),
  targetAt: z.string().nullable(),
  minutesRemaining: z.number().nullable(),
  // Same as minutesRemaining, for second-level targets.
  secondsRemaining: z.number().nullable().optional(),
})
export type SlaStatusDTO = z.infer<typeof SlaStatusDTO>

// One conversation that crossed its first-response target without a reply:
// the "missed conversations" report.
export const SlaMissDTO = z.object({
  conversationId: z.string(),
  displayId: z.number().int(),
  contactName: z.string().nullable(),
  inboxName: z.string(),
  teamName: z.string().nullable(),
  assigneeName: z.string().nullable(),
  queuedAt: z.string(),
  targetAt: z.string(),
  breachedAt: z.string(),
  firstReplyAt: z.string().nullable(),
  status: z.string(),
})
export type SlaMissDTO = z.infer<typeof SlaMissDTO>

export const SlaMissesQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  teamId: z.string().optional(),
  inboxId: z.string().optional(),
})
export type SlaMissesQuery = z.infer<typeof SlaMissesQuery>
