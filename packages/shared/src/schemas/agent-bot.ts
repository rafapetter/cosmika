import { z } from 'zod'

export const AgentBotModel = z.enum([
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  // OpenAI. Tied or beat claude-sonnet-5 on our support eval (2026-09-10)
  // at about a twentieth of the cost per conversation.
  'gpt-5.6-luna',
  // OpenRouter, plan B. Tied luna on the same eval; needs OPENROUTER_API_KEY.
  'deepseek/deepseek-v4.1-flash',
])
export type AgentBotModel = z.infer<typeof AgentBotModel>

/**
 * Built-in tools an agent can be given, matching `AiTools.all()` on the API.
 * Shared so the admin UI can offer them without hardcoding a second list that
 * drifts from the executable one.
 */
export const BUILT_IN_AGENT_TOOLS = [
  'search_knowledge_base',
  'read_knowledge_base_article',
  'attach_tag',
  'set_priority',
  'add_internal_note',
  'assign_conversation_to_human',
] as const

export const AgentBotToolRef = z.object({
  name: z.string().min(1),
  config: z.record(z.unknown()).optional(),
})
export type AgentBotToolRef = z.infer<typeof AgentBotToolRef>

const baseBotFields = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  systemPrompt: z.string().min(1).max(20000),
  model: AgentBotModel.optional(),
  temperature: z.number().min(0).max(1).optional(),
  toolsEnabled: z.array(AgentBotToolRef).max(20).optional(),
  customTools: z.array(z.record(z.unknown())).max(20).optional(),
  fallbackToHuman: z.boolean().optional(),
  autoSafeConfidenceThreshold: z.number().int().min(0).max(100).optional(),
  dailyBudgetUsd: z.number().min(0).max(1000).optional(),
  // The agent's own knowledge base: articles tagged with any of these.
  // Empty = the whole account base.
  knowledgeTags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  isActive: z.boolean().optional(),
})

export const CreateAgentBotInput = baseBotFields
export type CreateAgentBotInput = z.infer<typeof CreateAgentBotInput>

export const UpdateAgentBotInput = baseBotFields.partial()
export type UpdateAgentBotInput = z.infer<typeof UpdateAgentBotInput>

export const AgentBotDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  systemPrompt: z.string(),
  model: z.string(),
  temperature: z.number(),
  toolsEnabled: z.array(AgentBotToolRef),
  customTools: z.array(z.record(z.unknown())),
  fallbackToHuman: z.boolean(),
  autoSafeConfidenceThreshold: z.number().int(),
  dailyBudgetUsd: z.number(),
  knowledgeTags: z.array(z.string()),
  // Published articles this agent can answer from (its base).
  knowledgeArticleCount: z.number().int(),
  isActive: z.boolean(),
  costLast24hUsd: z.number(),
  inboxCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentBotDTO = z.infer<typeof AgentBotDTO>

// Tool call (mirrors AgentToolCall in prisma)

export const ToolCallStatus = z.enum([
  'PENDING',
  'SUCCESS',
  'ERROR',
  'CONFIRMED',
  'REJECTED',
])
export type ToolCallStatus = z.infer<typeof ToolCallStatus>

export const AgentToolCallDTO = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).nullable(),
  errorMessage: z.string().nullable(),
  status: ToolCallStatus,
  costUsd: z.number(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
})
export type AgentToolCallDTO = z.infer<typeof AgentToolCallDTO>

export const AiAgentSessionDTO = z.object({
  id: z.string(),
  conversationId: z.string(),
  // Null when the spend came from a flow's AI block or the deviation
  // classifier, which run with no agent bot attached to the inbox.
  agentBotId: z.string().nullable(),
  totalTokensIn: z.number().int(),
  totalTokensOut: z.number().int(),
  totalCostUsd: z.number(),
  lastActiveAt: z.string(),
  createdAt: z.string(),
})
export type AiAgentSessionDTO = z.infer<typeof AiAgentSessionDTO>

export const ConfirmToolCallsInput = z.object({
  toolCallIds: z.array(z.string().min(1)).min(1).max(10),
  decision: z.enum(['CONFIRM', 'REJECT']).default('CONFIRM'),
})
export type ConfirmToolCallsInput = z.infer<typeof ConfirmToolCallsInput>
