import { z } from 'zod'

export const ForwardConversationInput = z.object({
  targetInboxId: z.string(),
  note: z.string().max(500).optional(),
  copyAssignee: z.boolean().optional(),
})
export type ForwardConversationInput = z.infer<typeof ForwardConversationInput>

export const ForwardConversationResult = z.object({
  conversationId: z.string(),
  displayId: z.number(),
})
export type ForwardConversationResult = z.infer<
  typeof ForwardConversationResult
>
