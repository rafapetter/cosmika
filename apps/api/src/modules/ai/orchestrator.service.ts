import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import type {
  AgentBot,
  AgentToolCall,
  AiAgentSession,
  Conversation,
  Prisma,
} from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { AssignmentService } from '../assignment/assignment.service'
import { RealtimeService } from '../realtime/realtime.service'
import { AiAllowanceService } from '../usage/ai-allowance.service'
import { AiUsageService } from '../usage/ai-usage.service'
import { ChannelsService } from '../channels/channels.service'
import { formatTranscript } from '../../common/transcript'

import { AgentBotsService } from './agent-bots.service'
import { AiTools, ToolDef } from './ai-tools'
import { AnthropicClient, ToolDefinition, TurnMessage } from './anthropic-client'
import { computeCostUsd } from './anthropic-pricing'

const MAX_HISTORY_TURNS = 30
const MAX_TOOL_LOOP_ITERATIONS = 6

/**
 * SYSTEM notices the agent writes into the thread. These are read by the
 * account's own agents in their own language: shipping them in English left
 * a Portuguese desk staring at "Review in the AI panel", with no clue that
 * the panel is the AI section of the conversation sidebar.
 */
export function approvalNotice(locale: string, count: number): string {
  switch (locale) {
    case 'en':
      return `🤖 The assistant requested ${count} action(s) that need approval. Review them in the AI panel, in the conversation sidebar.`
    case 'es':
      return `🤖 El asistente solicitó ${count} acción(es) que requieren aprobación. Revísalas en el panel de IA, en la barra lateral de la conversación.`
    default:
      return `🤖 O assistente pediu ${count} ação(ões) que precisam de aprovação. Revise no painel de IA, na barra lateral da conversa.`
  }
}

export function monthlyBudgetNotice(
  locale: string,
  used: number,
  cap: number,
): string {
  const money = `$${used.toFixed(2)} de $${cap.toFixed(2)}`
  switch (locale) {
    case 'en':
      return `🤖 This account's monthly AI budget is used up ($${used.toFixed(2)} of $${cap.toFixed(2)}). Handing over to a human.`
    case 'es':
      return `🤖 El presupuesto mensual de IA de esta cuenta se agotó (${money}). Pasando a un humano.`
    default:
      return `🤖 O orçamento mensal de IA desta conta acabou (${money}). Passando para um humano.`
  }
}

export function dailyBudgetNotice(locale: string, botName: string): string {
  switch (locale) {
    case 'en':
      return `🤖 Daily AI budget exceeded for "${botName}". Handing over to a human.`
    case 'es':
      return `🤖 Presupuesto diario de IA excedido para "${botName}". Pasando a un humano.`
    default:
      return `🤖 Orçamento diário de IA excedido para "${botName}". Passando para um humano.`
  }
}

/** The bot is attached but cannot run: deleted, switched off, or no client. */
export function botUnavailableNotice(locale: string): string {
  switch (locale) {
    case 'en':
      return '🤖 The AI assistant is unavailable on this inbox. Handing over to a human.'
    case 'es':
      return '🤖 El asistente de IA no está disponible en esta bandeja. Pasando a un humano.'
    default:
      return '🤖 O assistente de IA está indisponível nesta caixa de entrada. Passando para um humano.'
  }
}

/**
 * What the DESK is told when the month's AI allowance is gone.
 *
 * Two different messages are needed here, and conflating them is how a
 * customer's contact ends up reading about our billing: this one is a private
 * note for the team, `handoffMessage` below is the line the contact gets.
 */
export function allowanceNotice(locale: string, reason: string): string {
  const capped = reason === 'cap_reached'
  switch (locale) {
    case 'en':
      return capped
        ? '🤖 The monthly AI ceiling set for this account has been reached. Handing this conversation to the team.'
        : "🤖 This month's AI allowance is used up. Handing this conversation to the team."
    case 'es':
      return capped
        ? '🤖 Se alcanzó el techo mensual de IA definido para esta cuenta. Paso esta conversación al equipo.'
        : '🤖 La franquicia de IA del mes se agotó. Paso esta conversación al equipo.'
    default:
      return capped
        ? '🤖 O teto mensal de IA definido para esta conta foi atingido. Passando esta conversa para a equipe.'
        : '🤖 A franquia de IA do mês acabou. Passando esta conversa para a equipe.'
  }
}

/**
 * What the DESK is told when the bot answered nothing at all.
 *
 * Says it plainly, because the team needs to know the customer got silence
 * (and that the bot, not a person, is the reason they are seeing this).
 */
export function silentTurnNotice(locale: string): string {
  switch (locale) {
    case 'en':
      return '🤖 The bot produced no reply to this message, so the conversation was handed to the team. Worth checking the flow.'
    case 'es':
      return '🤖 El bot no respondió nada a este mensaje, así que la conversación pasó al equipo. Vale la pena revisar el flujo.'
    default:
      return '🤖 O bot não respondeu nada a esta mensagem, então a conversa passou para a equipe. Vale revisar o fluxo.'
  }
}

/**
 * What the CONTACT reads when the AI stops. Everything above is written for
 * the desk; this one goes out on WhatsApp, so it says what the person needs
 * to know (a human is coming) and nothing about budgets or bots.
 *
 * Wording matches Nebula's `conversations.templates.ai_allowance_handoff_message_body`
 * so the two products sound like one company.
 */
export function handoffMessage(locale: string): string {
  switch (locale) {
    case 'en':
      return "I'm transferring you to our team, who will reply shortly."
    case 'es':
      return 'Voy a transferir tu conversación a nuestro equipo, que te responderá en breve.'
    default:
      return 'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.'
  }
}

/** How many unseen conversation messages an agent turn reads, at most. */
const UNSEEN_MESSAGES = 15
const UNSEEN_HEADER =
  'Messages in this conversation you have not seen yet, oldest first (the ' +
  'flow, colleagues and the customer may have spoken before you were called in):'
const NEW_MESSAGE_HEADER = "The customer's new message:"

/** Stand-in result for a destructive call still waiting on a human. */
export const AWAITING_APPROVAL_RESULT =
  'Awaiting human approval; this action has not run yet.'
/** Stand-in for a `tool_use` whose result was lost (truncation, old rows). */
const UNAVAILABLE_RESULT = 'Result unavailable.'

/**
 * Enforce the Messages API invariant that every `tool_use` block is answered
 * by `tool_result` blocks in the very next message, and that no `tool_result`
 * appears without its call.
 *
 * A conversation that breaks this rule is not merely degraded: the API rejects
 * the whole request with a 400, so the bot goes silent on that conversation
 * for good. Three ways we got there — a destructive call queued for approval,
 * a truncation that cut between the call and its answer, and history persisted
 * before either was handled — all heal here, including rows already stored.
 */
export function sanitizeHistory(messages: TurnMessage[]): TurnMessage[] {
  const out: TurnMessage[] = []
  for (let i = 0; i < messages.length; i += 1) {
    // `noUncheckedIndexedAccess` types every index read as optional; the loop
    // bound already guarantees this one. A runtime guard here would be a
    // branch no test could ever reach.
    const msg = messages[i]!
    const toolResults = msg.content.filter((b) => b.type === 'tool_result')
    if (msg.role === 'user' && toolResults.length > 0) {
      // Keep only results whose call is the message we just emitted.
      const prev = out[out.length - 1]
      const openIds = new Set(
        prev?.role === 'assistant'
          ? prev.content
              .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
              .map((b) => b.id)
          : [],
      )
      const kept = msg.content.filter(
        (b) => b.type !== 'tool_result' || openIds.has(b.tool_use_id),
      )
      if (kept.length > 0) out.push({ ...msg, content: kept })
      continue
    }
    out.push(msg)
    if (msg.role !== 'assistant') continue
    const calls = msg.content.filter(
      (b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use',
    )
    if (calls.length === 0) continue
    // Whatever the next message answers, every call needs a result.
    const next = messages[i + 1]
    const answered = new Set(
      next?.role === 'user'
        ? next.content
            .filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result')
            .map((b) => b.tool_use_id)
        : [],
    )
    const missing = calls.filter((c) => !answered.has(c.id))
    if (missing.length === 0) continue
    out.push({
      role: 'user',
      content: missing.map((c) => ({
        type: 'tool_result' as const,
        tool_use_id: c.id,
        content: UNAVAILABLE_RESULT,
      })),
    })
    // The real answers, if any, merge into the message we just synthesized.
    const merged = out[out.length - 1]! // just pushed above
    if (next?.role === 'user' && answered.size > 0) {
      merged.content = [...merged.content, ...next.content]
      i += 1
    }
  }
  return out
}

type ToolUseDescriptor = {
  id: string
  name: string
  input: Record<string, unknown>
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClient,
    private readonly tools: AiTools,
    private readonly agentBots: AgentBotsService,
    private readonly realtime: RealtimeService,
    // forwardRef: ChannelsService imports WhatsappService, which imports
    // ConversationsService, which imports this file back.
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
    private readonly assignment: AssignmentService,
    private readonly aiUsage: AiUsageService,
    private readonly aiAllowance: AiAllowanceService,
  ) {}

  private async publishMessage(m: {
    id: string
    accountId: string
    conversationId: string
    inboxId: string
    senderType: string
    content: string | null
    isPrivate: boolean
    createdAt: Date
  }): Promise<void> {
    await this.realtime.publish({
      type: 'MessageCreated',
      accountId: m.accountId,
      conversationId: m.conversationId,
      inboxId: m.inboxId,
      messageId: m.id,
      senderType: m.senderType,
      content: m.content,
      isPrivate: m.isPrivate,
      createdAt: m.createdAt.toISOString(),
    })
  }

  /**
   * Runs one inbound turn. Called from Conversations.createInboundMessage.
   * Guarded by the caller so a bot misconfiguration doesn't break ingestion.
   */
  async handleInbound(input: {
    accountId: string
    conversationId: string
    inboundMessageContent: string
  }): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      include: { inbox: true, account: { select: { defaultLocale: true } } },
    })
    if (!conversation) return
    // System notices are read by the account's own team, so they follow the
    // account language, not the model's.
    const locale = conversation.account?.defaultLocale ?? 'pt-BR'
    if (!conversation.inbox.agentBotId) return

    // Every `return` from here on is a turn the contact will never get an
    // answer to. Each one hands the conversation to a human instead of
    // leaving it in BOT control with nobody watching it.
    const bot = await this.prisma.agentBot.findUnique({
      where: { id: conversation.inbox.agentBotId },
    })
    if (!bot || !bot.isActive) {
      await this.handOffToHuman(input, botUnavailableNotice(locale), locale)
      return
    }
    if (!this.anthropic.isAvailable(bot.model)) {
      this.logger.warn(
        `Bot ${bot.id} attached but no AI client configured for ${bot.model}; skipping turn`,
      )
      await this.handOffToHuman(input, botUnavailableNotice(locale), locale)
      return
    }

    // The AI allowance comes FIRST, before any spend guard and before the
    // model: it is the limit the customer actually bought, counted in
    // conversations, and checking it after we have already paid for the
    // tokens would defeat the point. In observe mode (the default) this never
    // blocks; it logs what it would have blocked.
    const allowance = await this.aiAllowance.check(
      input.accountId,
      input.conversationId,
    )
    if (!allowance.allowed) {
      await this.handOffToHuman(
        input,
        allowanceNotice(locale, allowance.reason),
        locale,
      )
      return
    }

    // Cost guards. These are OUR protection, not the customer's limit
    // (decision 9). On breach, hand the conversation to a human and bail
    // before calling the model. The account's monthly ceiling is checked
    // first: it's the one the customer is billed against, while the per-bot
    // daily cap only absorbs a runaway loop within a day.
    const monthly = await this.agentBots.monthlyBudgetExceeded(input.accountId)
    if (monthly.exceeded) {
      await this.handOffToHuman(
        input,
        monthlyBudgetNotice(locale, monthly.used, monthly.cap),
        locale,
      )
      return
    }
    const costLast24h = await this.agentBots.costLast24h(bot.id)
    if (costLast24h >= Number(bot.dailyBudgetUsd)) {
      await this.handOffToHuman(input, dailyBudgetNotice(locale, bot.name), locale)
      return
    }

    const aiSession = await this.getOrCreateSession(
      input.accountId,
      input.conversationId,
      bot,
    )
    const turnMessages = this.deserializeHistory(aiSession.state)
    // The session only remembers what the agent itself took part in. Anything
    // the flow, a colleague or the customer said in between was invisible,
    // so after a flow handed a conversation over the agent read "?" as the
    // opening of a new chat and drafted "Olá! Como posso ajudar?" to a
    // customer forty minutes into a problem (conversation 8741, 2026-10-13).
    const unseen = await this.unseenTranscript({
      conversationId: input.conversationId,
      botId: bot.id,
      // Empty history: everything before this message is new to the agent.
      since: turnMessages.length > 0 ? aiSession.lastActiveAt : null,
      inbound: input.inboundMessageContent,
      locale,
    })
    turnMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: unseen
            ? `${UNSEEN_HEADER}\n${unseen}\n\n${NEW_MESSAGE_HEADER}\n${input.inboundMessageContent}`
            : input.inboundMessageContent,
        },
      ],
    })

    const enabledToolNames = this.enabledToolNames(bot)
    const customToolDefs = this.tools.customToolsForBot(bot.customTools)
    // toolPool is what's executable; toolDefs is what's exposed to the model.
    const toolPool = [...this.tools.all(), ...customToolDefs]
    const toolDefs: ToolDefinition[] = toolPool
      .filter(
        (t) =>
          enabledToolNames.includes(t.name) ||
          customToolDefs.some((c) => c.name === t.name),
      )
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }))

    let aggregateUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    // Text the model addressed to the customer, collected across every turn.
    // A turn that also calls a tool still carries real content — answering a
    // question and then escalating the part it can't cover is one turn of
    // prose followed by a tool call — so keeping only the last turn's text
    // silently drops the answer.
    const replyParts: string[] = []
    const pendingDestructive: ToolUseDescriptor[] = []
    const executedTools: Array<{ name: string }> = []

    for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter += 1) {
      const truncated = sanitizeHistory(this.truncateHistory(turnMessages))
      const res = await this.anthropic.createMessage({
        model: bot.model,
        systemPrompt: bot.systemPrompt,
        tools: toolDefs,
        messages: truncated,
        temperature: bot.temperature,
        maxTokens: 4096,
      })
      aggregateUsage = sumUsage(aggregateUsage, res.usage)

      // Always echo the assistant turn back into history so the next call sees it.
      turnMessages.push({
        role: 'assistant',
        content: res.content.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text }
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        }),
      })

      const toolUses = res.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      )

      const turnText = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim()
      // Models often restate their closing line in the final turn; keep one copy.
      if (turnText && turnText !== replyParts[replyParts.length - 1]) {
        replyParts.push(turnText)
      }

      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break

      // Execute non-destructive tools immediately; queue destructive ones as
      // PENDING and stop the loop — a human approves them via the confirm endpoint.
      const toolResults: TurnMessage['content'] = []
      let queued = false
      for (const tu of toolUses) {
        const def =
          toolPool.find((t) => t.name === tu.name) ?? this.tools.byName(tu.name)
        const allowed =
          enabledToolNames.includes(tu.name) ||
          customToolDefs.some((c) => c.name === tu.name)
        if (!def || !allowed) {
          await this.recordToolCall(aiSession.id, tu, {
            status: 'ERROR',
            errorMessage: `Tool ${tu.name} not enabled`,
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Error: tool ${tu.name} is not enabled.`,
            is_error: true,
          })
          continue
        }
        if (def.destructive) {
          await this.recordToolCall(aiSession.id, tu, { status: 'PENDING' })
          pendingDestructive.push(tu)
          queued = true
          // Close the pair right now with a placeholder. The turn stops here,
          // but the history is persisted, and a `tool_use` left unanswered
          // makes every later call on this conversation a 400.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: AWAITING_APPROVAL_RESULT,
          })
          continue
        }
        try {
          const result = await def.handler(
            tu.input,
            {
              accountId: input.accountId,
              conversationId: input.conversationId,
              contactId: conversation.contactId,
              knowledgeTags: bot.knowledgeTags,
            },
            { prisma: this.prisma },
          )
          executedTools.push({ name: tu.name })
          await this.recordToolCall(aiSession.id, tu, {
            status: 'SUCCESS',
            output: result.output,
            durationMs: result.durationMs ?? null,
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result.output),
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          await this.recordToolCall(aiSession.id, tu, {
            status: 'ERROR',
            errorMessage: msg,
          })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `Error: ${msg}`,
            is_error: true,
          })
        }
      }

      if (queued) {
        // Destructive tools pending — leave the loop. The conversation needs a
        // human to approve. We'll surface the pending tool calls via the sidebar.
        // The placeholder results go in first: this history is about to be
        // persisted and reused on the contact's next message.
        turnMessages.push({ role: 'user', content: toolResults })
        replyParts.length = 0
        break
      }

      // Note: `toolResults.length === 0` is unreachable here. The early exit
      // above covers `toolUses.length === 0`, and every iteration
      // through the `for (const tu of toolUses)` loop above either pushes a
      // `tool_result` (success, error, or not-enabled) or sets `queued = true`
      // (destructive). With `queued` false, every tu must have pushed.

      turnMessages.push({ role: 'user', content: toolResults })
    }

    const costUsd = computeCostUsd(bot.model, aggregateUsage)
    await this.persistSession(aiSession.id, turnMessages, aggregateUsage, costUsd)

    // One ledger row per turn, written once we know what became of the
    // answer. `replied` is the whole point of the row: it is what turns a
    // model call into a "conversation the AI answered", which is the unit the
    // customer's allowance is sold in. A turn that only queued a destructive
    // tool for approval, or only wrote a private draft, spent tokens but did
    // not answer anybody, so it costs money and no allowance.
    const ledger = async (replied: boolean) => {
      await this.aiUsage.record({
        accountId: input.accountId,
        conversationId: input.conversationId,
        agentBotId: bot.id,
        source: 'AGENT_BOT',
        model: bot.model,
        usage: aggregateUsage,
        replied,
      })
    }

    if (pendingDestructive.length > 0) {
      // Surface that AI is awaiting human approval.
      const m = await this.prisma.message.create({
        data: {
          conversationId: input.conversationId,
          inboxId: conversation.inboxId,
          accountId: input.accountId,
          senderType: 'SYSTEM',
          content: approvalNotice(locale, pendingDestructive.length),
          contentType: 'TEXT',
          status: 'SENT',
        },
      })
      await this.publishMessage(m)
      await ledger(false)
      return
    }

    const finalText = replyParts.join('\n\n')
    if (!finalText) {
      await ledger(false)
      return
    }

    // Mode-driven outbound handling. Once a conversation is under human
    // control the bot never speaks on the channel again, whatever the mode —
    // otherwise an auto-reply mode would talk over the agent handling the
    // case. It still writes the private draft below, which is useful to the
    // human, and the deterministic flow already stands down the same way.
    const mode = conversation.inbox.aiAutoreplyMode
    const shouldAutoSend =
      conversation.controlMode === 'BOT' &&
      (mode === 'AUTO_FULL' ||
        (mode === 'AUTO_SAFE' &&
          scoreConfidence(finalText, executedTools).score >=
            bot.autoSafeConfidenceThreshold))

    if (shouldAutoSend) {
      // Write the row first so the reply is always in the thread, then push it
      // to the channel and record what actually happened. Claiming SENT
      // without pushing is how an agent ends up talking to nobody.
      const m = await this.prisma.message.create({
        data: {
          conversationId: input.conversationId,
          inboxId: conversation.inboxId,
          accountId: input.accountId,
          senderType: 'AGENT_BOT',
          senderAgentBotId: bot.id,
          content: finalText,
          contentType: 'TEXT',
          status: 'PENDING',
        },
      })
      const delivered = await this.pushToChannel(conversation, finalText, m.id)
      const status = delivered ? 'SENT' : 'FAILED'
      const settled = await this.prisma.message
        .update({ where: { id: m.id }, data: { status } })
        // A failed status write must not swallow the reply — publish what we
        // know is true even if we couldn't record it.
        .catch(() => ({ ...m, status }))
      await this.publishMessage(settled)
      // Only a reply that reached the channel counts. A send that failed is
      // one the contact never saw, and billing the customer for it would be
      // charging for our own outage.
      await ledger(delivered)
    } else {
      // DRAFT or AUTO_SAFE-below-threshold: keep as a private draft a human reviews.
      const m = await this.prisma.message.create({
        data: {
          conversationId: input.conversationId,
          inboxId: conversation.inboxId,
          accountId: input.accountId,
          senderType: 'AGENT_BOT',
          senderAgentBotId: bot.id,
          content: `[draft] ${finalText}`,
          contentType: 'TEXT',
          status: 'PENDING',
          isPrivate: true,
        },
      })
      await this.publishMessage(m)
      // A draft is the team's work, not the AI's answer: whoever approves and
      // sends it is the one who replied, so this never costs the customer a
      // conversation (decision 7).
      await ledger(false)
    }
  }

  /** Approve or reject a queued destructive tool call. */
  async confirmToolCalls(input: {
    accountId: string
    conversationId: string
    toolCallIds: string[]
    decision: 'CONFIRM' | 'REJECT'
  }): Promise<AgentToolCall[]> {
    const session = await this.prisma.aiAgentSession.findUnique({
      where: { conversationId: input.conversationId },
    })
    if (!session) return []

    const calls = await this.prisma.agentToolCall.findMany({
      where: {
        id: { in: input.toolCallIds },
        sessionId: session.id,
        status: 'PENDING',
      },
    })
    if (calls.length === 0) return []

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { contactId: true },
    })
    if (!conversation) return []

    // Resolve against the same pool the turn that queued the call ran with:
    // the built-ins plus the bot's own custom tools. Only a custom tool can be
    // destructive, so the built-ins alone would fail every approval.
    const toolPool =
      input.decision === 'CONFIRM' ? await this.toolPoolForSession(session) : []

    const updated: AgentToolCall[] = []
    // What the model should see in place of the "awaiting approval" stand-in.
    const settled: Array<{ toolUseId: string; content: string; isError: boolean }> = []
    for (const call of calls) {
      if (input.decision === 'REJECT') {
        const u = await this.prisma.agentToolCall.update({
          where: { id: call.id },
          data: { status: 'REJECTED' },
        })
        updated.push(u)
        if (call.toolUseId) {
          settled.push({
            toolUseId: call.toolUseId,
            content: 'A human rejected this action; it did not run.',
            isError: true,
          })
        }
        continue
      }
      const def = toolPool.find((t) => t.name === call.toolName)
      if (!def) {
        const u = await this.prisma.agentToolCall.update({
          where: { id: call.id },
          data: { status: 'ERROR', errorMessage: 'Tool no longer registered' },
        })
        updated.push(u)
        if (call.toolUseId) {
          settled.push({
            toolUseId: call.toolUseId,
            content: 'Error: tool no longer registered.',
            isError: true,
          })
        }
        continue
      }
      try {
        const result = await def.handler(
          (call.input ?? {}) as Record<string, unknown>,
          {
            accountId: input.accountId,
            conversationId: input.conversationId,
            contactId: conversation.contactId,
          },
          { prisma: this.prisma },
        )
        const u = await this.prisma.agentToolCall.update({
          where: { id: call.id },
          data: {
            status: 'CONFIRMED',
            output: result.output as Prisma.InputJsonValue,
            durationMs: result.durationMs ?? null,
          },
        })
        updated.push(u)
        if (call.toolUseId) {
          settled.push({
            toolUseId: call.toolUseId,
            content: JSON.stringify(result.output),
            isError: false,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const u = await this.prisma.agentToolCall.update({
          where: { id: call.id },
          data: { status: 'ERROR', errorMessage: msg },
        })
        updated.push(u)
        if (call.toolUseId) {
          settled.push({ toolUseId: call.toolUseId, content: `Error: ${msg}`, isError: true })
        }
      }
    }
    await this.settleToolResults(session, settled)
    return updated
  }

  /**
   * Every tool the session's bot can run right now. Read at approval time, not
   * when the call was queued: a custom tool removed from the bot in between
   * (or a bot that is gone) leaves the call with nothing to run.
   */
  private async toolPoolForSession(session: AiAgentSession): Promise<ToolDef[]> {
    const bot = session.agentBotId
      ? await this.prisma.agentBot.findUnique({
          where: { id: session.agentBotId },
          select: { customTools: true },
        })
      : null
    return [...this.tools.all(), ...this.tools.customToolsForBot(bot?.customTools)]
  }

  /**
   * Replace the "awaiting approval" stand-ins with what actually happened, so
   * the next turn reasons from the real outcome instead of a stale promise.
   * Best-effort: a session whose history no longer holds the call is left
   * alone, and a write failure must not undo tool calls that already ran.
   */
  private async settleToolResults(
    session: AiAgentSession,
    settled: Array<{ toolUseId: string; content: string; isError: boolean }>,
  ): Promise<void> {
    if (settled.length === 0) return
    const byId = new Map(settled.map((r) => [r.toolUseId, r]))
    const messages = this.deserializeHistory(session.state)
    let touched = false
    const next = messages.map((m) => ({
      ...m,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result') return b
        const hit = byId.get(b.tool_use_id)
        if (!hit || b.content !== AWAITING_APPROVAL_RESULT) return b
        touched = true
        return { ...b, content: hit.content, is_error: hit.isError }
      }),
    }))
    if (!touched) return
    try {
      await this.prisma.aiAgentSession.update({
        where: { id: session.id },
        data: { state: { messages: next } as Prisma.InputJsonValue },
      })
    } catch (err) {
      this.logger.warn(
        `could not settle tool results for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ─── helpers ───────────────────────────────────────────────────

  private enabledToolNames(bot: AgentBot): string[] {
    const arr = (bot.toolsEnabled as unknown) as Array<{ name: string }> | null
    if (!arr || !Array.isArray(arr) || arr.length === 0) {
      // Default: all built-in tools enabled.
      return this.tools.all().map((t) => t.name)
    }
    return arr.map((t) => t.name)
  }

  private truncateHistory(messages: TurnMessage[]): TurnMessage[] {
    if (messages.length <= MAX_HISTORY_TURNS) return messages
    let start = messages.length - MAX_HISTORY_TURNS
    // Never open the window on tool results whose call we just cut away.
    while (
      messages[start]?.content.some((b) => b.type === 'tool_result') === true
    ) {
      start += 1
    }
    return messages.slice(start)
  }

  private deserializeHistory(state: unknown): TurnMessage[] {
    if (!state || typeof state !== 'object') return []
    const obj = state as { messages?: TurnMessage[] }
    return Array.isArray(obj.messages) ? obj.messages : []
  }

  /**
   * What the conversation said since the agent last looked, oldest first, as
   * "Speaker: text" lines; '' when there is nothing new.
   *
   * Public messages from the customer, the flow and human agents only. This
   * bot's own replies are already in its history, and a private note or a
   * draft was never said to the customer. The newest customer row carrying
   * the inbound text is the message this turn answers, so it is left out
   * here: the turn quotes it separately.
   */
  private async unseenTranscript(args: {
    conversationId: string
    botId: string
    since: Date | null
    inbound: string
    locale: string
  }): Promise<string> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: args.conversationId,
        isPrivate: false,
        senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] },
        // `not: botId` alone would also drop every row with NO bot (the
        // customer's, the flow's): SQL compares NULL as unknown.
        OR: [{ senderAgentBotId: null }, { senderAgentBotId: { not: args.botId } }],
        ...(args.since ? { createdAt: { gt: args.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: UNSEEN_MESSAGES + 1,
      select: { senderType: true, content: true },
    })
    const [newest, ...rest] = rows
    const isThisTurn =
      newest?.senderType === 'CONTACT' &&
      (newest.content ?? '').trim() === args.inbound.trim()
    const before = isThisTurn ? rest : rows
    return formatTranscript(before.slice(0, UNSEEN_MESSAGES).reverse(), args.locale)
  }

  private async getOrCreateSession(
    accountId: string,
    conversationId: string,
    bot: AgentBot,
  ): Promise<AiAgentSession> {
    const existing = await this.prisma.aiAgentSession.findUnique({
      where: { conversationId },
    })
    if (existing) {
      // A flow's AI block may have opened this row before any bot was
      // attached, leaving it with no bot. Claim it, so the spend recorded on
      // it also counts against this bot's daily cap from here on.
      if (existing.agentBotId) return existing
      return this.prisma.aiAgentSession.update({
        where: { id: existing.id },
        data: { agentBotId: bot.id },
      })
    }
    return this.prisma.aiAgentSession.create({
      data: {
        accountId,
        conversationId,
        agentBotId: bot.id,
        state: { messages: [] } as Prisma.InputJsonValue,
      },
    })
  }

  private async persistSession(
    sessionId: string,
    messages: TurnMessage[],
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
    costUsd: number,
  ): Promise<void> {
    await this.prisma.aiAgentSession.update({
      where: { id: sessionId },
      data: {
        state: { messages: sanitizeHistory(this.truncateHistory(messages)) } as Prisma.InputJsonValue,
        totalTokensIn: { increment: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens },
        totalTokensOut: { increment: usage.outputTokens },
        totalCostUsd: { increment: costUsd },
        lastActiveAt: new Date(),
      },
    })
  }

  private async recordToolCall(
    sessionId: string,
    call: ToolUseDescriptor,
    state: {
      status: 'PENDING' | 'SUCCESS' | 'ERROR' | 'CONFIRMED' | 'REJECTED'
      output?: Record<string, unknown>
      errorMessage?: string
      durationMs?: number | null
    },
  ): Promise<AgentToolCall> {
    return this.prisma.agentToolCall.create({
      data: {
        sessionId,
        toolName: call.name,
        toolUseId: call.id,
        input: call.input as Prisma.InputJsonValue,
        output: (state.output as Prisma.InputJsonValue | undefined) ?? undefined,
        errorMessage: state.errorMessage,
        status: state.status,
        durationMs: state.durationMs ?? null,
      },
    })
  }

  /**
   * Push the agent's reply to the contact's channel.
   *
   * The orchestrator used to stop at writing the Message row, which meant
   * every auto-reply was visible in Cosmika and invisible to the customer.
   * Mirrors FlowRunnerService.push: WhatsApp only (widget/API are pull-based,
   * the thread is the transport), phone when known and BSUID otherwise, and
   * failures are reported rather than thrown so one dead send can't abort the
   * turn or lose the accounting.
   */
  private async pushToChannel(
    conversation: { id: string; inboxId: string; contactId: string },
    text: string,
    /** Message row to stamp with the wamid, so delivery receipts match. */
    messageId?: string,
  ): Promise<boolean> {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: conversation.inboxId },
      select: { channelType: true },
    })
    // A vanished inbox is a failure; a widget/API inbox is pull-based (the
    // thread IS the transport) and counts as delivered with nothing to push.
    if (!inbox) return false
    const adapter = this.channels.adapterFor(inbox.channelType)
    if (!adapter) return true
    const to = await adapter.recipientFor(conversation.id)
    if (!to) {
      this.logger.error(`no recipient for ${conversation.id}; agent reply not delivered`)
      return false
    }
    // Outside the provider's reply window (WhatsApp's 24h) only an approved
    // template may be sent. Don't spend a provider call to be told that: the
    // reply is already written and stays in the thread as FAILED, so a human
    // can send it via template rather than retyping it.
    const window = await adapter.windowFor(conversation.id)
    if (window && !window.open) {
      this.logger.warn(
        `reply window closed for ${conversation.id} (last inbound ${window.lastInboundAt ?? 'never'}); ` +
          'agent reply kept in the thread, not sent',
      )
      return false
    }
    try {
      const { externalId } = await adapter.sendText(conversation.inboxId, to, text)
      if (messageId) await adapter.stampOutbound(messageId, [externalId])
      return true
    } catch (err) {
      this.logger.error(
        `agent reply delivery failed for ${conversation.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * The AI cannot answer this turn: give the conversation to a person.
   *
   * This used to write a SYSTEM notice and *clear* the assignee, which was
   * the worst of both worlds: the conversation stayed in BOT control, so the
   * desk's bot filters still hid it, the contact got nothing back, and the
   * one human who might have noticed was removed from it. Accounts that hit
   * their monthly cap discovered it from the customer.
   *
   * Four things have to happen, in this order:
   *   1. control moves to HUMAN, with an assignee, so the conversation lands
   *      on a real queue (the existing assignee keeps it; otherwise the
   *      inbox's normal availability rules pick one),
   *   2. the desk gets an internal note saying why the bot stopped,
   *   3. an assignee activity entry, so the transcript shows who got it,
   *   4. the contact gets a short handoff line, in the account's language.
   *
   * A conversation already under human control is left alone: without that
   * guard, every later message on a blown budget would re-announce the
   * handoff to the contact.
   */
  /**
   * The bot had the turn and said nothing at all. Give it to a person.
   *
   * Deliberately stated as an outcome, not a cause: the caller does not need
   * to know WHY nothing came out (a flow parked on a step it never announced,
   * a link cycle, a throwing integration, an AI turn with no reply). Silence
   * towards a waiting customer is the defect, whatever produced it.
   *
   * Routes through the same four steps as every other handoff, so the desk
   * sees it and the contact is told a human is coming.
   */
  async handOffSilentTurn(input: {
    accountId: string
    conversationId: string
  }): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: input.accountId },
      select: { defaultLocale: true },
    })
    const locale = account?.defaultLocale ?? 'pt-BR'
    await this.handOffToHuman(input, silentTurnNotice(locale), locale)
  }

  private async handOffToHuman(
    input: { accountId: string; conversationId: string },
    notice: string,
    locale: string,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        inboxId: true,
        contactId: true,
        assigneeId: true,
        controlMode: true,
      },
    })
    if (!conversation) return
    if (conversation.controlMode !== 'BOT') return

    // Control first, so a later message on the same blown budget sees HUMAN
    // and does not announce the handoff again; then the same availability
    // rules the rest of the app uses pick who takes it (and log the change).
    await this.prisma.conversation.update({
      where: { id: input.conversationId },
      data: { controlMode: 'HUMAN' },
    })
    await this.assignment.route(input.conversationId, 'bot_handoff')

    const note = await this.prisma.message.create({
      data: {
        conversationId: input.conversationId,
        inboxId: conversation.inboxId,
        accountId: input.accountId,
        senderType: 'SYSTEM',
        content: notice,
        contentType: 'TEXT',
        status: 'SENT',
      },
    })
    await this.publishMessage(note)

    // Last: the contact. The row goes in first so the promise is in the
    // thread even when the channel push fails, exactly like an agent reply.
    const text = handoffMessage(locale)
    const out = await this.prisma.message.create({
      data: {
        conversationId: input.conversationId,
        inboxId: conversation.inboxId,
        accountId: input.accountId,
        senderType: 'AGENT_BOT',
        content: text,
        contentType: 'TEXT',
        status: 'PENDING',
      },
    })
    const delivered = await this.pushToChannel(
      {
        id: input.conversationId,
        inboxId: conversation.inboxId,
        contactId: conversation.contactId,
      },
      text,
      out.id,
    )
    const status = delivered ? 'SENT' : 'FAILED'
    const settled = await this.prisma.message
      .update({ where: { id: out.id }, data: { status } })
      .catch(() => ({ ...out, status }))
    await this.publishMessage(settled)
  }

  /** Public DTO mapper for AgentToolCall — used by the controller and orchestrator response. */
  toToolCallDTO(c: AgentToolCall) {
    return {
      id: c.id,
      sessionId: c.sessionId,
      toolName: c.toolName,
      input: (c.input ?? {}) as Record<string, unknown>,
      output: (c.output ?? null) as Record<string, unknown> | null,
      errorMessage: c.errorMessage,
      status: c.status,
      costUsd: Number(c.costUsd),
      durationMs: c.durationMs,
      createdAt: c.createdAt.toISOString(),
    }
  }

  /** Read AI panel state for the conversation sidebar. */
  async getSessionView(conversationId: string): Promise<{
    session: {
      id: string
      conversationId: string
      agentBotId: string | null
      totalTokensIn: number
      totalTokensOut: number
      totalCostUsd: number
      lastActiveAt: string
      createdAt: string
    } | null
    recentToolCalls: ReturnType<OrchestratorService['toToolCallDTO']>[]
  }> {
    const session = await this.prisma.aiAgentSession.findUnique({
      where: { conversationId },
    })
    if (!session) return { session: null, recentToolCalls: [] }
    const calls = await this.prisma.agentToolCall.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    return {
      session: {
        id: session.id,
        conversationId: session.conversationId,
        agentBotId: session.agentBotId,
        totalTokensIn: session.totalTokensIn,
        totalTokensOut: session.totalTokensOut,
        totalCostUsd: Number(session.totalCostUsd),
        lastActiveAt: session.lastActiveAt.toISOString(),
        createdAt: session.createdAt.toISOString(),
      },
      recentToolCalls: calls.map((c) => this.toToolCallDTO(c)),
    }
  }
}

// Confidence scoring dials. The old scorer started at 100 and subtracted 20
// for ANY tool use, which meant a reply the model had actually researched
// scored *lower* than one it invented — and the safest-looking score of 100
// was only reachable by never checking anything. These invert that: looking
// something up raises confidence, asserting without looking lowers it.
const NEUTRAL_CONFIDENCE = 80
// Above this, an unsourced reply is making claims rather than chatting.
const UNGROUNDED_CLAIM_CHARS = 200

/**
 * AUTO_SAFE confidence scorer. Returns a 0-100 score for whether a reply is
 * safe enough to auto-send. Pure heuristic — no extra LLM call — so it's
 * deterministic for tests and adds zero cost. Mistakes here fall back to
 * DRAFT, which is the safe direction.
 *
 * Starts neutral (80) and moves from there:
 *   - grounded in the knowledge base: +20
 *   - handing off to a human: +10 (a handoff note asserts nothing)
 *   - substantive (>200 chars) with no lookup: −25
 *   - very long (>1000 chars): −10
 *   - uncertainty phrase per match: −30 (outweighs grounding by design)
 *   - empty/whitespace: forced 0
 */
export function scoreConfidence(
  text: string,
  toolCalls: Array<{ name: string; status?: string }>,
): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const trimmed = text.trim()
  if (trimmed.length === 0) return { score: 0, reasons: ['empty'] }

  const used = new Set(toolCalls.map((t) => t.name))
  const grounded =
    used.has('search_knowledge_base') || used.has('read_knowledge_base_article')

  // Neutral start: a short conversational reply with no claims in it — a
  // greeting, a clarifying question — is fine to send as-is.
  let score = NEUTRAL_CONFIDENCE
  if (grounded) {
    score += 20
    reasons.push('grounded in the knowledge base')
  } else if (trimmed.length > UNGROUNDED_CLAIM_CHARS) {
    // Long, unsourced, and not a handoff: the model is asserting something it
    // never looked up. This is the case worth holding back.
    score -= 25
    reasons.push('substantive answer with no knowledge-base lookup')
  }
  if (used.has('assign_conversation_to_human')) {
    // A handoff note makes no factual claim — it says a human will follow up.
    score += 10
    reasons.push('handing off to a human')
  }
  if (trimmed.length > 1000) {
    score -= 10
    reasons.push('very long')
  }
  // Note: trailing `\b` on `no sé` would never match — `é` is not in `\w`
  // (no /u flag), so the boundary between `é` and a following non-\w char
  // (space/punctuation/EOL) fails. Use a lookahead instead.
  const uncertainty = [
    /\bi['' ]?m not sure\b/i,
    /\bi don['' ]?t know\b/i,
    /\bmaybe\b/i,
    /\blet me check\b/i,
    /\bnão tenho certeza\b/i,
    /\bno estoy seguro\b/i,
    /\bnão sei\b/i,
    /\bno sé(?![a-z])/i,
  ]
  for (const re of uncertainty) {
    if (re.test(trimmed)) {
      // Outweighs the grounding bonus on purpose: a hedged answer is held
      // back even when the model did consult the knowledge base.
      score -= 30
      reasons.push(`uncertain: ${re.source}`)
    }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons }
}

function sumUsage(
  a: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  b: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

// suppress unused-var hint for `Conversation` import (type-only narrowing in handleInbound)
type _Conversation = Conversation
