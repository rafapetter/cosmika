import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { AnthropicClient, ToolDefinition, TurnMessage } from '../ai/anthropic-client'
import { computeCostUsd } from '../ai/anthropic-pricing'
import { AiUsageService } from '../usage/ai-usage.service'
import { sanitizeHistory } from '../ai/orchestrator.service'
import { AuditLogService } from '../audit-log/audit-log.service'
import { errBody } from '../../common/app-error'

import { AdminAgentTools, AdminToolContext } from './admin-agent-tools'

const MODEL = 'claude-sonnet-5'
const MAX_TOOL_LOOP_ITERATIONS = 12
const MAX_HISTORY_TURNS = 40
/**
 * The window's start only moves in steps of this many messages. Prompt
 * caching is a prefix match: a window that slid by two messages on every tool
 * round would change the first message each time and never hit the cache.
 */
const HISTORY_WINDOW_STEP = 10
/** Older tool results above this size are summarized before being resent. */
const COMPACT_TOOL_RESULT_OVER = 1_200
const COMPACT_TOOL_RESULT_KEEP = 400

/** Explicit shapes: Prisma's inferred selects aren't portable across packages. */
export type AdminAgentSessionSummary = {
  id: string
  title: string | null
  lastActiveAt: Date
  createdAt: Date
  totalCostUsd: unknown
}

export type AdminAgentToolCallRow = {
  id: string
  toolName: string
  input: unknown
  output: unknown
  status: string
  critical: boolean
  createdAt: Date
}

export type AdminAgentSessionDetail = {
  id: string
  title: string | null
  totalCostUsd: unknown
  toolCalls: AdminAgentToolCallRow[]
  /** Human-readable turns, for rendering. Tool plumbing is stripped out. */
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>
}

export type AdminAgentTurn = {
  sessionId: string
  reply: string
  /** Tool calls awaiting a human decision. Non-empty only in approval mode. */
  pending: Array<{ id: string; toolName: string; input: Record<string, unknown> }>
  executed: Array<{
    toolName: string
    critical: boolean
    durationMs?: number
    output?: unknown
  }>
}

/**
 * Ceiling on a tool output echoed back to the browser so the UI can render it
 * as a table or chart. `list_articles` on a real account is ~22KB of JSON;
 * shipping every such payload would bloat each turn for a panel the admin may
 * never open, so oversized results are dropped and the prose still stands.
 */
const MAX_ECHOED_OUTPUT_CHARS = 24_000

/** JSON.stringify that reports failure instead of throwing mid-turn. */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

function echoableOutput(output: unknown): unknown {
  const json = safeStringify(output)
  if (json === null || json.length > MAX_ECHOED_OUTPUT_CHARS) return undefined
  return output
}

/**
 * Reduce the stored turn history to what a person would want to read: the
 * text they typed and the text the assistant wrote back. `tool_use` and
 * `tool_result` blocks are the machinery in between, and are surfaced
 * separately as tool-call rows rather than pasted into the conversation.
 */
/**
 * Drop `tool_use` blocks that nothing answers.
 *
 * The API requires every `tool_use` to be followed immediately by its
 * `tool_result`; a transcript that breaks that rule is rejected wholesale, so
 * one bad turn makes a session permanently unusable. Sessions written before
 * the approval path was fixed contain exactly that, and they are already on
 * disk — repairing on read is what makes them usable again instead of
 * stranding the admin on a dead conversation.
 *
 * Dropping the block (rather than inventing a result) is the honest repair:
 * the call genuinely never ran, so the model should not be shown a fabricated
 * outcome for it.
 */
export function repairTranscript(messages: TurnMessage[]): TurnMessage[] {
  const answered = new Set<string>()
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      const block = b as { type?: string; tool_use_id?: string }
      if (block.type === 'tool_result' && block.tool_use_id) answered.add(block.tool_use_id)
    }
  }
  const out: TurnMessage[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      out.push(m)
      continue
    }
    const kept = m.content.filter((b) => {
      const block = b as { type?: string; id?: string }
      return !(block.type === 'tool_use' && block.id && !answered.has(block.id))
    })
    // A message whose only content was an unanswered tool_use carries nothing
    // now; an empty content array is itself invalid, so drop the message.
    if (kept.length > 0) out.push({ ...m, content: kept })
  }
  return out
}

/** A turn the admin typed, as opposed to a message carrying tool results. */
function isAdminTurn(m: TurnMessage): boolean {
  return m.role === 'user' && !m.content.some((b) => b.type === 'tool_result')
}

/**
 * What actually goes to the model on each call: a window of the stored
 * history that the API will accept, and that costs a fraction of the raw one.
 *
 * The bug this replaces: `messages.slice(-40)` cut blindly. Flow work is
 * tool-heavy (each call is two messages), so sessions pass 40 quickly, and
 * whenever the cut landed between a call and its result the request opened on
 * an orphaned `tool_result`. The API rejects that wholesale — the admin saw
 * "Internal server error" and the session stayed dead (Gabriel, 2026-09-10,
 * 154 messages).
 *
 * Three rules:
 *  1. The window opens on a turn the admin typed. Never on tool results, and
 *     never on an assistant message (the first message must be the user's).
 *  2. The start moves in fixed steps, so the prefix stays byte-identical
 *     across tool rounds and prompt caching can hit.
 *  3. Tool results from earlier turns are summarized. They were two thirds of
 *     that session's content (the largest 22 KB, resent on every call), and
 *     the model has already answered from them. The current turn's results
 *     stay whole — the model is still working with those.
 */
export function buildRequestHistory(
  stored: TurnMessage[],
  max = MAX_HISTORY_TURNS,
  step = HISTORY_WINDOW_STEP,
): TurnMessage[] {
  // Legacy rows can hold plain-string content; the API and the helpers below
  // want blocks.
  const messages: TurnMessage[] = stored.map((m) =>
    typeof (m.content as unknown) === 'string'
      ? { ...m, content: [{ type: 'text' as const, text: m.content as unknown as string }] }
      : m,
  )
  let start =
    messages.length <= max ? 0 : Math.ceil((messages.length - max) / step) * step
  while (start < messages.length - 1 && !isAdminTurn(messages[start]!)) start += 1
  const window = sanitizeHistory(messages.slice(start))

  // The current turn begins at the last message the admin typed.
  let current = window.length - 1
  while (current > 0 && !isAdminTurn(window[current]!)) current -= 1

  return window.map((m, i) =>
    i >= current
      ? m
      : {
          ...m,
          content: m.content.map((b) =>
            b.type === 'tool_result' &&
            typeof b.content === 'string' &&
            b.content.length > COMPACT_TOOL_RESULT_OVER
              ? {
                  ...b,
                  content:
                    `${b.content.slice(0, COMPACT_TOOL_RESULT_KEEP)}… ` +
                    `[result from an earlier step, ${b.content.length - COMPACT_TOOL_RESULT_KEEP} characters omitted — call the tool again if you need the full data]`,
                }
              : b,
          ),
        },
  )
}

function transcriptOf(state: unknown): Array<{ role: 'user' | 'assistant'; text: string }> {
  const s = state as { messages?: TurnMessage[] } | null
  if (!Array.isArray(s?.messages)) return []
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const m of s.messages) {
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n')
      .trim()
    if (!text) continue
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', text })
  }
  return out
}

function systemPrompt(accountName: string, requiresApproval: boolean): string {
  return [
    `You are the Cosmika admin assistant for the workspace "${accountName}".`,
    '',
    'You help ONE administrator run THIS workspace: its users, inboxes, channels,',
    'bots, flows, settings, reports and analytics. Everything you can see or',
    'change belongs to this workspace and nothing else.',
    '',
    '# How to work',
    '- Look before you answer. Prefer reading the real state over reasoning from',
    '  memory: the tools return live data, and guessing about a live support',
    '  platform is how outages happen.',
    '- Be concrete. Cite the numbers and names you actually read.',
    '- Say plainly when something is not knowable from the tools you have,',
    '  rather than inferring it.',
    '- Keep answers short. This is an operator console, not a report.',
    '',
    '# Making changes',
    requiresApproval
      ? [
          'Changes that affect configuration, membership or anything a customer',
          'sees are queued for the administrator to approve before they run.',
          '',
          'Calling the tool IS how you propose a change. The administrator sees',
          'an approval card with the exact values and clicks approve or reject,',
          'so do NOT ask "shall I go ahead?" in prose first — that makes them',
          'confirm the same thing twice. Say briefly what will change and what',
          'it affects, then call the tool in the same turn.',
          '',
          'Never describe a queued change as done. It has not happened yet.',
        ].join('\n')
      : [
          'This workspace has approval turned off, so your changes apply',
          'immediately. That makes you responsible for care: state what you',
          'changed after doing it, and prefer one deliberate change over several',
          'speculative ones. If a request is ambiguous, ask before acting rather',
          'than guessing — an unwanted change here reaches real customers.',
        ].join('\n'),
    '',
    '# Editing flows',
    '- A flow has a DRAFT and a LIVE version. Every edit tool writes the draft.',
    '  Nothing you change reaches a customer until you call publish_flow.',
    '- Read the flow with get_flow before editing it. Block and group ids come',
    '  from there; never invent one.',
    '- Say which it is. "Changed the greeting" is misleading if it is still',
    '  sitting in the draft — state that it is not live yet, and ask whether to',
    '  publish rather than publishing on your own initiative.',
    '- publish_flow is the step that reaches real people on WhatsApp. Treat it',
    '  as the consequential one, and check get_flow for unreachable groups',
    '  first — a flow that ends early strands customers mid-conversation.',
    '- revert_flow_draft restores the draft from the live version if an edit',
    '  went wrong.',
    '- Draft edits apply straight away, even when approval is on: they reach no',
    '  customer. Only publish_flow (and anything live) waits for approval. So',
    '  build the whole change in one go instead of stopping after each step.',
    '- To build a menu: add the destination groups with add_flow_group (their',
    '  first message can go in the same call), add a "choice input" block with',
    '  add_flow_block, then set_flow_choice_options with each option\'s',
    '  toGroupId. get_flow lists every menu\'s options and where each leads;',
    '  connect_flow_option re-routes a single one.',
    '- When what the customer sees depends on the day or the time (a menu that',
    '  drops units that already closed, an out-of-hours message, a handoff only',
    '  while the team works), use set_flow_hours_condition: it sends the flow',
    '  one way during the opening hours you give and another way otherwise. A',
    '  day can have two windows (morning and afternoon). For several schedules,',
    '  chain checks: put the next check in the "closed" group of the previous',
    '  one, and give each outcome its own menu group. Ask for each unit\'s',
    '  hours rather than assuming them.',
    '',
    '# Limits you cannot work around',
    '- You never see credential values. Tools report whether a secret is set,',
    '  never what it is. Do not ask the administrator to paste one to you.',
    '- You cannot create or change webhooks, API keys, channel credentials or a',
    '  bot\'s custom HTTP tools. WhatsApp and e-mail inboxes are connected on',
    '  the Inboxes settings screen; point the administrator there.',
    '- Inviting or removing a member and sending a broadcast always wait for the',
    '  administrator to approve, even with approval turned off. You read text',
    '  customers wrote, and these must never happen on your word alone.',
    '- You cannot remove the last active administrator.',
    '- You cannot save a flow whose graph is broken; edits that would leave a',
    '  dangling reference are rejected, and that is a guardrail, not a bug to',
    '  work around.',
    '- You edit flow structure, not the visual canvas layout.',
    '- You act as the administrator who invoked you; every change is recorded',
    '  against their name.',
  ].join('\n')
}

/**
 * The admin assistant: an agent an administrator drives against their own
 * workspace.
 *
 * Two things are structural rather than prompt-level, because a prompt is a
 * request and these are guarantees:
 *   - `accountId`/`userId` come from the session row, never from model input,
 *     so the assistant cannot reach another workspace or act as someone else.
 *   - Administrator role is checked on every entry point, not just at session
 *     creation — a role can be revoked mid-session.
 */
@Injectable()
export class AdminAgentService {
  private readonly logger = new Logger(AdminAgentService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicClient,
    private readonly tools: AdminAgentTools,
    private readonly audit: AuditLogService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /** Administrators only — this is the whole access rule for the assistant. */
  async assertAdmin(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive || m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  async listSessions(
    userId: string,
    accountId: string,
  ): Promise<AdminAgentSessionSummary[]> {
    await this.assertAdmin(userId, accountId)
    return this.prisma.adminAgentSession.findMany({
      where: { accountId, userId },
      orderBy: { lastActiveAt: 'desc' },
      take: 30,
      select: {
        id: true, title: true, lastActiveAt: true, createdAt: true,
        totalCostUsd: true,
      },
    })
  }

  async getSession(
    userId: string,
    accountId: string,
    sessionId: string,
  ): Promise<AdminAgentSessionDetail> {
    await this.assertAdmin(userId, accountId)
    const s = await this.prisma.adminAgentSession.findFirst({
      where: { id: sessionId, accountId, userId },
      include: { toolCalls: { orderBy: { createdAt: 'asc' } } },
    })
    if (!s) throw new NotFoundException()
    return { ...s, transcript: transcriptOf(s.state) }
  }

  /** One turn: send a message, run the tool loop, return what happened. */
  async send(
    userId: string,
    accountId: string,
    input: {
      sessionId?: string
      message: string
      attachments?: Array<{ name: string; mediaType: string; data: string }>
    },
  ): Promise<AdminAgentTurn> {
    await this.assertAdmin(userId, accountId)
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { name: true, adminAgentRequiresApproval: true },
    })
    if (!account) throw new NotFoundException()

    const session = input.sessionId
      ? await this.prisma.adminAgentSession.findFirst({
          where: { id: input.sessionId, accountId, userId },
        })
      : await this.prisma.adminAgentSession.create({
          data: {
            accountId,
            userId,
            state: { messages: [] },
            title: input.message.trim().slice(0, 80) || 'Attachment',
          },
        })
    if (!session) throw new NotFoundException()

    const ctx: AdminToolContext = { accountId, userId }
    const messages = this.deserialise(session.state)

    // Attachments come first: Anthropic reads a turn in order, and the
    // question ("what is wrong with this?") only makes sense after the thing
    // it refers to.
    const content: TurnMessage['content'] = []
    for (const att of input.attachments ?? []) {
      content.push({
        type: att.mediaType === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: att.mediaType, data: att.data },
      })
    }
    const text = input.message.trim()
    // A turn must carry something. With an attachment and no words, say what
    // the admin means rather than sending an empty text block, which the API
    // rejects.
    content.push({
      type: 'text',
      text: text || (content.length > 0 ? 'Look at the attached file.' : ''),
    })
    messages.push({ role: 'user', content })

    const defs: ToolDefinition[] = this.tools.all().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    const replyParts: string[] = []
    const pending: AdminAgentTurn['pending'] = []
    const executed: AdminAgentTurn['executed'] = []
    let inTok = 0
    let outTok = 0

    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i += 1) {
      const res = await this.anthropic.createMessage({
        model: MODEL,
        systemPrompt: systemPrompt(account.name, account.adminAgentRequiresApproval),
        tools: defs,
        messages: buildRequestHistory(messages),
        maxTokens: 4096,
      })
      inTok += res.usage.inputTokens
      outTok += res.usage.outputTokens
      messages.push({
        role: 'assistant',
        content: res.content.map((b) =>
          b.type === 'text'
            ? { type: 'text' as const, text: b.text }
            : { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input },
        ),
      })

      // Collect prose from every turn, not just the last: an assistant that
      // explains a change and then calls a tool would otherwise lose the
      // explanation.
      const turnText = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
        .trim()
      if (turnText && turnText !== replyParts[replyParts.length - 1]) {
        replyParts.push(turnText)
      }

      const uses = res.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      )
      if (res.stop_reason !== 'tool_use' || uses.length === 0) break

      const results: TurnMessage['content'] = []
      let queued = false
      for (const use of uses) {
        const def = this.tools.byName(use.name)
        if (!def) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify({ error: `unknown tool ${use.name}` }),
            is_error: true,
          })
          continue
        }

        if (def.alwaysApprove || (def.critical && account.adminAgentRequiresApproval)) {
          const row = await this.prisma.adminAgentToolCall.create({
            data: {
              sessionId: session.id,
              toolName: def.name,
              input: use.input as never,
              status: 'PENDING',
              critical: true,
            },
          })
          pending.push({ id: row.id, toolName: def.name, input: use.input })
          queued = true
          // Every `tool_use` MUST be answered by a `tool_result`, even one
          // that says "not yet". Without this the stored transcript is
          // malformed and every later message in the session is rejected by
          // the API — approval mode would break itself on first use.
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify({
              status: 'awaiting_approval',
              note: 'Queued for the administrator to approve. It has NOT run. Do not describe this change as done.',
            }),
          })
          continue
        }

        const out = await this.runTool(def, use.input, ctx, session.id, userId, accountId)
        executed.push({
          toolName: def.name,
          critical: def.critical,
          output: echoableOutput(out),
        })
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content:
            safeStringify(out) ?? JSON.stringify({ error: 'result could not be serialised' }),
        })
      }

      // Record the results — including the awaiting-approval placeholders —
      // before stopping, so the saved transcript stays well-formed.
      if (results.length > 0) messages.push({ role: 'user', content: results })
      // Something needs a human. Stop here rather than letting the model carry
      // on as though the change had happened.
      if (queued) break
      if (results.length === 0) break
    }

    await this.prisma.adminAgentSession.update({
      where: { id: session.id },
      data: {
        state: { messages } as never,
        totalTokensIn: { increment: inTok },
        totalTokensOut: { increment: outTok },
        totalCostUsd: {
          increment: computeCostUsd(MODEL, {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }),
        },
        lastActiveAt: new Date(),
      },
    })

    // Ledger row, with `replied: false` and no conversation: the assistant
    // talks to the account's own administrator, never to a contact. Its cost
    // is real and belongs in the ledger, but it can never consume a
    // conversation from the customer's AI allowance — charging someone for
    // asking their own admin panel a question would be indefensible.
    await this.aiUsage.record({
      accountId,
      source: 'ADMIN_AGENT',
      model: MODEL,
      usage: {
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      replied: false,
    })

    return {
      sessionId: session.id,
      reply: replyParts.join('\n\n'),
      pending,
      executed,
    }
  }

  /** Approve or reject tool calls the assistant queued. */
  async decide(
    userId: string,
    accountId: string,
    sessionId: string,
    decisions: Array<{ id: string; approve: boolean }>,
  ): Promise<Array<{ id: string; toolName: string; status: string; output?: unknown }>> {
    await this.assertAdmin(userId, accountId)
    const session = await this.prisma.adminAgentSession.findFirst({
      where: { id: sessionId, accountId, userId },
      select: { id: true, state: true },
    })
    if (!session) throw new NotFoundException()

    const out: Array<{ id: string; toolName: string; status: string; output?: unknown }> = []
    for (const d of decisions) {
      const call = await this.prisma.adminAgentToolCall.findFirst({
        where: { id: d.id, sessionId: session.id, status: 'PENDING' },
      })
      if (!call) continue
      if (!d.approve) {
        await this.prisma.adminAgentToolCall.update({
          where: { id: call.id },
          data: { status: 'REJECTED' },
        })
        out.push({ id: call.id, toolName: call.toolName, status: 'REJECTED' })
        continue
      }
      const def = this.tools.byName(call.toolName)
      if (!def) {
        await this.prisma.adminAgentToolCall.update({
          where: { id: call.id },
          data: { status: 'ERROR', errorMessage: 'tool no longer exists' },
        })
        out.push({ id: call.id, toolName: call.toolName, status: 'ERROR' })
        continue
      }
      const result = await this.runTool(
        def,
        (call.input ?? {}) as Record<string, unknown>,
        { accountId, userId },
        session.id,
        userId,
        accountId,
        call.id,
      )
      out.push({
        id: call.id,
        toolName: call.toolName,
        status: 'CONFIRMED',
        output: result,
      })
    }

    // Fold the decisions back into the transcript. The model was told these
    // calls were "awaiting approval"; without this it never learns how they
    // resolved, and would answer the next question as if they were still
    // hanging. Plain text, so no tool_use/tool_result pairing is involved.
    if (out.length > 0) {
      const messages = this.deserialise(session.state)
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: out
              .map((r) =>
                r.status === 'CONFIRMED'
                  ? `[system] The administrator approved ${r.toolName}. It has now run. Result: ${JSON.stringify(r.output)}`
                  : r.status === 'REJECTED'
                    ? `[system] The administrator rejected ${r.toolName}. Nothing was changed. Do not retry it unless asked again.`
                    : `[system] ${r.toolName} could not be applied.`,
              )
              .join('\n'),
          },
        ],
      })
      await this.prisma.adminAgentSession.update({
        where: { id: session.id },
        data: { state: { messages } as never, lastActiveAt: new Date() },
      })
    }

    return out
  }

  /**
   * Run one tool and record it. Every critical call is audited against the
   * invoking administrator — the assistant is a way for them to act, not an
   * actor of its own, so "who changed this" stays answerable.
   */
  private async runTool(
    def: ReturnType<AdminAgentTools['all']>[number],
    input: Record<string, unknown>,
    ctx: AdminToolContext,
    sessionId: string,
    userId: string,
    accountId: string,
    existingCallId?: string,
  ): Promise<Record<string, unknown>> {
    let output: Record<string, unknown>
    let errorMessage: string | null = null
    try {
      const r = await def.handler(input, ctx)
      output = r.output
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
      this.logger.error(`admin tool ${def.name} failed: ${errorMessage}`)
      output = { error: errorMessage }
    }

    const data = {
      output: output as never,
      errorMessage,
      status: (errorMessage ? 'ERROR' : existingCallId ? 'CONFIRMED' : 'SUCCESS') as
        | 'ERROR' | 'CONFIRMED' | 'SUCCESS',
    }
    if (existingCallId) {
      await this.prisma.adminAgentToolCall.update({ where: { id: existingCallId }, data })
    } else {
      await this.prisma.adminAgentToolCall.create({
        data: { sessionId, toolName: def.name, input: input as never, critical: def.critical, ...data },
      })
    }

    if (def.critical && !errorMessage) {
      await this.audit.record({
        accountId,
        actorId: userId,
        action: `admin_agent.${def.name}`,
        target: `account:${accountId}`,
        metadata: { input, viaAdminAgent: true, sessionId },
      })
    }
    return output
  }

  /** Session cost so far, for the header. */
  private deserialise(state: unknown): TurnMessage[] {
    const s = state as { messages?: TurnMessage[] } | null
    return Array.isArray(s?.messages) ? repairTranscript(s.messages) : []
  }
}
