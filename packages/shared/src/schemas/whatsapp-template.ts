import { z } from 'zod'

// Meta template categories + review states, mirrored from the Graph API.
export const WhatsappTemplateCategory = z.enum([
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
])
export type WhatsappTemplateCategory = z.infer<typeof WhatsappTemplateCategory>

export const WhatsappTemplateStatus = z.enum([
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
])
export type WhatsappTemplateStatus = z.infer<typeof WhatsappTemplateStatus>

export const WhatsappTemplateDTO = z.object({
  id: z.string(),
  inboxId: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  body: z.string(),
  variableCount: z.number().int(),
  syncedAt: z.string(),
})
export type WhatsappTemplateDTO = z.infer<typeof WhatsappTemplateDTO>

// Send a template into a conversation. `variables` fills the body's {{1}}..{{n}}
// placeholders in order; its length must equal the template's variableCount.
export const SendTemplateMessageInput = z.object({
  templateId: z.string().min(1),
  variables: z.array(z.string()).max(20).default([]),
})
export type SendTemplateMessageInput = z.infer<typeof SendTemplateMessageInput>
