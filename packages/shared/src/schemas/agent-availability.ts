import { z } from 'zod'

export const AgentAvailabilityDTO = z.object({
  id: z.string(),
  memberId: z.string(),
  dayOfWeek: z.number().int().min(0).max(6),
  openHour: z.number().int().min(0).max(23),
  openMinute: z.number().int().min(0).max(59),
  closeHour: z.number().int().min(0).max(23),
  closeMinute: z.number().int().min(0).max(59),
  closedAllDay: z.boolean(),
})
export type AgentAvailabilityDTO = z.infer<typeof AgentAvailabilityDTO>

export const SetAgentAvailabilityInput = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openHour: z.number().int().min(0).max(23),
  openMinute: z.number().int().min(0).max(59).default(0),
  closeHour: z.number().int().min(0).max(23),
  closeMinute: z.number().int().min(0).max(59).default(0),
  closedAllDay: z.boolean().default(false),
})
export type SetAgentAvailabilityInput = z.infer<
  typeof SetAgentAvailabilityInput
>

export const ReplaceAgentAvailabilityInput = z.object({
  schedule: z.array(SetAgentAvailabilityInput).max(7),
})
export type ReplaceAgentAvailabilityInput = z.infer<
  typeof ReplaceAgentAvailabilityInput
>
