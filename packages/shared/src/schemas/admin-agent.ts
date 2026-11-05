import { z } from 'zod'

/**
 * What the model can be shown. Anthropic accepts images and PDFs; anything
 * else would be silently ignored, so it is rejected at the edge instead.
 */
export const ADMIN_AGENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const

/** Per-file cap on the base64 payload (~3.7MB of original bytes). */
export const ADMIN_AGENT_MAX_ATTACHMENT_B64 = 5_000_000
export const ADMIN_AGENT_MAX_ATTACHMENTS = 5

export const AdminAgentAttachment = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.enum(ADMIN_AGENT_MEDIA_TYPES),
  /** Base64, without the `data:` prefix. */
  data: z.string().min(1).max(ADMIN_AGENT_MAX_ATTACHMENT_B64),
})
export type AdminAgentAttachment = z.infer<typeof AdminAgentAttachment>

export const AdminAgentSendInput = z.object({
  /** Omit to start a new session. */
  sessionId: z.string().optional(),
  // An attachment alone is a valid turn ("what is this?"), so the message may
  // be empty when something is attached — checked in the service.
  message: z.string().max(8000),
  attachments: z.array(AdminAgentAttachment).max(ADMIN_AGENT_MAX_ATTACHMENTS).optional(),
})
export type AdminAgentSendInput = z.infer<typeof AdminAgentSendInput>

export const AdminAgentDecideInput = z.object({
  decisions: z
    .array(z.object({ id: z.string().min(1), approve: z.boolean() }))
    .min(1)
    .max(20),
})
export type AdminAgentDecideInput = z.infer<typeof AdminAgentDecideInput>

export const AdminAgentPendingCall = z.object({
  id: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
})
export type AdminAgentPendingCall = z.infer<typeof AdminAgentPendingCall>

export const AdminAgentExecutedCall = z.object({
  toolName: z.string(),
  critical: z.boolean(),
  durationMs: z.number().optional(),
  /** Omitted when the payload was too large to be worth sending. */
  output: z.unknown().optional(),
})
export type AdminAgentExecutedCall = z.infer<typeof AdminAgentExecutedCall>

export const AdminAgentTurnDTO = z.object({
  sessionId: z.string(),
  reply: z.string(),
  /** Non-empty only when the account requires approval for critical tools. */
  pending: z.array(AdminAgentPendingCall),
  executed: z.array(AdminAgentExecutedCall),
})
export type AdminAgentTurnDTO = z.infer<typeof AdminAgentTurnDTO>

export const AdminAgentSessionDTO = z.object({
  id: z.string(),
  title: z.string().nullable(),
  lastActiveAt: z.string(),
  createdAt: z.string(),
  totalCostUsd: z.number(),
})
export type AdminAgentSessionDTO = z.infer<typeof AdminAgentSessionDTO>

export const AdminAgentToolCallDTO = z.object({
  id: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  status: z.string(),
  critical: z.boolean(),
  createdAt: z.string(),
})
export type AdminAgentToolCallDTO = z.infer<typeof AdminAgentToolCallDTO>

export const AdminAgentSessionDetailDTO = z.object({
  id: z.string(),
  title: z.string().nullable(),
  totalCostUsd: z.number(),
  transcript: z.array(
    z.object({ role: z.enum(['user', 'assistant']), text: z.string() }),
  ),
  toolCalls: z.array(AdminAgentToolCallDTO),
})
export type AdminAgentSessionDetailDTO = z.infer<typeof AdminAgentSessionDetailDTO>

export const AdminAgentDecisionDTO = z.object({
  id: z.string(),
  toolName: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
})
export type AdminAgentDecisionDTO = z.infer<typeof AdminAgentDecisionDTO>
