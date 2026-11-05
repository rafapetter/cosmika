import { z } from 'zod'

export const CannedResponseShortcode = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_-]+$/i, 'letters, digits, dashes or underscores only')
export type CannedResponseShortcode = z.infer<typeof CannedResponseShortcode>

export const CreateCannedResponseInput = z.object({
  shortcode: CannedResponseShortcode,
  content: z.string().min(1).max(5000),
})
export type CreateCannedResponseInput = z.infer<typeof CreateCannedResponseInput>

export const UpdateCannedResponseInput = z.object({
  shortcode: CannedResponseShortcode.optional(),
  content: z.string().min(1).max(5000).optional(),
})
export type UpdateCannedResponseInput = z.infer<typeof UpdateCannedResponseInput>

export const CannedResponseDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  shortcode: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CannedResponseDTO = z.infer<typeof CannedResponseDTO>
