import { Injectable } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { ArticlesService } from '../articles/articles.service'
import { AssignmentService } from '../assignment/assignment.service'
import { assertSafeFetchUrl } from '../../common/safe-fetch'

export type ToolExecutionContext = {
  accountId: string
  conversationId: string
  contactId: string
  // The answering agent's own knowledge base (AgentBot.knowledgeTags). The
  // knowledge tools read only articles carrying one of these; absent or
  // empty = the whole account base.
  knowledgeTags?: string[]
}

export type ToolHandlerResult = {
  output: Record<string, unknown>
  costUsd?: number
  durationMs?: number
}

export type ToolDef = {
  name: string
  description: string
  input_schema: Record<string, unknown>
  destructive: boolean
  handler: (
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
    deps: { prisma: PrismaService },
  ) => Promise<ToolHandlerResult>
}

@Injectable()
export class AiTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly articles: ArticlesService,
    private readonly assignment: AssignmentService,
  ) {}

  /**
   * Built-in tools available to every agent (gated by toolsEnabled list).
   */
  all(): ToolDef[] {
    return [
      this.attachTag,
      this.assignToHuman,
      this.setPriority,
      this.addInternalNote,
      this.searchKnowledgeBase,
      this.readKnowledgeBaseArticle,
    ]
  }

  byName(name: string): ToolDef | null {
    return this.all().find((t) => t.name === name) ?? null
  }

  /**
   * Convert per-bot customTools JSON into ToolDef entries. Each entry must
   * have: { name, description, input_schema, webhook: { url, method?,
   * headers? }, destructive? }. Invalid entries are silently skipped.
   *
   * On invocation, the AI's input is POSTed as JSON to webhook.url, plus
   * { accountId, conversationId, contactId } context. The webhook is
   * expected to return JSON; that JSON becomes the tool output.
   */
  customToolsForBot(
    customTools: unknown,
  ): ToolDef[] {
    if (!Array.isArray(customTools)) return []
    const result: ToolDef[] = []
    for (const raw of customTools) {
      if (!raw || typeof raw !== 'object') continue
      const t = raw as Record<string, unknown>
      const name = typeof t.name === 'string' ? t.name : null
      const description = typeof t.description === 'string' ? t.description : null
      const inputSchema = t.input_schema as Record<string, unknown> | undefined
      const webhook = t.webhook as
        | { url: string; method?: string; headers?: Record<string, string> }
        | undefined
      if (!name || !description || !inputSchema || !webhook?.url) continue
      if (!/^https?:\/\//.test(webhook.url)) continue
      const destructive = Boolean(t.destructive)
      result.push({
        name,
        description,
        input_schema: inputSchema,
        destructive,
        handler: async (input, ctx) => {
          const start = Date.now()
          const timeoutMs = Number(process.env.CUSTOM_TOOL_TIMEOUT_MS ?? 15000)
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), timeoutMs)
          // No `finally` here: the outer `catch (err)` below swallows every
          // throw that could escape the try block, so a v8-reported abnormal
          // exit path through `finally` is unreachable. Clear the timer
          // explicitly on both the success and the catch return.
          try {
            await assertSafeFetchUrl(webhook.url)
            const res = await fetch(webhook.url, {
              method: webhook.method ?? 'POST',
              signal: ac.signal,
              redirect: 'manual',
              headers: {
                'content-type': 'application/json',
                'x-cosmika-tool': name,
                ...(webhook.headers ?? {}),
              },
              body: JSON.stringify({
                tool: name,
                input,
                context: ctx,
              }),
            })
            const body = await res.text()
            let parsed: unknown = body
            try {
              parsed = body ? JSON.parse(body) : {}
            } catch { /* keep raw */ }
            clearTimeout(timer)
            if (!res.ok) {
              return {
                output: {
                  ok: false,
                  status: res.status,
                  error: typeof parsed === 'string' ? parsed.slice(0, 500) : parsed,
                },
                durationMs: Date.now() - start,
              }
            }
            return {
              output: typeof parsed === 'object' && parsed !== null
                ? { ok: true, ...(parsed as Record<string, unknown>) }
                : { ok: true, result: parsed },
              durationMs: Date.now() - start,
            }
          } catch (err) {
            clearTimeout(timer)
            const m = err instanceof Error ? err.message : String(err)
            return {
              output: { ok: false, error: m.slice(0, 500) },
              durationMs: Date.now() - start,
            }
          }
        },
      })
    }
    return result
  }

  /** Non-destructive: appends a string to Conversation.aiTags. */
  private attachTag: ToolDef = {
    name: 'attach_tag',
    description:
      'Append a short categorization tag to the current conversation. Use for topical labels like "billing", "refund", "vip". Max 5 tags per conversation.',
    input_schema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'A single short tag (1-32 chars).',
          minLength: 1,
          maxLength: 32,
        },
      },
      required: ['tag'],
    },
    destructive: false,
    handler: async (input, ctx, { prisma }) => {
      const start = Date.now()
      const tag = String(input.tag ?? '')
        .trim()
        .slice(0, 32)
      if (!tag) {
        return { output: { ok: false, error: 'empty tag' }, durationMs: 0 }
      }
      const conversation = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { aiTags: true },
      })
      if (!conversation) {
        return {
          output: { ok: false, error: 'conversation not found' },
          durationMs: Date.now() - start,
        }
      }
      const current = conversation.aiTags
      if (current.includes(tag)) {
        return {
          output: { ok: true, tags: current, note: 'tag already present' },
          durationMs: Date.now() - start,
        }
      }
      const next = [...current, tag].slice(0, 5)
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { aiTags: next },
      })
      return {
        output: { ok: true, tags: next },
        durationMs: Date.now() - start,
      }
    },
  }

  /**
   * Clears the assignee, appends the "needs-human" tag, and distributes the
   * conversation to an available agent of the inbox (or team). When nobody is
   * available it stays unassigned in the queue, as before.
   *
   * This used to be the one tool marked destructive, which inverted its whole
   * purpose: the agent's way of saying "I can't help, get a person" waited on
   * a person to approve it. Conversations sat in that limbo for weeks (five of
   * them by 2026-09-08), and until the history fix they also silenced the bot
   * on that thread for good. Handing a conversation to a human destroys
   * nothing and is the safest move the agent can make, so it runs directly.
   */
  private assignToHuman: ToolDef = {
    name: 'assign_conversation_to_human',
    description:
      'Hand the conversation off to a human agent. Clears the current assignee so a triage queue can pick it up. Use when the user explicitly asks for a human, or when AI cannot help.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short rationale for handing off (1-200 chars).',
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ['reason'],
    },
    destructive: false,
    handler: async (input, ctx, { prisma }) => {
      const start = Date.now()
      const reason = String(input.reason ?? 'requested handoff')
        .trim()
        .slice(0, 200)
      const conversation = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { aiTags: true },
      })
      if (!conversation) {
        return {
          output: { ok: false, error: 'conversation not found' },
          durationMs: Date.now() - start,
        }
      }
      const tags = conversation.aiTags.includes('needs-human')
        ? conversation.aiTags
        : [...conversation.aiTags, 'needs-human'].slice(0, 5)
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { assigneeId: null, aiTags: tags },
      })
      const routed = await this.assignment.route(ctx.conversationId, 'bot_handoff')
      return {
        output: {
          ok: true,
          reason,
          assigneeCleared: true,
          // Whether an agent was available to take it right now. Never the
          // agent's identity: the model has no business naming staff.
          agentAssigned: Boolean(routed?.pickedId),
        },
        durationMs: Date.now() - start,
      }
    },
  }

  /** Non-destructive: bump priority to LOW/NORMAL/HIGH/URGENT. */
  private setPriority: ToolDef = {
    name: 'set_priority',
    description:
      'Set conversation priority. Use HIGH/URGENT only for verified urgency (outages, safety, explicit angry customer). Default-bumping creates noise.',
    input_schema: {
      type: 'object',
      properties: {
        priority: {
          type: 'string',
          enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
          description: 'New priority level.',
        },
        reason: {
          type: 'string',
          description: 'Why this priority (1-200 chars).',
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ['priority', 'reason'],
    },
    destructive: false,
    handler: async (input, ctx, { prisma }) => {
      const start = Date.now()
      const allowed = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
      const next = String(input.priority ?? '')
      if (!allowed.includes(next as typeof allowed[number])) {
        return { output: { ok: false, error: 'invalid priority' }, durationMs: 0 }
      }
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { priority: next as typeof allowed[number] },
      })
      return {
        output: { ok: true, priority: next, reason: String(input.reason ?? '') },
        durationMs: Date.now() - start,
      }
    },
  }

  /** Non-destructive: drop an internal-only note that customers never see. */
  private addInternalNote: ToolDef = {
    name: 'add_internal_note',
    description:
      'Leave a short internal note on the conversation that only agents can see. Use to summarize context for the next human, flag follow-ups, or document a hand-off rationale.',
    input_schema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The note body (1-2000 chars).',
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ['note'],
    },
    destructive: false,
    handler: async (input, ctx, { prisma }) => {
      const start = Date.now()
      const note = String(input.note ?? '').trim()
      if (!note) {
        return { output: { ok: false, error: 'empty note' }, durationMs: 0 }
      }
      const conversation = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { inboxId: true },
      })
      if (!conversation) {
        return {
          output: { ok: false, error: 'conversation not found' },
          durationMs: Date.now() - start,
        }
      }
      const msg = await prisma.message.create({
        data: {
          conversationId: ctx.conversationId,
          inboxId: conversation.inboxId,
          accountId: ctx.accountId,
          senderType: 'AGENT_BOT',
          content: note,
          contentType: 'TEXT',
          status: 'SENT',
          isPrivate: true,
        },
      })
      return {
        output: { ok: true, messageId: msg.id },
        durationMs: Date.now() - start,
      }
    },
  }

  /** Non-destructive: queries the account's knowledge base. */
  private searchKnowledgeBase: ToolDef = {
    name: 'search_knowledge_base',
    description:
      "Search the workspace's internal knowledge base for relevant published articles. Returns the top matches as title + short excerpt. Use this BEFORE answering substantive questions about products, policies, or processes so the answer is grounded in the account's documentation. Free for cost — call it whenever in doubt. The excerpt is only the opening of the article: to answer anything procedural (steps, settings, limits), follow up with read_knowledge_base_article on the best hit.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "What the user is asking, in your own words. Phrase it naturally — the search uses semantic similarity so don't worry about exact keyword match.",
          minLength: 1,
          maxLength: 500,
        },
        limit: {
          type: 'integer',
          description: 'How many hits to return (default 5, max 10).',
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['query'],
    },
    destructive: false,
    handler: async (input, ctx) => {
      const start = Date.now()
      const query = String(input.query ?? '').trim()
      if (!query) {
        return { output: { ok: false, error: 'empty query' }, durationMs: 0 }
      }
      const limit = Math.min(
        Math.max(Number(input.limit ?? 5), 1),
        10,
      )
      try {
        const hits = await this.articles.search(ctx.accountId, query, limit, ctx.knowledgeTags ?? [])
        return {
          output: { ok: true, hits },
          durationMs: Date.now() - start,
        }
      } catch (err) {
        return {
          output: {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          durationMs: Date.now() - start,
        }
      }
    },
  }

  /** Non-destructive: reads one published article in full. */
  private readKnowledgeBaseArticle: ToolDef = {
    name: 'read_knowledge_base_article',
    description:
      'Read one published knowledge-base article in full, by the id or slug returned from search_knowledge_base. Search only gives you the opening lines of each hit, so read the best hit before answering anything that involves steps, settings, limits or exact wording. Free for cost.',
    input_schema: {
      type: 'object',
      properties: {
        article: {
          type: 'string',
          description:
            'The id or slug of the article, exactly as returned by search_knowledge_base.',
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ['article'],
    },
    destructive: false,
    handler: async (input, ctx) => {
      const start = Date.now()
      const ref = String(input.article ?? '').trim()
      if (!ref) {
        return { output: { ok: false, error: 'empty article reference' }, durationMs: 0 }
      }
      try {
        const article = await this.articles.readPublished(ctx.accountId, ref, ctx.knowledgeTags ?? [])
        if (!article) {
          return {
            output: { ok: false, error: 'article not found' },
            durationMs: Date.now() - start,
          }
        }
        return { output: { ok: true, article }, durationMs: Date.now() - start }
      } catch (err) {
        return {
          output: {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          durationMs: Date.now() - start,
        }
      }
    },
  }
}
