import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
// eslint-disable-next-line import/no-named-as-default
import Anthropic from '@anthropic-ai/sdk'

import { UsageBreakdown } from './anthropic-pricing'
import {
  OPENROUTER_PRIVACY,
  createOpenAiMessage,
  isOpenAiModel,
  isOpenRouterModel,
} from './openai-chat'

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type TurnMessage = {
  role: 'user' | 'assistant'
  content: Array<
    | { type: 'text'; text: string }
    // Vision: base64 media the caller attached to a user turn. Anthropic
    // takes images and PDFs; both use the same source shape.
    | {
        type: 'image' | 'document'
        source: { type: 'base64'; media_type: string; data: string }
      }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | {
        type: 'tool_result'
        tool_use_id: string
        content: string | Array<{ type: 'text'; text: string }>
        is_error?: boolean
      }
  >
}

/**
 * Mark the end of the conversation as a cache breakpoint.
 *
 * Both agents resend the whole history on every tool round, and the system
 * breakpoint alone only covers the instructions and tool list. With this one
 * the next round reads everything up to here from the cache at about a tenth
 * of the input price, instead of paying for it again. Two breakpoints of the
 * four the API allows.
 *
 * Copies rather than mutating: callers persist these message objects, and a
 * cache marker must never end up in stored history.
 */
export function withHistoryBreakpoint(messages: TurnMessage[]): TurnMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.content.length === 0) return messages
  const blocks = last.content.map((b, i) =>
    i === last.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b,
  ) as TurnMessage['content']
  return [...messages.slice(0, -1), { ...last, content: blocks }]
}

export type DeviationAction = 'answer' | 'fill' | 'exit' | 'handoff'

/** The language the off-script reply must be written in, by account locale. */
const DEVIATION_LANGUAGE: Record<string, string> = {
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  en: 'English',
}
export type DeviationDecision = {
  action: DeviationAction
  reply: string
  value: string | null
  /**
   * The model called and what it cost in tokens, so the caller can bill the
   * account's AI budget for it. This classifier runs on every off-script
   * message of a GUIDED inbox and used to report nothing at all, which is how
   * a flow could spend past a cap the orchestrator believed was untouched.
   * Zero usage in stub mode and whenever no call was made.
   */
  model: string
  usage: UsageBreakdown
}

/** No tokens spent: stub mode, or a path that never reached the API. */
export const NO_USAGE: UsageBreakdown = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export type ClaudeResponse = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn'
  usage: UsageBreakdown
}

/**
 * Newer models dropped the sampling knobs: sending `temperature` is a 400 on
 * the whole request, not a warning. Covers Opus 4.7 and everything in the
 * Claude 5 family (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, and
 * their dated aliases). Haiku 4.5 still accepts it.
 */
export function modelRejectsTemperature(model: string): boolean {
  return model === 'claude-opus-4-7' || /^claude-[a-z]+-5(-|$)/.test(model)
}

@Injectable()
export class AnthropicClient {
  private readonly logger = new Logger(AnthropicClient.name)
  private readonly stub: boolean
  private readonly real: Anthropic | null
  // GPT models go to OpenAI Chat Completions with the key the knowledge-base
  // embeddings already use (and its gateway base URL, when set).
  private readonly openai: { apiKey: string; baseUrl: string } | null
  // `vendor/model` ids go to OpenRouter, the standby route for non-Claude,
  // non-OpenAI models.
  private readonly openrouter: { apiKey: string; baseUrl: string } | null

  constructor(private readonly config: ConfigService) {
    this.stub = config.get<string>('COSMIKA_AI_STUB') === '1'
    const openaiKey = config.get<string>('OPENAI_API_KEY')?.trim()
    this.openai = openaiKey
      ? {
          apiKey: openaiKey,
          baseUrl: config.get<string>('OPENAI_BASE_URL')?.trim() || 'https://api.openai.com/v1',
        }
      : null
    const openrouterKey = config.get<string>('OPENROUTER_API_KEY')?.trim()
    this.openrouter = openrouterKey
      ? {
          apiKey: openrouterKey,
          baseUrl:
            config.get<string>('OPENROUTER_BASE_URL')?.trim() || 'https://openrouter.ai/api/v1',
        }
      : null
    if (this.stub) {
      this.logger.warn(
        'COSMIKA_AI_STUB=1 — using deterministic stub for Anthropic calls',
      )
      this.real = null
    } else {
      const key = config.get<string>('ANTHROPIC_API_KEY')
      if (!key) {
        this.logger.warn(
          'ANTHROPIC_API_KEY not set — AI orchestrator calls will fail',
        )
        this.real = null
      } else {
        // A gateway (LiteLLM, OpenRouter, the Resto one) is reached by base URL.
        // The SDK would read ANTHROPIC_BASE_URL itself, but only when the var is
        // absent from the env; compose passes every listed var, empty or not,
        // so an empty string would otherwise become the base URL.
        const baseURL = config.get<string>('ANTHROPIC_BASE_URL')?.trim()
        this.real = new Anthropic({
          apiKey: key,
          ...(baseURL ? { baseURL } : {}),
        })
      }
    }
  }

  get isStub(): boolean {
    return this.stub
  }

  /** Whether a call can be made at all, or for `model` when one is given. */
  isAvailable(model?: string): boolean {
    if (this.stub) return true
    if (model && isOpenAiModel(model)) return this.openai !== null
    if (model && isOpenRouterModel(model)) return this.openrouter !== null
    return this.real !== null
  }

  async createMessage(opts: {
    model: string
    systemPrompt: string
    tools: ToolDefinition[]
    messages: TurnMessage[]
    temperature?: number
    maxTokens?: number
  }): Promise<ClaudeResponse> {
    if (this.stub) {
      return this.stubResponse(opts)
    }
    if (isOpenAiModel(opts.model)) {
      if (!this.openai) {
        throw new Error(`OpenAI client not configured for ${opts.model}. Set OPENAI_API_KEY.`)
      }
      // Sampling knobs are left out: the GPT-5 family rejects them.
      return createOpenAiMessage(this.openai, opts)
    }
    if (isOpenRouterModel(opts.model)) {
      if (!this.openrouter) {
        throw new Error(`OpenRouter client not configured for ${opts.model}. Set OPENROUTER_API_KEY.`)
      }
      return createOpenAiMessage(
        { ...this.openrouter, extraBody: { provider: OPENROUTER_PRIVACY } },
        opts,
      )
    }
    if (!this.real) {
      throw new Error(
        'Anthropic client not configured. Set ANTHROPIC_API_KEY or COSMIKA_AI_STUB=1.',
      )
    }
    const rejectsTemperature = modelRejectsTemperature(opts.model)
    const params: Anthropic.MessageCreateParams = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      // Cache the system prompt + tools (tools render before system; marker on
      // the last system block caches both). cache_control may not be typed on
      // the installed SDK version — cast through unknown.
      system: [
        {
          type: 'text',
          text: opts.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ] as unknown as Anthropic.MessageCreateParams['system'],
      tools:
        opts.tools.length > 0
          ? (opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })) as unknown as Anthropic.MessageCreateParams['tools'])
          : undefined,
      messages: withHistoryBreakpoint(opts.messages) as unknown as Anthropic.MessageParam[],
    }
    // Only send temperature on models that still accept it, and only when
    // explicitly set — the others reject the whole request.
    if (!rejectsTemperature && opts.temperature !== undefined) {
      params.temperature = opts.temperature
    }

    const res = (await this.real.messages.create(params)) as Anthropic.Message
    return {
      content: res.content
        .filter((b) => b.type === 'text' || b.type === 'tool_use')
        .map((b) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          return {
            type: 'tool_use' as const,
            id: b.id,
            name: b.name,
            input: (b.input ?? {}) as Record<string, unknown>,
          }
        }),
      stop_reason: (res.stop_reason ?? 'end_turn') as ClaudeResponse['stop_reason'],
      usage: {
        inputTokens: res.usage.input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
        cacheReadTokens:
          (res.usage as { cache_read_input_tokens?: number })
            .cache_read_input_tokens ?? 0,
        cacheWriteTokens:
          (res.usage as { cache_creation_input_tokens?: number })
            .cache_creation_input_tokens ?? 0,
      },
    }
  }


  /**
   * Decide how to handle a customer message that deviated from a scripted
   * flow's current step. Returns one of the `allowedActions` plus a reply (and,
   * for `fill`, the extracted answer). Stub mode is deterministic: it prefers
   * `answer` when allowed, else the first allowed action.
   */
  async classifyDeviation(input: {
    stepIntent: string
    userText: string
    allowedActions: DeviationAction[]
    /**
     * The last messages of the conversation, oldest first, one per line
     * ("Cliente: ...", "Bot: ...", "Atendente: ..."). Without them the model
     * sees one sentence in isolation: conversation 8741 (2026-10-13) answered
     * "Precisamos resolver" with "você tem um número de pedido ou
     * referência?", a generic help-desk script that had nothing to do with
     * the customer's stopped WhatsApp bot two messages earlier.
     */
    transcript?: string
    /** Who the bot speaks for, so it never sounds like a generic help desk. */
    businessName?: string
    /** Account language; the reply goes straight to the contact. */
    locale?: string
  }): Promise<DeviationDecision> {
    const allowed = input.allowedActions
    const fallbackAction: DeviationAction =
      allowed.length > 0 ? allowed[0]! : 'answer'
    const model = 'claude-haiku-4-5'
    if (this.stub) {
      const action: DeviationAction = allowed.includes('answer')
        ? 'answer'
        : fallbackAction
      return {
        action,
        reply: `[stub] ${input.userText}`,
        value: null,
        model,
        usage: NO_USAGE,
      }
    }
    const business = input.businessName?.trim() || 'the company'
    const language = DEVIATION_LANGUAGE[input.locale ?? 'pt-BR'] ?? DEVIATION_LANGUAGE['pt-BR']
    const context = input.transcript?.trim()
      ? `Conversation so far (oldest first):\n${input.transcript.trim()}\n\n`
      : ''
    const res = await this.createMessage({
      model,
      systemPrompt:
        `You are the WhatsApp assistant of ${business}, guiding a customer ` +
        `through a scripted flow. The current step is: ${input.stepIntent}. ` +
        'The customer said something that does not fit that step. Choose ONE ' +
        `action from the allowed list [${allowed.join(', ')}] and write a short reply.\n` +
        '- answer: address their message; we will re-ask the step.\n' +
        '- fill: their message contains the step answer — put it in "value".\n' +
        '- exit: they clearly want to leave the scripted flow.\n' +
        '- handoff: they ask for a person, or report a problem the scripted ' +
        'step cannot solve (something broken, stopped, urgent, a complaint).\n' +
        'Rules for the reply:\n' +
        `- Write it in ${language}, at most two short sentences.\n` +
        '- Read the conversation so far: never ask for something the customer ' +
        'already said, and never treat a returning customer as a new visitor.\n' +
        `- Only talk about ${business} and this conversation. Never invent a ` +
        'process the flow does not have (order numbers, protocols, tickets).\n' +
        '- Never say you will transfer, connect or pass them to someone unless ' +
        'the action is handoff. If handoff is not in the allowed list, do not ' +
        'promise it.\n' +
        'Reply with ONLY a JSON object: ' +
        '{"action":"...","reply":"...","value":"<answer or null>"}.',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${context}Customer's latest message: ${input.userText}`,
            },
          ],
        },
      ],
      maxTokens: 1024,
    })
    const first = res.content.find((b) => b.type === 'text')
    const raw = first?.type === 'text' ? first.text : ''
    const parsed = safeParseObject(raw)
    const candidate = parsed?.action
    const action: DeviationAction =
      typeof candidate === 'string' && allowed.includes(candidate as DeviationAction)
        ? (candidate as DeviationAction)
        : fallbackAction
    const reply = typeof parsed?.reply === 'string' && parsed.reply ? parsed.reply : raw
    const value =
      typeof parsed?.value === 'string' && parsed.value.length > 0
        ? parsed.value
        : null
    return { action, reply, value, model, usage: res.usage }
  }

  /**
   * Deterministic stub for tests. Reads marker strings from the latest user
   * message to choose a response:
   *   - "STUB_USE_TOOL"     → tool_use attach_tag with tag="stubbed"
   *   - "STUB_ASSIGN_HUMAN" → tool_use assign_conversation_to_human
   *   - "STUB_CALL_TOOL:<name>" → tool_use <name> with input { source: "stub" }
   *     (the only way to reach a bot's custom tools, which have no fixed name)
   *   - "STUB_BIG_RESPONSE" → 1M output tokens (for budget cap tests)
   * After a tool_result is fed back, the next call returns a plain text reply.
   */
  private stubResponse(opts: {
    model: string
    messages: TurnMessage[]
  }): ClaudeResponse {
    const last = opts.messages[opts.messages.length - 1]
    const flat = JSON.stringify(last?.content ?? '')

    // If the last turn was a tool_result, this is the follow-up — return final text.
    if (flat.includes('"type":"tool_result"')) {
      return {
        content: [
          { type: 'text', text: 'Done. Anything else I can help with?' },
        ],
        stop_reason: 'end_turn',
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    if (flat.includes('STUB_BIG_RESPONSE')) {
      return {
        content: [{ type: 'text', text: 'Here is a long-winded reply.' }],
        stop_reason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    if (flat.includes('STUB_USE_TOOL')) {
      return {
        content: [
          {
            type: 'tool_use',
            id: `toolu_stub_${Date.now()}`,
            name: 'attach_tag',
            input: { tag: 'stubbed' },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    if (flat.includes('STUB_ASSIGN_HUMAN')) {
      return {
        content: [
          {
            type: 'tool_use',
            id: `toolu_stub_${Date.now()}`,
            name: 'assign_conversation_to_human',
            input: { reason: 'requested human' },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    const namedTool = /STUB_CALL_TOOL:([A-Za-z0-9_-]+)/.exec(flat)
    if (namedTool) {
      return {
        content: [
          {
            type: 'tool_use',
            id: `toolu_stub_${Date.now()}`,
            name: namedTool[1]!,
            input: { source: 'stub' },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    if (flat.includes('STUB_UNCERTAIN')) {
      return {
        content: [
          {
            type: 'text',
            text: "I'm not sure about this — let me check and get back to you.",
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          inputTokens: 60,
          outputTokens: 18,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }
    }

    // Default text reply.
    return {
      content: [{ type: 'text', text: 'Thanks for reaching out — happy to help.' }],
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 60,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    }
  }
}

/**
 * Best-effort parse of a JSON object from model text — tries the whole string,
 * then the first `{...}` span. Returns null if neither yields an object.
 */
function safeParseObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  const direct = tryParse(text)
  if (direct) return direct
  const match = text.match(/\{[\s\S]*\}/)
  return match ? tryParse(match[0]) : null
}
