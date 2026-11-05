// OpenAI Chat Completions behind the same contract as AnthropicClient. Also
// serves OpenRouter, which speaks the same API for every model it resells.
//
// Agents store history in Anthropic's shape (content blocks, tool_use /
// tool_result pairs). This file translates that history to an OpenAI request
// and the reply back, so the orchestrator never learns which provider ran.
import type { UsageBreakdown } from './anthropic-pricing'
import type { ClaudeResponse, ToolDefinition, TurnMessage } from './anthropic-client'

/** Models served by OpenAI rather than Anthropic. */
export function isOpenAiModel(model: string): boolean {
  return /^gpt-/.test(model)
}

/**
 * Models reached through OpenRouter: its ids are `vendor/model`
 * (`deepseek/deepseek-v4.1-flash`). Kept ready as plan B for when one of
 * them beats the current default on cost for the same quality.
 */
export function isOpenRouterModel(model: string): boolean {
  return /^[a-z0-9-]+\/[a-z0-9.:-]+$/i.test(model)
}

/**
 * Sent with every OpenRouter call: only endpoints that keep no copy of the
 * request and never train on it. Customer conversations pass through here,
 * so a model with no such endpoint fails loudly instead of leaking.
 */
export const OPENROUTER_PRIVACY = { data_collection: 'deny', zdr: true } as const

/**
 * The GPT-5.x small models only accept function tools on Chat Completions
 * with reasoning switched off; any other effort is a 400 on the whole
 * request. That is also the setting they were evaluated at.
 */
const REASONING_EFFORT: Record<string, string> = {
  'gpt-5.6-luna': 'none',
  'gpt-5.4-mini': 'none',
}

type OpenAiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

type OpenAiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAiPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

function toolResultText(content: string | Array<{ type: 'text'; text: string }>): string {
  return typeof content === 'string' ? content : content.map((c) => c.text).join('\n')
}

/**
 * Anthropic history to OpenAI messages. A user turn that carries tool results
 * becomes one `tool` message per result, placed right after the assistant
 * message that asked for them, and any text in that turn follows as a plain
 * user message.
 */
export function toOpenAiMessages(systemPrompt: string, messages: TurnMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n')
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      )
      out.push({
        role: 'assistant',
        // null is only valid next to tool calls; an empty turn stays a string.
        content: text || (calls.length > 0 ? null : ''),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      })
      continue
    }
    const parts: OpenAiPart[] = []
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) })
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text })
      } else if (b.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        })
      } else if (b.type === 'document') {
        parts.push({
          type: 'file',
          file: {
            filename: 'document.pdf',
            file_data: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        })
      }
    }
    if (parts.length === 0) continue
    const onlyText = parts.every((p) => p.type === 'text')
    out.push({
      role: 'user',
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : parts,
    })
  }
  return out
}

export function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

type OpenAiResponse = {
  choices?: Array<{
    finish_reason?: string | null
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] | null }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const STOP_REASON: Record<string, ClaudeResponse['stop_reason']> = {
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
}

/** OpenAI reply to the Anthropic-shaped response the agents consume. */
export function fromOpenAiResponse(res: OpenAiResponse): ClaudeResponse {
  const choice = res.choices?.[0]
  const message = choice?.message
  const content: ClaudeResponse['content'] = []
  const text = message?.content?.trim()
  if (text) content.push({ type: 'text', text })
  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    })
  }
  const hasCalls = content.some((b) => b.type === 'tool_use')
  const prompt = res.usage?.prompt_tokens ?? 0
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const usage: UsageBreakdown = {
    // OpenAI counts cached tokens inside prompt_tokens; ours are disjoint.
    inputTokens: prompt - cached,
    outputTokens: res.usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
  return {
    content,
    // Some models finish with "stop" while still returning calls; the loop
    // keys on tool_use, so trust the calls over the label.
    stop_reason: hasCalls ? 'tool_use' : (STOP_REASON[choice?.finish_reason ?? ''] ?? 'end_turn'),
    usage,
  }
}

export async function createOpenAiMessage(
  conn: {
    apiKey: string
    baseUrl: string
    /** Provider-specific fields merged into the body (OpenRouter routing). */
    extraBody?: Record<string, unknown>
    fetch?: typeof fetch
  },
  opts: {
    model: string
    systemPrompt: string
    tools: ToolDefinition[]
    messages: TurnMessage[]
    maxTokens?: number
  },
): Promise<ClaudeResponse> {
  const effort = REASONING_EFFORT[opts.model]
  const body = {
    model: opts.model,
    messages: toOpenAiMessages(opts.systemPrompt, opts.messages),
    max_completion_tokens: opts.maxTokens ?? 4096,
    ...(opts.tools.length > 0 ? { tools: toOpenAiTools(opts.tools) } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...conn.extraBody,
  }
  const doFetch = conn.fetch ?? fetch
  const res = await doFetch(`${conn.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${conn.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`${conn.extraBody ? 'OpenRouter' : 'OpenAI'} ${res.status}: ${detail}`)
  }
  return fromOpenAiResponse((await res.json()) as OpenAiResponse)
}
