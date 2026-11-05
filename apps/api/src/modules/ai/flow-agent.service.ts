import { Injectable } from '@nestjs/common'
import type { AgentBot } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { formatTranscript } from '../../common/transcript'
import { AiUsageService } from '../usage/ai-usage.service'

import { AiTools, type ToolDef } from './ai-tools'
import { AnthropicClient, type ToolDefinition, type TurnMessage } from './anthropic-client'
import type { UsageBreakdown } from './anthropic-pricing'

// ─── The AI agent of a flow's "AI agent" block ─────────────────────────
//
// The inbox agent (OrchestratorService) owns a conversation for its whole
// life, keeps its own session history and may queue actions for approval.
// This one is narrower on purpose: a flow hands it the conversation for a
// bounded stretch (the block's `maxAiTurns`), it speaks as ONE of the
// account's agents with that agent's persona and knowledge base, and when it
// is done the flow, not the model, decides what happens next. So it reads its
// dialogue straight from the thread, uses only the knowledge tools, and
// reports a wish to transfer instead of transferring.

/** The tool the agent calls to ask for a person; the flow does the rest. */
export const TRANSFER_TOOL = 'transfer_to_human'

// Generous for a chat answer, and bounded: a turn is paid for per round.
const MAX_TOOL_ROUNDS = 4
// Dialogue messages the model reads, and context from before it joined.
const DIALOGUE_MESSAGES = 40
const CONTEXT_MESSAGES = 10

const LANGUAGES: Record<string, string> = {
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  en: 'English',
}

const OPENING =
  '(The flow has just handed this conversation to you. Greet the customer in ' +
  'character, in one or two short sentences, and ask how you can help.)'
const ROUTED = '(The flow routed the customer to you.)'
// A message with no text (an attachment, a sticker) still needs a user turn:
// the API rejects an empty text block.
const NO_TEXT = '(The customer sent a message with no text, such as an attachment.)'
// Appended when the tool rounds ran out with nothing said to the customer.
const ANSWER_NOW =
  'Reply to the customer now, in text, with what you have. Do not call any more tools.'

// The flow agent reads; it never writes to the conversation. Tagging,
// priority and notes stay with the inbox agent, whose actions a person sees.
const KNOWLEDGE_TOOLS = ['search_knowledge_base', 'read_knowledge_base_article']

export type FlowAgentTurnInput = {
  accountId: string
  conversationId: string
  contactId: string
  agentBotId: string
  // ISO instant the block took the conversation.
  since: string
  // null on the opening turn.
  userText: string | null
  instructions: string
  offTopic: 'refuse' | 'handoff'
  locale: string
}

export type FlowAgentTurn =
  | {
      kind: 'reply'
      text: string
      handoff: boolean
      botId: string
      model: string
      usage: UsageBreakdown
    }
  // The agent cannot run: gone (or another account's), no AI client for its
  // model, or its own daily budget is spent.
  | { kind: 'unavailable'; reason: 'missing' | 'no_client' | 'daily_budget'; botName: string }

@Injectable()
export class FlowAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClient,
    private readonly tools: AiTools,
    private readonly aiUsage: AiUsageService,
  ) {}

  async runTurn(input: FlowAgentTurnInput): Promise<FlowAgentTurn> {
    // Scoped to the account: a flow can only call its own agents.
    const bot = await this.prisma.agentBot.findFirst({
      where: { id: input.agentBotId, accountId: input.accountId },
    })
    if (!bot || !bot.isActive) return { kind: 'unavailable', reason: 'missing', botName: '' }
    if (!this.anthropic.isAvailable(bot.model)) {
      return { kind: 'unavailable', reason: 'no_client', botName: bot.name }
    }
    // From the ledger, by agent: see AiUsageService.botCostLast24h for why
    // the session aggregate cannot see what a flow's agent spent.
    if ((await this.aiUsage.botCostLast24h(bot.id)) >= Number(bot.dailyBudgetUsd)) {
      return { kind: 'unavailable', reason: 'daily_budget', botName: bot.name }
    }

    const since = new Date(input.since)
    const pool = this.toolPool(bot)
    const toolDefs: ToolDefinition[] = [
      ...pool.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      {
        name: TRANSFER_TOOL,
        description:
          'Hand the conversation to a human agent. Call it when the customer asks for a person, ' +
          'or when you cannot help them. Tell the customer, in the same reply, that a person will continue.',
        input_schema: { type: 'object', properties: {} },
      },
    ]
    const systemPrompt = buildFlowAgentPrompt({
      persona: bot.systemPrompt,
      hasKnowledgeBase: pool.some((t) => t.name === 'search_knowledge_base'),
      offTopic: input.offTopic,
      instructions: input.instructions,
      locale: input.locale,
      context: await this.contextBefore(input.conversationId, since, input.locale),
    })
    const messages = await this.dialogue(input.conversationId, since, input.userText)

    let usage: UsageBreakdown = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const parts: string[] = []
    let handoff = false
    const ctx = {
      accountId: input.accountId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      knowledgeTags: bot.knowledgeTags,
    }
    const ask = async () => {
      const res = await this.anthropic.createMessage({
        model: bot.model,
        systemPrompt,
        tools: toolDefs,
        messages,
        temperature: bot.temperature,
        maxTokens: 1024,
      })
      usage = addUsage(usage, res.usage)
      const text = res.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text && text !== parts[parts.length - 1]) parts.push(text)
      return res
    }
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const res = await ask()
      const calls = res.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      )
      if (res.stop_reason !== 'tool_use' || calls.length === 0) break
      messages.push({ role: 'assistant', content: res.content })
      const results: TurnMessage['content'] = []
      for (const call of calls) {
        if (call.name === TRANSFER_TOOL) {
          handoff = true
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'Transfer scheduled: a person takes over right after your reply.',
          })
          continue
        }
        results.push(await this.runTool(pool, call, ctx))
      }
      messages.push({ role: 'user', content: results })
    }
    if (parts.length === 0) {
      // Still nothing for the customer (tool rounds ran out, or an empty
      // answer): one more round that asks for text. The tools stay declared,
      // since the API refuses a history with tool calls and no tools.
      const last = messages[messages.length - 1]!
      last.content = [...last.content, { type: 'text', text: ANSWER_NOW }]
      await ask()
    }
    // A turn that still says nothing goes to a person: the customer must not
    // be left on silence while the turn counts against the limit.
    if (parts.length === 0) handoff = true
    return { kind: 'reply', text: parts.join('\n\n'), handoff, botId: bot.id, model: bot.model, usage }
  }

  /**
   * The knowledge tools the bot has enabled (both when it lists none, like
   * the inbox agent). Nothing that writes: no tags, priority or notes, no
   * transfer of its own (the flow owns it, through TRANSFER_TOOL), no custom
   * webhooks. A flow stretch has nobody watching or approving.
   */
  private toolPool(bot: AgentBot): ToolDef[] {
    const listed = Array.isArray(bot.toolsEnabled)
      ? (bot.toolsEnabled as Array<{ name?: unknown }>).map((t) => t?.name)
      : []
    return this.tools
      .all()
      .filter((t) => KNOWLEDGE_TOOLS.includes(t.name))
      .filter((t) => listed.length === 0 || listed.includes(t.name))
  }

  private async runTool(
    pool: ToolDef[],
    call: { id: string; name: string; input: Record<string, unknown> },
    ctx: { accountId: string; conversationId: string; contactId: string; knowledgeTags: string[] },
  ): Promise<TurnMessage['content'][number]> {
    const def = pool.find((t) => t.name === call.name)
    if (!def) {
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Error: tool ${call.name} is not available.`,
        is_error: true,
      }
    }
    try {
      const result = await def.handler(call.input, ctx, { prisma: this.prisma })
      return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result.output) }
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      }
    }
  }

  /**
   * The agent's dialogue: public messages since the block took over, as
   * alternating turns. The customer's newest message is already in the thread
   * when this runs; `userText` only fills in if it is not.
   */
  private async dialogue(conversationId: string, since: Date, userText: string | null): Promise<TurnMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        isPrivate: false,
        senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: DIALOGUE_MESSAGES,
      select: { senderType: true, content: true },
    })
    const turns: TurnMessage[] = []
    for (const row of rows.reverse()) {
      const text = (row.content ?? '').trim()
      if (!text) continue
      const role = row.senderType === 'CONTACT' ? 'user' : 'assistant'
      const last = turns[turns.length - 1]
      if (last?.role === role) {
        const block = last.content[0] as { type: 'text'; text: string }
        block.text = `${block.text}\n\n${text}`
      } else {
        turns.push({ role, content: [{ type: 'text', text }] })
      }
    }
    // The API wants the user first and last.
    if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: [{ type: 'text', text: ROUTED }] })
    if (turns.length === 0 || turns[turns.length - 1]!.role === 'assistant') {
      const text = userText === null ? OPENING : userText.trim() || NO_TEXT
      turns.push({ role: 'user', content: [{ type: 'text', text }] })
    }
    return turns
  }

  /** What was said before the agent joined, so it knows why it was called. */
  private async contextBefore(conversationId: string, since: Date, locale: string): Promise<string> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        isPrivate: false,
        senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] },
        createdAt: { lt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: CONTEXT_MESSAGES,
      select: { senderType: true, content: true },
    })
    return formatTranscript(rows.reverse(), locale)
  }
}

/**
 * The agent's persona, then the rules of a flow stretch. Scope is enforced
 * here, by the prompt: the author chooses whether an off-topic question is
 * declined (and the agent says what it CAN do) or sent to a person.
 */
export function buildFlowAgentPrompt(opts: {
  persona: string
  hasKnowledgeBase: boolean
  offTopic: 'refuse' | 'handoff'
  instructions: string
  locale: string
  context: string
}): string {
  const language = LANGUAGES[opts.locale] ?? LANGUAGES['pt-BR']!
  const rules = [
    'An automated flow handed this customer to you; you are the one replying now. This is a chat: keep replies short.',
    `Reply in ${language}, unless the customer writes in another language.`,
    'Stay strictly within the role and subject described above.',
    opts.hasKnowledgeBase
      ? 'Ground factual answers in your knowledge base (search_knowledge_base, then read_knowledge_base_article). ' +
        'If it has nothing relevant, say you do not have that information here instead of guessing.'
      : 'Never invent policies, prices, dates or procedures you were not given.',
    opts.offTopic === 'handoff'
      ? `If the customer asks about anything outside your subject, do not answer it: say briefly that a person will help with that, and call ${TRANSFER_TOOL}.`
      : 'If the customer asks about anything outside your subject, do not answer it: say politely that you can only help with your subject here, and say what you can help with.',
    `If the customer asks for a person, call ${TRANSFER_TOOL} and tell them briefly that someone will continue.`,
  ]
  const sections = [opts.persona.trim(), `# How this conversation works\n${rules.map((r) => `- ${r}`).join('\n')}`]
  if (opts.instructions.trim()) sections.push(`# Instructions for this step of the flow\n${opts.instructions.trim()}`)
  if (opts.context) sections.push(`# Conversation before you joined (oldest first)\n${opts.context}`)
  return sections.join('\n\n')
}

function addUsage(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}
