import { z } from 'zod'

export const WebhookEvent = z.enum([
  'conversation.created',
  'conversation.resolved',
  'conversation.reopened',
  'message.created',
  'contact.created',
  'conversation.sla_breached',
])
export type WebhookEvent = z.infer<typeof WebhookEvent>

export const WebhookDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(WebhookEvent),
  isActive: z.boolean(),
  createdAt: z.string(),
})
export type WebhookDTO = z.infer<typeof WebhookDTO>

export const WebhookWithSecret = WebhookDTO.extend({
  secret: z.string(),
})
export type WebhookWithSecret = z.infer<typeof WebhookWithSecret>

export const CreateWebhookInput = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  events: z.array(WebhookEvent).min(1),
})
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>

export const UpdateWebhookInput = z.object({
  name: z.string().min(1).max(120).optional(),
  url: z.string().url().optional(),
  events: z.array(WebhookEvent).min(1).optional(),
  isActive: z.boolean().optional(),
})
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>

export const WebhookDeliveryDTO = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: z.string(),
  status: z.string(),
  responseStatus: z.number().nullable(),
  errorMessage: z.string().nullable(),
  attempts: z.number(),
  createdAt: z.string(),
})
export type WebhookDeliveryDTO = z.infer<typeof WebhookDeliveryDTO>
