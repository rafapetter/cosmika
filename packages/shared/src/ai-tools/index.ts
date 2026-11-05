// AI tool schemas (Zod) shared between the orchestrator (apps/api) and any
// runtime that needs to validate tool calls. The catalog is intentionally
// small at P0 — extend per module as we ship.

import { z } from 'zod'

export const ToolName = z.enum([
  'assign_conversation',
  'change_conversation_status',
  'send_message',
  'search_knowledge',
  'tag_conversation',
])
export type ToolName = z.infer<typeof ToolName>

export const AssignConversationArgs = z.object({
  conversationId: z.string(),
  assigneeId: z.string().nullable(),
})

export const ChangeConversationStatusArgs = z.object({
  conversationId: z.string(),
  status: z.enum(['OPEN', 'RESOLVED', 'PENDING']),
})

export const SendMessageArgs = z.object({
  conversationId: z.string(),
  content: z.string().min(1),
  isPrivate: z.boolean().default(false),
})

export const SearchKnowledgeArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
})

export const TagConversationArgs = z.object({
  conversationId: z.string(),
  tags: z.array(z.string()).min(1),
})

export const toolSchemas = {
  assign_conversation: AssignConversationArgs,
  change_conversation_status: ChangeConversationStatusArgs,
  send_message: SendMessageArgs,
  search_knowledge: SearchKnowledgeArgs,
  tag_conversation: TagConversationArgs,
} as const
