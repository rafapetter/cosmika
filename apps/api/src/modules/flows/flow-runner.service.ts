import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import { Prisma } from '@cosmika/db'
import * as Sentry from '@sentry/node'
import type { Contact, Conversation, Inbox } from '@cosmika/db'
import { FlowDefinition } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'
import { WhatsappService } from '../whatsapp/whatsapp.service'
import { ChannelsService } from '../channels/channels.service'
import { flowMediaFor } from '../channels/flow-media'
import { EmailService } from '../email/email.service'
import { SupportTicketsService } from '../support-tickets/support-tickets.service'
import { AssignmentService } from '../assignment/assignment.service'
import {
  AnthropicClient,
  type DeviationAction,
} from '../ai/anthropic-client'
import { AgentBotsService } from '../ai/agent-bots.service'
import { FlowAgentService } from '../ai/flow-agent.service'
import { AiAllowanceService } from '../usage/ai-allowance.service'
import { AiUsageService } from '../usage/ai-usage.service'
import {
  allowanceNotice,
  botUnavailableNotice,
  dailyBudgetNotice,
  handoffMessage,
  monthlyBudgetNotice,
} from '../ai/orchestrator.service'
import type { UsageBreakdown } from '../ai/anthropic-pricing'

import { assertSafeFetchUrl } from '../../common/safe-fetch'
import { formatTranscript } from '../../common/transcript'

import { runSandboxedCode } from './flow-code-sandbox'

import {
  FlowEngine,
  type FlowAgentResult,
  type FlowContext,
  type FlowEffects,
  type FlowEmission,
  type FlowIntegrationResult,
  type FlowIntent,
  type FlowLlmResult,
  type FlowRuntimeState,
  type FlowStepResult,
} from './flow-engine'

// Ceilings for media an AI block pulls in. Anthropic caps a single image at
// 5 MB; more than a handful of files in one prompt is a cost problem, not a
// feature.
const FLOW_MEDIA_MAX_BYTES = 5 * 1024 * 1024
const FLOW_MEDIA_MAX_FILES = 5

type ConvWithRels = Conversation & {
  inbox: Inbox
  contact: Contact | null
  // The channel-side identity (WhatsApp number, widget visitor id). Migrated
  // Code blocks branch on it — see `seedVariables`.
  contactInbox: { sourceId: string } | null
  // Only the default locale: every string a flow sends is written for either
  // the contact or the desk, and both read the account's language.
  account: { defaultLocale: string; name: string; defaultTimezone: string } | null
}
type InboundInput = {
  accountId: string
  conversationId: string
  content: string
  interactiveReplyId?: string | null
}
// tail: the end of the conversation's queue. queued: messages waiting behind
// the one running. active: calls still in flight (the lane is dropped at 0).
type InboundLane = { tail: Promise<unknown>; queued: number; active: number }
// A message whose turn a newer message of the same burst took over.
const COALESCED = Symbol('coalesced')

type PersistedFlow = {
  flowId: string
  status: string
  runtime?: FlowRuntimeState
  deviations?: number
}

// Which deviation actions the AI may choose, per the inbox policy. A hard
// escalation to a human applies on top once maxDeviations is exceeded.
//
// `handoff` is open to every policy: a customer who asks for a person, or
// reports something broken, must reach one now, not after `maxDeviations`
// more rounds with a bot that cannot help. Conversation 8741 (2026-10-13):
// "meu bot está parado" got two scripted replies, one of them promising a
// transfer the policy did not allow, before the escalation finally fired.
const POLICY_ACTIONS: Record<string, DeviationAction[]> = {
  answer_and_return: ['answer', 'handoff'],
  answer_and_advance: ['answer', 'fill', 'handoff'],
  free_until_done: ['answer', 'fill', 'exit', 'handoff'],
  escalate: ['answer', 'handoff'],
}

// How much of the conversation the off-script classifier reads: enough to
// know who the customer is and what they asked.
const TRANSCRIPT_MESSAGES = 12

/**
 * Drives a deterministic flow for one inbound turn (the orchestrator arbiter's
 * deterministic half). Returns `true` if a flow handled the turn — the caller
 * then skips the AI agent. In STRICT mode the engine owns the whole turn;
 * GUIDED-mode AI deviation handling lands in Phase 4.
 */
@Injectable()
export class FlowRunnerService {
  private readonly logger = new Logger(FlowRunnerService.name)

  // Daily cap on AI deviation-classification calls. GUIDED inboxes call the
  // model on EVERY off-script customer message with no per-bot budget (the
  // agent-bot dailyBudgetUsd guard doesn't cover this path), so a runaway
  // contact/loop would translate directly into API spend. Over the cap we
  // degrade deterministically: the message parks on the current step and the
  // maxDeviations escalation still hands off to a human.
  private deviationDay = ''
  private deviationCalls = 0
  private deviationCapWarned = false

  private deviationCallAllowed(): boolean {
    const cap = Number(process.env.COSMIKA_DEVIATION_DAILY_CAP ?? 2000)
    if (!Number.isFinite(cap) || cap <= 0) return true
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.deviationDay) {
      this.deviationDay = today
      this.deviationCalls = 0
      this.deviationCapWarned = false
    }
    this.deviationCalls++
    if (this.deviationCalls > cap) {
      if (!this.deviationCapWarned) {
        this.deviationCapWarned = true
        this.logger.warn(
          `daily AI deviation cap (${cap}) reached — degrading to deterministic handling until tomorrow`,
        )
      }
      return false
    }
    return true
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp: WhatsappService,
    private readonly ai: AnthropicClient,
    private readonly emails: EmailService,
    private readonly tickets: SupportTicketsService,
    private readonly assignment: AssignmentService,
    private readonly agentBots: AgentBotsService,
    private readonly aiUsage: AiUsageService,
    private readonly aiAllowance: AiAllowanceService,
    private readonly flowAgent: FlowAgentService,
    // forwardRef: same WhatsApp ↔ conversations cycle as `whatsapp` above.
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
  ) {}

  /**
   * One lane per conversation: its inbound messages run one at a time.
   *
   * Each message reads the flow state, may spend seconds (an AI agent turn
   * is up to five model calls), then writes the state back. Run side by
   * side, three quick messages all resumed the SAME state: three agent
   * replies billed, each saving turns=1, so `maxAiTurns` counted short and
   * the transfer fired late; two quick menu taps raced the same way.
   *
   * In memory, which holds because production runs a single API container.
   * Scaling the API out needs a shared lock (Postgres advisory lock) here.
   */
  private readonly lanes = new Map<string, InboundLane>()

  async handleInbound(input: InboundInput): Promise<boolean> {
    const id = input.conversationId
    const lane = this.lanes.get(id) ?? { tail: Promise.resolve(), queued: 0, active: 0 }
    this.lanes.set(id, lane)
    lane.queued += 1
    lane.active += 1
    const run = lane.tail.then(() => this.handleInboundNow(input, lane))
    // A failed run must not stall the lane for the messages behind it.
    lane.tail = run.catch(() => undefined)
    try {
      const outcome = await run
      if (outcome !== COALESCED) return outcome
      // Folded into a newer message's turn: wait for that answer, so the
      // caller's silent-turn rescue sees it went out (this is not a turn the
      // bot ignored, it is one it answered together with the next).
      await lane.tail
      return true
    } finally {
      lane.active -= 1
      if (lane.active === 0) this.lanes.delete(id)
    }
  }

  private async handleInboundNow(input: InboundInput, lane: InboundLane): Promise<boolean | typeof COALESCED> {
    lane.queued -= 1
    const conv = (await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      include: {
        inbox: true,
        contact: true,
        contactInbox: { select: { sourceId: true } },
        account: { select: { defaultLocale: true, name: true, defaultTimezone: true } },
      },
    })) as ConvWithRels | null
    if (!conv || conv.accountId !== input.accountId) return false
    // Only the bot drives the flow; once handed to a human, stand down.
    if (conv.controlMode !== 'BOT') return false
    const inbox = conv.inbox
    if (inbox.flowMode === 'OFF' || !inbox.defaultFlowId) return false

    const flow = await this.prisma.flow.findUnique({
      where: { id: inbox.defaultFlowId },
    })
    if (!flow || !flow.published) return false
    // Isolation: never run a flow that belongs to another account (defends
    // against a tampered/mis-set defaultFlowId; the config API also validates).
    if (flow.accountId !== conv.accountId) return false
    const parsed = FlowDefinition.safeParse(flow.published)
    if (!parsed.success) {
      this.logger.warn(`flow ${flow.id} has an invalid published definition`)
      return false
    }

    const prior = readPersisted(conv.flowState, flow.id)
    // A flow that already concluded (completed/handed off) must not re-trigger
    // on every later message.
    if (prior && prior.status !== 'waiting') return false
    // An AI agent holds the conversation and the customer has already sent
    // more: let the newest message take the turn. The agent reads every
    // message in the thread, so it answers all of them once, and the burst
    // counts as one reply against `maxAiTurns`, not three.
    if (prior?.runtime?.agent && lane.queued > 0) return COALESCED

    const mode = inbox.flowMode === 'GUIDED' ? 'GUIDED' : 'STRICT'
    const subFlows = await this.loadSubFlows(parsed.data, conv.accountId)
    // The entry flow is commonly linked from its own sub-flows. Point its id
    // at the very object we pass as the root so the engine can tell that the
    // link leads back into the flow already running (cycle guard).
    if (flow.externalId) subFlows.set(flow.externalId, parsed.data)
    const engine = new FlowEngine(parsed.data, mode, this.effects(conv), subFlows)
    const ctx: FlowContext = {
      contact: {
        name: conv.contact?.name ?? null,
        email: conv.contact?.email ?? null,
        phoneNumber: conv.contact?.phoneNumber ?? null,
      },
      timezone: conv.account?.defaultTimezone ?? null,
    }
    const result: FlowStepResult =
      prior && prior.runtime
        ? await engine.resume(
            prior.runtime,
            { text: input.content, interactiveReplyId: input.interactiveReplyId ?? null },
            ctx,
          )
        : await engine.start(ctx, seedVariables(conv))

    if (result.status === 'deviation') {
      await this.handleDeviation({
        conv,
        engine,
        flowId: flow.id,
        state: result.state,
        ctx,
        userText: input.content,
        priorDeviations: prior?.deviations ?? 0,
      })
      return true
    }

    await this.persist(conv.id, { flowId: flow.id, status: result.status }, result)
    await this.dispatch(conv, result)
    return true
  }

  /**
   * GUIDED off-script handling: ask the AI what to do (bounded by the inbox
   * deviation policy), escalating to a human once maxDeviations is exceeded,
   * then apply: answer (reply + stay on the step), fill (feed the extracted
   * value back into the flow), exit (hand to the AI agent), or handoff.
   */
  private async handleDeviation(args: {
    conv: ConvWithRels
    engine: FlowEngine
    flowId: string
    state: FlowRuntimeState
    ctx: FlowContext
    userText: string
    priorDeviations: number
  }): Promise<void> {
    const { conv, engine, flowId, state, ctx, userText } = args
    const policy = conv.inbox.deviationPolicy ?? 'answer_and_return'
    const maxDeviations = conv.inbox.maxDeviations ?? 3
    const deviations = args.priorDeviations + 1
    const allowed = POLICY_ACTIONS[policy] ?? POLICY_ACTIONS.answer_and_return!
    // Every line this handler writes to the contact, and the classifier's
    // reply, go out in the account's language.
    const locale = conv.account?.defaultLocale ?? 'pt-BR'

    let decision: {
      action: DeviationAction
      reply: string | null
      value: string | null
    }
    // The customer's allowance first, then our dollar ceiling: same order as
    // the AI block and the orchestrator. Skipped once `maxDeviations` has
    // already decided to escalate, since no model call is coming.
    const budgetStop =
      deviations > maxDeviations
        ? null
        : (await this.aiAllowanceStop(conv)) ?? (await this.aiBudgetStop(conv))
    if (deviations > maxDeviations) {
      // In the account's language, like every other handoff line: this one
      // used to be hard-coded English and reached a Brazilian customer as
      // "Let me connect you with a teammate." (conversation 8741).
      decision = {
        action: 'handoff',
        reply: handoffMessage(locale),
        value: null,
      }
    } else if (budgetStop) {
      // The classifier is a paid call whose reply goes straight to the
      // contact, so with the budget gone there is nothing left to answer the
      // step with. Parking silently would leave someone mid-question waiting
      // on a bot that has stopped thinking; a person takes it instead.
      await this.noteOnConversation(conv, budgetStop.note)
      decision = { action: 'handoff', reply: budgetStop.message, value: null }
    } else if (this.deviationCallAllowed()) {
      const classified = await this.ai.classifyDeviation({
        stepIntent: describeStep(this.blockAt(engine, state)),
        userText,
        allowedActions: allowed,
        transcript: await this.recentTranscript(conv.id, locale),
        businessName: conv.account?.name,
        locale,
      })
      // This is a paid model call on the account. Bill it before acting on
      // the answer, so the budget guards count it even if the rest fails.
      // Its reply is AI-written prose sent to the contact, so it spends a
      // conversation from the allowance (decision 6); a classifier that only
      // extracted a value and said nothing does not.
      await this.recordAiUsage(
        conv,
        'FLOW_DEVIATION',
        classified.model,
        classified.usage,
        classified.reply !== null && classified.reply.length > 0,
      )
      decision = classified
    } else {
      // Cap reached — park silently on the step; the maxDeviations
      // escalation above still guarantees an eventual human handoff.
      decision = { action: 'answer', reply: null, value: null }
    }

    if (decision.reply) {
      await this.emit(conv, { kind: 'text', text: decision.reply, ai: true })
    }

    if (decision.action === 'fill' && decision.value) {
      // Feed the AI-extracted answer back into the flow and continue.
      const resumed = await engine.resume(
        state,
        { text: decision.value, interactiveReplyId: null },
        ctx,
      )
      await this.persist(
        conv.id,
        { flowId, status: resumed.status, deviations: 0 },
        resumed,
      )
      await this.dispatch(conv, resumed)
      return
    }

    if (decision.action === 'exit') {
      // Conclude the flow; future messages fall through to the AI agent.
      await this.persistRaw(conv.id, { flowId, status: 'completed' })
      return
    }

    if (decision.action === 'handoff') {
      await this.persistRaw(conv.id, { flowId, status: 'handoff' })
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { controlMode: 'HUMAN' },
      })
      await this.assignment.route(conv.id, 'bot_handoff')
      return
    }

    // 'answer' (or 'fill' with no extracted value): stay parked on the step.
    await this.persistRaw(conv.id, {
      flowId,
      status: 'waiting',
      runtime: state,
      deviations,
    })
  }

  /**
   * The last messages of the conversation as plain lines, oldest first, for
   * the off-script classifier. Public messages only: an internal note or an
   * AI draft was never said to the customer.
   */
  private async recentTranscript(conversationId: string, locale: string): Promise<string> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        isPrivate: false,
        senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] },
      },
      orderBy: { createdAt: 'desc' },
      take: TRANSCRIPT_MESSAGES,
      select: { senderType: true, content: true },
    })
    return formatTranscript(rows.reverse(), locale)
  }

  private blockAt(
    engine: FlowEngine,
    state: FlowRuntimeState,
  ): Record<string, unknown> | null {
    return engine.blockAt(state.currentGroupId, state.currentBlockId, state.currentFlowId)
  }

  /**
   * Resolve the sub-flows referenced by Cosmoflow-link blocks. BFS over the
   * root + each loaded sub-flow, loading account-scoped Flow rows by their
   * source-system id (`externalId` == the link's `cosmoflowId`). Bounded by a
   * visited set + a hard load cap so a malformed link graph can't fan out.
   */
  private async loadSubFlows(
    rootDef: unknown,
    accountId: string,
  ): Promise<Map<string, FlowDefinition>> {
    const MAX_SUBFLOWS = 100
    const resolved = new Map<string, FlowDefinition>()
    const seen = new Set<string>()
    let frontier = collectLinkIds(rootDef)
    while (frontier.length > 0 && resolved.size < MAX_SUBFLOWS) {
      const wanted = frontier.filter((id) => !seen.has(id))
      wanted.forEach((id) => seen.add(id))
      if (wanted.length === 0) break
      const rows = await this.prisma.flow.findMany({
        where: { accountId, externalId: { in: wanted }, published: { not: Prisma.JsonNull } },
      })
      const next: string[] = []
      for (const row of rows) {
        if (!row.externalId || resolved.has(row.externalId)) continue
        const sub = FlowDefinition.safeParse(row.published)
        if (!sub.success) continue
        resolved.set(row.externalId, sub.data)
        next.push(...collectLinkIds(row.published))
      }
      frontier = next
    }
    return resolved
  }

  /**
   * Email integration block. Migrated Nebula blocks carry `recipients` (the
   * V1 export writes a single address, but comma/semicolon lists are accepted),
   * optional `cc`, plus `subject`/`body` — all already interpolated by the
   * engine before we see them.
   *
   * Every send records a `sent`/`error` variable so a downstream Condition can
   * branch on the outcome, matching how the migrated flows treat other I/O.
   */
  private async sendFlowEmail(
    options: Record<string, unknown>,
  ): Promise<FlowIntegrationResult> {
    const str = (k: string): string =>
      typeof options[k] === 'string' ? (options[k] as string) : ''
    const addresses = (raw: string): string[] =>
      raw
        .split(/[,;]/)
        .map((a) => a.trim())
        .filter((a) => a.includes('@'))

    const to = [...addresses(str('recipients')), ...addresses(str('cc'))]
    const subject = str('subject').trim()
    if (to.length === 0 || !subject) {
      this.logger.warn(
        `flow Email block skipped: ${to.length === 0 ? 'no valid recipient' : 'no subject'}`,
      )
      return { variables: { email_sent: false, email_error: 'missing recipient or subject' } }
    }
    // `isHtml` blocks exist in the migrated set but EmailService is text-only;
    // strip tags rather than mailing raw markup at a human.
    const body = options.isHtml === true
      ? str('body').replace(/<[^>]+>/g, '').trim()
      : str('body')

    let ok = false
    try {
      const results = await Promise.all(
        to.map((addr) => this.emails.send(addr, subject, body)),
      )
      ok = results.every(Boolean)
    } catch (err) {
      this.logger.error(
        `flow Email block failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { variables: { email_sent: false, email_error: 'send failed' } }
    }
    if (!ok) {
      // EmailService returns false when the provider rejected it or no
      // RESEND_API_KEY is configured — both already logged there.
      return { variables: { email_sent: false, email_error: 'provider rejected' } }
    }
    return { variables: { email_sent: true, email_error: null } }
  }

  /**
   * Ticket blocks. Migrated Nebula flows use three: `Ticket Create` opens a
   * chamado and writes its id/number back into flow variables, `Ticket Update`
   * appends a message to the conversation's open ticket, and `Ticket Query`
   * counts what the customer already has open.
   *
   * The `*Variable` options name where the result lands, so a downstream
   * Condition can branch on it. Every path returns variables rather than
   * throwing — a ticketing failure must not strand the customer mid-flow.
   */
  private async runTicketBlock(
    kind: 'Ticket Create' | 'Ticket Update' | 'Ticket Query',
    options: Record<string, unknown>,
    conv: ConvWithRels,
  ): Promise<FlowIntegrationResult> {
    // Option names are author-chosen; fall back to the names the V1 export
    // writes so an untouched migrated block works as-is.
    const varName = (key: string, fallback: string): string => {
      const v = options[key]
      return typeof v === 'string' && v.trim() ? v.trim() : fallback
    }
    try {
      if (kind === 'Ticket Create') {
        const ticket = await this.tickets.create({
          accountId: conv.accountId,
          conversationId: conv.id,
          contactId: conv.contactId,
          subject: options.subject,
          description: options.description,
          category: options.category,
          priority: options.priority,
        })
        // Leave the ticket in the thread as a private note. Without this the
        // agent who picks the conversation up has no idea a chamado exists.
        await this.noteOnConversation(
          conv,
          `🎫 Chamado #${ticket.number} aberto — ${ticket.subject}`,
        )
        return {
          variables: {
            [varName('ticketIdVariable', 'ticket_id')]: ticket.id,
            [varName('ticketNumberVariable', 'ticket_number')]: ticket.number,
            ticket_error: null,
          },
        }
      }
      if (kind === 'Ticket Update') {
        const updated = await this.tickets.appendUpdate(
          conv.accountId,
          conv.id,
          options.message,
        )
        return {
          variables: {
            [varName('resultVariable', 'ticket_status')]: updated ? updated.status : 'not_found',
            ticket_error: updated ? null : 'no open ticket',
          },
        }
      }
      {
        const rows = await this.tickets.list(conv.accountId, {
          conversationId: conv.id,
          contactId: conv.contactId,
          byContact: options.queryType === 'contact',
        })
        return {
          variables: {
            [varName('countVariable', 'ticket_count')]: rows.length,
            [varName('resultVariable', 'tickets')]: rows.map((t) => ({
              id: t.id,
              number: t.number,
              subject: t.subject,
              status: t.status,
              priority: t.priority,
              createdAt: t.createdAt.toISOString(),
            })),
            ticket_error: null,
          },
        }
      }
    } catch (err) {
      this.logger.error(
        `flow ${kind} failed for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return { variables: { ticket_error: 'failed' } }
    }
  }

  /**
   * Download the attachments an AI block routed in via `imageVariableIds` and
   * encode them for the model. SSRF-guarded and size-capped; a URL that fails
   * is logged and skipped rather than aborting the block, matching how every
   * other flow I/O path degrades.
   */
  private async fetchFlowMedia(
    urls: string[],
  ): Promise<
    Array<{
      type: 'image' | 'document'
      source: { type: 'base64'; media_type: string; data: string }
    }>
  > {
    const out: Array<{
      type: 'image' | 'document'
      source: { type: 'base64'; media_type: string; data: string }
    }> = []
    for (const url of urls.slice(0, FLOW_MEDIA_MAX_FILES)) {
      try {
        await assertSafeFetchUrl(url)
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const mime = (res.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase()
        const kind =
          mime === 'application/pdf'
            ? ('document' as const)
            : mime.startsWith('image/')
              ? ('image' as const)
              : null
        if (!kind) {
          this.logger.warn(`AI block: skipping ${url} — unsupported type "${mime}"`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength > FLOW_MEDIA_MAX_BYTES) {
          this.logger.warn(
            `AI block: skipping ${url} — ${buf.byteLength} bytes over the ${FLOW_MEDIA_MAX_BYTES} cap`,
          )
          continue
        }
        out.push({
          type: kind,
          source: { type: 'base64', media_type: mime, data: buf.toString('base64') },
        })
      } catch (err) {
        this.logger.warn(
          `AI block: could not attach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return out
  }

  /**
   * Real I/O port for integration blocks. SSRF-guarded, JSON-aware, 10s
   * timeout. Failures bubble as exceptions, which the engine swallows (the
   * flow continues with status 0).
   */
  private effects(conv: ConvWithRels): FlowEffects {
    return {
      httpRequest: async ({ url, method, headers, body }) => {
        await assertSafeFetchUrl(url)
        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json', ...(headers ?? {}) },
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res.text()
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          /* not JSON — keep the raw text */
        }
        return { status: res.status, body: parsed }
      },
      llm: async ({ systemPrompt, userText, imageUrls, silent }): Promise<FlowLlmResult> => {
        // A silent classifier feeds a variable and never reaches the
        // contact, so neither layer gates it: it is internal work.
        const stop = silent
          ? null
          : (await this.aiAllowanceStop(conv)) ?? (await this.aiBudgetStop(conv))
        if (stop) return { kind: 'blocked', ...stop }
        const media = await this.fetchFlowMedia(imageUrls ?? [])
        const model = 'claude-haiku-4-5'
        const res = await this.ai.createMessage({
          model,
          systemPrompt: systemPrompt || 'You are a helpful assistant.',
          tools: [],
          messages: [
            { role: 'user', content: [...media, { type: 'text', text: userText }] },
          ],
          maxTokens: 1024,
        })
        const first = res.content.find((b) => b.type === 'text')
        const text = first?.type === 'text' ? first.text.trim() : ''
        // `silent` is exactly the distinction the allowance needs: a reply
        // the contact reads costs a conversation, a variable does not.
        await this.recordAiUsage(
          conv,
          'FLOW_BLOCK',
          model,
          res.usage,
          !silent && text.length > 0,
        )
        return { kind: 'text', text }
      },
      integration: async (kind, options) => {
        if (kind === 'Email') return this.sendFlowEmail(options)
        if (kind === 'Ticket Create' || kind === 'Ticket Update' || kind === 'Ticket Query') {
          return this.runTicketBlock(kind, options, conv)
        }
        // Sheets/Pipefy/ticket providers aren't connected yet; those blocks
        // stay no-ops so the flow continues rather than stalling.
        this.logger.warn(`flow integration "${kind}" is not wired yet — skipping`)
        return {}
      },
      runCode: (code, variables) => runSandboxedCode(code, variables),
      agentTurn: (opts) => this.agentTurn(conv, opts),
    }
  }

  /**
   * One turn of the agent an "AI agent" block picked. The same two budget
   * layers as every paid reply come first; an agent that cannot run, or
   * fails, sends the customer to a person rather than to silence. The spend
   * is billed to the agent that answered, so its own daily cap sees it.
   */
  private async agentTurn(
    conv: ConvWithRels,
    opts: Parameters<FlowEffects['agentTurn']>[0],
  ): Promise<FlowAgentResult> {
    const locale = conv.account?.defaultLocale ?? 'pt-BR'
    const stop = (await this.aiAllowanceStop(conv)) ?? (await this.aiBudgetStop(conv))
    if (stop) return { kind: 'blocked', ...stop }
    try {
      const turn = await this.flowAgent.runTurn({
        accountId: conv.accountId,
        conversationId: conv.id,
        contactId: conv.contactId,
        agentBotId: opts.agentBotId,
        since: opts.since,
        userText: opts.userText,
        instructions: opts.instructions,
        offTopic: opts.offTopic,
        locale,
      })
      if (turn.kind === 'unavailable') {
        return {
          kind: 'blocked',
          message: handoffMessage(locale),
          note:
            turn.reason === 'daily_budget'
              ? dailyBudgetNotice(locale, turn.botName)
              : botUnavailableNotice(locale),
        }
      }
      await this.recordAiUsage(conv, 'AGENT_BOT', turn.model, turn.usage, turn.text.length > 0, turn.botId)
      return { kind: 'reply', text: turn.text, handoff: turn.handoff }
    } catch (err) {
      this.logger.error(
        `flow AI agent failed for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      Sentry.captureException(err)
      return { kind: 'blocked', message: handoffMessage(locale), note: botUnavailableNotice(locale) }
    }
  }

  /**
   * Whether the account has spent its monthly AI ceiling, with the two strings
   * the caller needs when it has: the line the contact reads and the note the
   * desk reads. Null means there is still budget.
   *
   * Metering the flow's spend (below) only made it visible. This is what makes
   * the ceiling bite on the flow paths too: a customer-facing AI reply stops,
   * and the conversation goes to a person rather than going quiet. Silent
   * classifier blocks are not gated, matching how Nebula's allowance treats
   * the same two cases.
   *
   * Never throws: if the budget cannot be read, the flow runs. Failing open
   * costs money, failing closed costs the customer their answer over a
   * transient database error, and every other I/O path here degrades the same
   * way.
   */
  /**
   * Whether the account's AI ALLOWANCE is spent, in the same shape as
   * `aiBudgetStop`. Null means the AI may answer.
   *
   * Two layers, and they are not the same thing. The dollar ceiling below is
   * OUR cost protection; this is the limit the customer bought, counted in
   * conversations the AI answered. The allowance is asked first, because it
   * is the one the customer agreed to and the one an upgrade fixes.
   *
   * `AiAllowanceService.check` decides whether it may actually stop anything:
   * with `COSMIKA_AI_ALLOWANCE_ENFORCE` unset it logs what it WOULD have
   * blocked and answers "allowed", so this returns null and the flow runs
   * exactly as before.
   *
   * Never throws, and the guard is local rather than borrowed. `check` has a
   * catch of its own today, but resting this line on a remote one is a bad
   * trade: the symptom of losing it shows up far from the cause, because a
   * throw here escapes the `llm` effect, the engine catches it, the block
   * yields an empty reply and the flow walks on in silence, which is the
   * exact failure the `blocked` path exists to prevent. On the doubt we do
   * NOT stop, the same way `aiBudgetStop` fails: refusing to answer over a
   * transient database error costs the customer their reply.
   */
  private async aiAllowanceStop(
    conv: ConvWithRels,
  ): Promise<{ message: string; note: string } | null> {
    try {
      const decision = await this.aiAllowance.check(conv.accountId, conv.id)
      if (decision.allowed) return null
      const locale = conv.account?.defaultLocale ?? 'pt-BR'
      return {
        message: handoffMessage(locale),
        note: allowanceNotice(locale, decision.reason),
      }
    } catch (err) {
      this.logger.error(
        `flow AI allowance check failed for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  private async aiBudgetStop(
    conv: ConvWithRels,
  ): Promise<{ message: string; note: string } | null> {
    try {
      const monthly = await this.agentBots.monthlyBudgetExceeded(conv.accountId)
      if (!monthly.exceeded) return null
      const locale = conv.account?.defaultLocale ?? 'pt-BR'
      this.logger.warn(
        `flow AI paused for ${conv.id}: monthly AI budget spent ` +
          `(${monthly.used.toFixed(2)} of ${monthly.cap.toFixed(2)} USD)`,
      )
      return {
        message: handoffMessage(locale),
        note: monthlyBudgetNotice(locale, monthly.used, monthly.cap),
      }
    } catch (err) {
      this.logger.error(
        `flow AI budget check failed for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  /**
   * Bill a flow's model call to the account's AI budget.
   *
   * Both AI paths a flow can take (the AI block and the GUIDED deviation
   * classifier) were spending real money and recording none of it, so the
   * orchestrator's monthly guard read zero for accounts whose whole AI story
   * is a flow.
   *
   * They now write one `AiUsageEvent` per call, and the same call still folds
   * into the `AiAgentSession` row the per-bot daily cap and the
   * conversation's AI panel read: `AiUsageService.record` does both writes,
   * which is why `AgentBotsService.recordAiUsage` could go.
   *
   * `replied` is what makes a call cost the customer a conversation from
   * their AI allowance, so it has to mean "this text reached the contact"
   * and nothing looser.
   *
   * Never throws: a bookkeeping failure must not take down the customer's
   * turn. A call that cost nothing (stub mode) writes nothing.
   */
  private async recordAiUsage(
    conv: ConvWithRels,
    source: 'FLOW_BLOCK' | 'FLOW_DEVIATION' | 'AGENT_BOT',
    model: string,
    usage: UsageBreakdown,
    replied: boolean,
    // The agent that spoke, when it is not the inbox's own (AI agent block).
    agentBotId?: string,
  ): Promise<void> {
    const tokens =
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheWriteTokens
    if (tokens <= 0) return
    try {
      await this.aiUsage.record({
        accountId: conv.accountId,
        conversationId: conv.id,
        agentBotId: agentBotId ?? conv.inbox.agentBotId,
        source,
        model,
        usage,
        replied,
      })
    } catch (err) {
      this.logger.error(
        `flow AI usage not recorded for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async persist(
    conversationId: string,
    base: { flowId: string; status: string; deviations?: number },
    result: FlowStepResult,
  ): Promise<void> {
    await this.persistRaw(conversationId, {
      ...base,
      ...(result.status === 'waiting' ? { runtime: result.state } : {}),
    })
  }

  private async persistRaw(
    conversationId: string,
    next: PersistedFlow,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { flowState: next as unknown as Prisma.InputJsonValue },
    })
  }

  private async dispatch(conv: ConvWithRels, result: FlowStepResult): Promise<void> {
    for (const emission of result.emissions) {
      await this.emit(conv, emission)
    }
    for (const intent of result.intents) {
      await this.applyIntent(conv, intent)
    }
    if (result.status === 'handoff') {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { controlMode: 'HUMAN' },
      })
      // Humans own it now: distribute to an available agent of the inbox, or
      // of the team the handoff block chose (set by applyIntent above).
      await this.assignment.route(conv.id, 'bot_handoff')
    }
  }

  private async emit(conv: ConvWithRels, emission: FlowEmission): Promise<void> {
    let content: string | null
    let contentType: string
    let contentAttributes: Prisma.InputJsonValue
    if (emission.kind === 'text') {
      content = emission.text
      contentType = 'TEXT'
      contentAttributes = emission.ai ? { aiGenerated: true } : {}
    } else if (emission.kind === 'interactive') {
      content = emission.content.body
      contentType = 'QUICK_REPLIES'
      contentAttributes = emission.content as unknown as Prisma.InputJsonValue
    } else {
      content = emission.caption
      contentType = emission.mediaType
      contentAttributes = { url: emission.url } as Prisma.InputJsonValue
    }
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        inboxId: conv.inboxId,
        accountId: conv.accountId,
        senderType: 'AGENT_BOT',
        content,
        contentType: contentType as never,
        contentAttributes,
        status: 'SENT',
      },
    })
    await this.publish(msg)
    await this.push(conv, emission, msg.id)
  }

  /** Agent-only message in the thread: never pushed to the channel. */
  private async noteOnConversation(conv: ConvWithRels, body: string): Promise<void> {
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        inboxId: conv.inboxId,
        accountId: conv.accountId,
        senderType: 'AGENT_BOT',
        content: body,
        contentType: 'TEXT',
        status: 'SENT',
        isPrivate: true,
      },
    })
    await this.publish(msg)
  }

  /** Internal note from a `note` block; handoff message handled in applyIntent. */
  private async applyIntent(conv: ConvWithRels, intent: FlowIntent): Promise<void> {
    if (intent.type === 'note') {
      await this.noteOnConversation(conv, intent.body)
      return
    }
    if (intent.type === 'template') {
      // WhatsApp Template block: send the approved HSM (WhatsApp-only).
      const phone = await this.whatsapp.recipientForConversation(conv.id)
      if (phone) {
        try {
          await this.whatsapp.sendTemplate(
            conv.inboxId,
            phone,
            intent.name,
            intent.language,
            intent.params,
          )
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          this.logger.error(`flow template send failed for ${conv.id}: ${m}`)
        }
      }
      return
    }
    // handoff: send the assigning message (if any) to the customer, assign team.
    if (intent.message) {
      const msg = await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          inboxId: conv.inboxId,
          accountId: conv.accountId,
          senderType: 'AGENT_BOT',
          content: intent.message,
          contentType: 'TEXT',
          status: 'SENT',
        },
      })
      await this.publish(msg)
      await this.push(conv, { kind: 'text', text: intent.message }, msg.id)
    }
    if (intent.teamId) {
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { teamId: intent.teamId },
      })
    }
  }

  private async push(
    conv: ConvWithRels,
    emission: FlowEmission,
    messageId?: string,
  ): Promise<void> {
    const adapter = this.channels.adapterFor(conv.inbox.channelType)
    if (!adapter) return // widget/api are pull-based
    const to = await adapter.recipientFor(conv.id)
    if (!to) return
    try {
      const ids: Array<string | null> = []
      if (emission.kind === 'text') {
        ids.push((await adapter.sendText(conv.inboxId, to, emission.text)).externalId)
      } else if (emission.kind === 'interactive') {
        ids.push(
          (await adapter.sendInteractive(conv.inboxId, to, emission.content)).externalId,
        )
      } else {
        // Native media: the contact gets the picture, the playable voice note
        // or the PDF itself, not a link to it. The provider fetches the URL.
        const media = flowMediaFor(emission)
        const kind = adapter.mediaKindFor(media.fileType, media.mimeType, null)
        const caption = emission.caption ?? ''
        const captionRides =
          caption !== '' &&
          adapter.captionFits(kind) &&
          caption.length <= adapter.captionMax
        if (caption !== '' && !captionRides) {
          ids.push((await adapter.sendText(conv.inboxId, to, caption)).externalId)
        }
        ids.push(
          (
            await adapter.sendMedia(conv.inboxId, to, {
              kind,
              source: { link: emission.url },
              ...(media.fileName ? { fileName: media.fileName } : {}),
              ...(captionRides ? { caption } : {}),
            })
          ).externalId,
        )
      }
      if (messageId) await adapter.stampOutbound(messageId, ids)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`flow outbound push failed for ${conv.id}: ${m}`)
      // Exactly the class that hid the Comercial wrong-token sends: the
      // customer hears nothing and no request ever 500s. Alert on it.
      Sentry.captureException(err)
      // The row is already in the thread as SENT; leaving it there after a
      // failed push is a delivery lie (this is how the Comercial cutover's
      // wrong-token sends hid for a while). Settle it to FAILED so the
      // console shows the truth and the retry affordance appears.
      if (messageId) {
        await this.prisma.message
          .update({ where: { id: messageId }, data: { status: 'FAILED' } })
          .catch(() => undefined)
        await this.realtime
          .publish({
            type: 'MessageStatusChanged',
            accountId: conv.accountId,
            conversationId: conv.id,
            inboxId: conv.inboxId,
            messageId,
            status: 'FAILED',
          })
          .catch(() => undefined)
      }
    }
  }

  private async publish(m: {
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
}

/**
 * Variables a migrated flow expects to already exist when it starts.
 *
 * V1 kept every session value under `user.*`, and its Code blocks branch on
 * the channel identity: the very first block of a migrated welcome flow reads
 * `user.webchat_id` / `user.whatsapp_number` to decide which greeting to send.
 * Cosmika started flows with an empty variable bag, so that block set nothing
 * and every channel Condition fell through to the last branch — a WhatsApp
 * lead was greeted with the generic Facebook/Instagram text (conversation
 * 8739, 2026-09-23). Mirrors Nebula's `Blocks::Script#build_user_vars`.
 *
 * Seeded once at start; the flow is free to overwrite any of them afterwards.
 */
function seedVariables(conv: ConvWithRels): Record<string, unknown> {
  const contact = conv.contact
  const phone = contact?.phoneNumber ?? null
  const sourceId = conv.contactInbox?.sourceId ?? null
  const vars: Record<string, unknown> = {
    name: contact?.name ?? null,
    first_name: contact?.name ?? null,
    email: contact?.email ?? null,
    phone,
    // The service protocol, so a flow can tell the contact their number.
    protocol: (conv as { protocol?: string | null }).protocol ?? null,
  }
  switch (conv.inbox.channelType) {
    case 'WHATSAPP':
      vars.whatsapp_number = phone ?? sourceId
      break
    case 'WEB_WIDGET':
      vars.webchat_id = sourceId
      break
    case 'TELEGRAM':
      vars.telegram_id = sourceId
      break
    case 'FACEBOOK':
      vars.messenger_id = sourceId
      break
    case 'INSTAGRAM':
      vars.instagram_id = sourceId
      break
    default:
      break
  }
  // The contact's custom attributes (company, plan, CPF...) under their own
  // keys, so a flow can skip asking what the desk already knows. They never
  // override the fields above, and the string "null" left behind by imports
  // counts as empty.
  const custom = contact?.customAttributes
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    for (const [k, v] of Object.entries(custom)) {
      if (k in vars || v === 'null') continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') vars[k] = v
    }
  }
  // A null variable is indistinguishable from "unset" for a Condition, and V1
  // code does `if (user.x)`, so drop the empties rather than seeding nulls.
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined || v === '') delete vars[k]
  }
  return vars
}

function readPersisted(raw: unknown, flowId: string): PersistedFlow | null {
  if (!raw || typeof raw !== 'object') return null
  const fs = raw as PersistedFlow
  if (fs.flowId !== flowId) return null
  return fs
}

/** Collect the `cosmoflowId`s referenced by Cosmoflow-link blocks in a def. */
export function collectLinkIds(def: unknown): string[] {
  const ids: string[] = []
  const groups = (def as { groups?: unknown[] } | null)?.groups
  if (!Array.isArray(groups)) return ids
  for (const g of groups) {
    const blocks = (g as { blocks?: unknown[] })?.blocks
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const block = b as { type?: unknown; options?: { cosmoflowId?: unknown } }
      if (block?.type !== 'Cosmoflow link') continue
      const id = block.options?.cosmoflowId
      if (typeof id === 'string' && id) ids.push(id)
      else if (typeof id === 'number') ids.push(String(id))
    }
  }
  return ids
}

/** Human-readable description of the step we're parked on, for the AI prompt. */
export function describeStep(block: Record<string, unknown> | null): string {
  if (!block) return 'the current step'
  const type = String(block.type ?? '')
  const options = (block.options ?? block) as Record<string, unknown>
  if (type === 'choice input' || type === 'picture choice input') {
    const items = Array.isArray(options.items) ? options.items : []
    const labels = items
      .map((it) => String((it as Record<string, unknown>).content ?? '').trim())
      .filter(Boolean)
    return labels.length > 0
      ? `choose one of: ${labels.join(', ')}`
      : 'make a selection'
  }
  const intents: Record<string, string> = {
    'email input': 'provide their email address',
    'phone number input': 'provide their phone number',
    'phone input': 'provide their phone number',
    'number input': 'provide a number',
    'url input': 'provide a URL',
    'date input': 'provide a date',
    'text input': 'provide a text answer',
  }
  return intents[type] ?? 'the current step'
}
