import { z } from 'zod'

export const LabelColor = z
  .string()
  .regex(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i, 'must be #rgb or #rrggbb')
export type LabelColor = z.infer<typeof LabelColor>

export const CreateLabelInput = z.object({
  title: z.string().min(1).max(60),
  color: LabelColor,
})
export type CreateLabelInput = z.infer<typeof CreateLabelInput>

export const UpdateLabelInput = z.object({
  title: z.string().min(1).max(60).optional(),
  color: LabelColor.optional(),
})
export type UpdateLabelInput = z.infer<typeof UpdateLabelInput>

export const LabelDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  title: z.string(),
  color: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type LabelDTO = z.infer<typeof LabelDTO>

/** Light shape used on conversation rows / sidebar. */
export const ConversationLabelRefDTO = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string(),
})
export type ConversationLabelRefDTO = z.infer<typeof ConversationLabelRefDTO>
