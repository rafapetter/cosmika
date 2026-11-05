import { Injectable, Optional } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'

import { AdminAgentAccountTools } from './admin-agent-account-tools'

import {
  addGroup,
  allBlockIds,
  allEdgeIds,
  choiceItems,
  clone,
  connectOption,
  findBlock,
  removeGroup,
  setChoiceOptions,
  setHoursCondition,
  shapeNewBlock,
  type ChoiceOption,
  type HoursWindow,
  newId,
  summariseBlock,
  summariseChange,
  unreachableGroups,
  validateDefinition,
  type Definition,
} from './flow-edit'

/**
 * Context every tool runs under. `accountId` and `userId` come from the
 * session, NEVER from model input — the assistant cannot name another
 * account, and cannot act as anyone but the administrator who invoked it.
 */
export type AdminToolContext = {
  accountId: string
  userId: string
}

export type AdminToolResult = {
  output: Record<string, unknown>
  durationMs?: number
}

export type AdminToolDef = {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /**
   * Critical tools are the ones a human might want to sign off: they change
   * configuration, membership or anything customer-visible. In approval mode
   * they queue for confirmation; in autonomous mode they run directly.
   */
  critical: boolean
  /**
   * Queued for approval even when the account has approval turned off:
   * inviting or removing people (access to the account) and sending a
   * broadcast (messages real customers, costs money). The assistant reads
   * text customers wrote, so these must never run on its word alone.
   */
  alwaysApprove?: boolean
  handler: (
    input: Record<string, unknown>,
    ctx: AdminToolContext,
  ) => Promise<AdminToolResult>
}

/**
 * Keys whose VALUES must never reach the model, whatever mode the account is
 * in. This is not a permission question — anything returned from a tool
 * becomes part of the transcript, and a transcript is quoted, logged and
 * shown on screen. A token that lands there has effectively leaked, and no
 * approval click undoes that. The assistant can still see that a credential
 * is set, and can still be asked to change one; it just can't read one back.
 */
const SECRET_KEYS = new Set([
  'accessToken',
  'appSecret',
  'webhookVerifyToken',
  'apiKey',
  'secret',
  'secretHash',
  'password',
  'passwordHash',
  'token',
  'refreshToken',
  'privateKey',
  'totpSecret',
])

/** Recursively replace secret values with a marker, preserving shape. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k)
        ? v == null || v === ''
          ? null
          : '[set — hidden]'
        : redactSecrets(v)
    }
    return out
  }
  return value
}

const LOCALES = ['pt-BR', 'en', 'es']

const ok = (output: Record<string, unknown>, started: number): AdminToolResult => ({
  output: redactSecrets(output) as Record<string, unknown>,
  durationMs: Date.now() - started,
})

@Injectable()
export class AdminAgentTools {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly account?: AdminAgentAccountTools,
  ) {}

  all(): AdminToolDef[] {
    return [...this.core(), ...(this.account?.all() ?? [])]
  }

  private core(): AdminToolDef[] {
    return [
      this.accountOverview,
      this.listInboxes,
      this.listMembers,
      this.listFlows,
      this.listAgentBots,
      this.conversationStats,
      this.aiSpend,
      this.recentAuditLog,
      this.listTeams,
      this.listLabels,
      this.listCannedResponses,
      this.listTickets,
      this.csatSummary,
      this.searchConversations,
      this.listArticles,
      this.getFlow,
      this.setInboxAiMode,
      this.setInboxFlowMode,
      this.setCsatEnabled,
      this.setAgentBotConfig,
      this.setMemberRole,
      this.setAccountSettings,
      this.createLabel,
      this.createCannedResponse,
      this.updateFlowBlock,
      this.addFlowBlock,
      this.deleteFlowBlock,
      this.connectFlowBlocks,
      this.addFlowGroup,
      this.renameFlowGroup,
      this.deleteFlowGroup,
      this.setFlowChoiceOptions,
      this.connectFlowOption,
      this.setFlowHoursCondition,
      this.publishFlow,
      this.revertFlowDraft,
      this.setInboxDefaultFlow,
      this.setAgentBotPrompt,
      this.createFlow,
    ]
  }

  byName(name: string): AdminToolDef | null {
    return this.all().find((t) => t.name === name) ?? null
  }

  // ── Read ────────────────────────────────────────────────────────────

  private accountOverview: AdminToolDef = {
    name: 'account_overview',
    description:
      "Snapshot of the account: name, plan, locale/timezone, AI budget, whether the admin assistant asks for approval, and headline counts (members, inboxes, contacts, conversations, flows, bots). Start here when asked anything broad about how the workspace is set up.",
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const [account, members, inboxes, contacts, conversations, flows, bots] =
        await Promise.all([
          this.prisma.account.findUnique({ where: { id: ctx.accountId } }),
          this.prisma.accountMember.count({ where: { accountId: ctx.accountId } }),
          this.prisma.inbox.count({ where: { accountId: ctx.accountId } }),
          this.prisma.contact.count({ where: { accountId: ctx.accountId } }),
          this.prisma.conversation.count({ where: { accountId: ctx.accountId } }),
          // Archived flows are hidden in the product; counting them here
          // would report a number the admin cannot see anywhere on screen.
          this.prisma.flow.count({
            where: { accountId: ctx.accountId, status: { not: 'ARCHIVED' } },
          }),
          this.prisma.agentBot.count({ where: { accountId: ctx.accountId } }),
        ])
      if (!account) return ok({ error: 'account not found' }, started)
      return ok(
        {
          name: account.name,
          slug: account.slug,
          plan: account.plan,
          status: account.status,
          locale: account.defaultLocale,
          timezone: account.defaultTimezone,
          monthlyAiBudgetUsd: Number(account.monthlyAiBudgetUsd),
          adminAgentRequiresApproval: account.adminAgentRequiresApproval,
          counts: { members, inboxes, contacts, conversations, flows, bots },
        },
        started,
      )
    },
  }

  private getFlow: AdminToolDef = {
    name: 'get_flow',
    description:
      "A flow's structure: its groups, the blocks inside each (id, type and a short preview of what they say), and how they connect. Returns the DRAFT by default — that is what edits apply to — or the live version with published:true. Pass blockId to get one block's full options instead. Call this before editing anything.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow id or externalId.' },
        published: { type: 'boolean', description: 'Read the live version instead of the draft.' },
        blockId: { type: 'string', description: 'Return this one block in full.' },
      },
      required: ['flowId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const flow = await this.findFlow(ctx.accountId, String(input.flowId ?? ''))
      if (!flow) return ok({ error: 'no such flow in this account' }, started)

      const wantPublished = input.published === true
      const raw = wantPublished ? flow.published : flow.definition
      if (!raw) {
        return ok(
          { error: wantPublished ? 'this flow has never been published' : 'this flow has no draft' },
          started,
        )
      }
      const def = raw as unknown as Definition

      if (typeof input.blockId === 'string' && input.blockId) {
        const found = findBlock(def, input.blockId)
        if (!found) return ok({ error: `no block "${input.blockId}" in this flow` }, started)
        return ok(
          { flow: flow.name, groupId: found.group.id, block: found.block },
          started,
        )
      }

      const unreachable = unreachableGroups(def)
      return ok(
        {
          flow: flow.name,
          externalId: flow.externalId,
          status: flow.status,
          reading: wantPublished ? 'published' : 'draft',
          // Draft and live diverging is the single most confusing state to be
          // in, so it is stated rather than left to be inferred.
          draftDiffersFromPublished:
            JSON.stringify(flow.definition) !== JSON.stringify(flow.published),
          startGroupId: def.startGroupId ?? def.groups[0]?.id,
          unreachableGroups: unreachable,
          groups: def.groups.map((g) => ({
            id: g.id,
            title: g.title,
            blocks: g.blocks.map((b) => ({
              id: b.id,
              type: b.type,
              says: summariseBlock(b),
              outgoingEdgeId: b.outgoingEdgeId ?? null,
              // A menu's options, each with where it leads. Without this the
              // assistant could read the labels but not re-route one of them.
              ...(choiceItems(b).length > 0
                ? {
                    options: choiceItems(b).map((it) => ({
                      id: it.id ?? null,
                      label: it.content ?? it.label ?? null,
                      toGroupId:
                        def.edges.find(
                          (e) =>
                            e.id === it.outgoingEdgeId ||
                            (e.from?.blockId === b.id && e.from?.itemId === it.id),
                        )?.to.groupId ?? null,
                    })),
                  }
                : {}),
            })),
          })),
          edges: def.edges.map((e) => ({
            id: e.id,
            fromBlockId: e.from?.blockId ?? null,
            fromGroupId: e.from?.groupId ?? null,
            ...(e.from?.itemId ? { fromOptionId: e.from.itemId } : {}),
            toGroupId: e.to?.groupId,
          })),
        },
        started,
      )
    },
  }

  private listInboxes: AdminToolDef = {
    name: 'list_inboxes',
    description:
      "Every inbox with its channel type, AI auto-reply mode, flow mode, attached bot, whether credentials are configured, and which automatic messages it sends (greeting, out-of-office, CSAT). Credential values are never returned. Check the automatic-message flags when diagnosing why a customer received something twice — a flow can carry its own business-hours branch, and the inbox-level out-of-office fires independently of it.",
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.inbox.findMany({
        where: { accountId: ctx.accountId },
        include: { agentBot: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
      })
      return ok(
        {
          inboxes: rows.map((i) => {
            const cfg = (i.channelConfig ?? {}) as Record<string, unknown>
            return {
              id: i.id,
              name: i.name,
              channelType: i.channelType,
              aiAutoreplyMode: i.aiAutoreplyMode,
              flowMode: i.flowMode,
              defaultFlowId: i.defaultFlowId,
              csatEnabled: i.csatEnabled,
              // Everything on this inbox that can message a customer without
              // an agent doing anything. Grouped so a double-message problem is
              // visible in one place: the inbox-level out-of-office fires
              // independently of any business-hours branch inside the flow,
              // and neither knows about the other.
              automaticMessages: {
                greetingEnabled: i.greetingEnabled,
                workingHoursEnabled: i.workingHoursEnabled,
                outOfOfficeMessageSet: Boolean(i.outOfOfficeMessage),
                csatOnResolve: i.csatEnabled,
              },
              agentBot: i.agentBot,
              // Presence, not value — see SECRET_KEYS.
              credentialsConfigured: Boolean(cfg.accessToken),
              inboundConfigured: Boolean(cfg.appSecret),
            }
          }),
        },
        started,
      )
    },
  }

  private listMembers: AdminToolDef = {
    name: 'list_members',
    description: 'Everyone with access to this account, their role and whether active.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.accountMember.findMany({
        where: { accountId: ctx.accountId },
        include: { user: { select: { id: true, email: true, fullName: true } } },
      })
      return ok(
        {
          members: rows.map((m) => ({
            userId: m.userId,
            email: m.user.email,
            fullName: m.user.fullName,
            role: m.role,
            isActive: m.isActive,
          })),
        },
        started,
      )
    },
  }

  private listFlows: AdminToolDef = {
    name: 'list_flows',
    description:
      'Conversation flows: name, status, whether published, and which inboxes use each as their default. Archived flows are excluded by default — they are hidden in the product too — pass includeArchived to see them. Use before suggesting a flow change.',
    input_schema: {
      type: 'object',
      properties: { includeArchived: { type: 'boolean' } },
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      // Match what an operator sees. The flow list hides ARCHIVED, so an
      // assistant that counts them is contradicting the screen the admin is
      // looking at — and on an imported account that is most of the list.
      const includeArchived = input.includeArchived === true
      const [flows, inboxes, archivedCount] = await Promise.all([
        this.prisma.flow.findMany({
          where: {
            accountId: ctx.accountId,
            ...(includeArchived ? {} : { status: { not: 'ARCHIVED' as const } }),
          },
          select: { id: true, name: true, externalId: true, published: true, status: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.inbox.findMany({
          where: { accountId: ctx.accountId },
          select: { name: true, defaultFlowId: true },
        }),
        this.prisma.flow.count({
          where: { accountId: ctx.accountId, status: 'ARCHIVED' },
        }),
      ])
      return ok(
        {
          archivedCount,
          includingArchived: includeArchived,
          flows: flows.map((f) => ({
            id: f.id,
            name: f.name,
            externalId: f.externalId,
            status: f.status,
            published: f.published !== null,
            usedByInboxes: inboxes
              .filter((i) => i.defaultFlowId === f.id)
              .map((i) => i.name),
          })),
        },
        started,
      )
    },
  }

  private listAgentBots: AdminToolDef = {
    name: 'list_agent_bots',
    description:
      'AI agent bots: model, system-prompt length, auto-send confidence threshold, daily budget, tools enabled, and which inboxes they serve.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const bots = await this.prisma.agentBot.findMany({
        where: { accountId: ctx.accountId },
        include: { inboxes: { select: { name: true } } },
      })
      return ok(
        {
          bots: bots.map((b) => ({
            id: b.id,
            name: b.name,
            model: b.model,
            isActive: b.isActive,
            autoSafeConfidenceThreshold: b.autoSafeConfidenceThreshold,
            dailyBudgetUsd: Number(b.dailyBudgetUsd),
            systemPromptChars: b.systemPrompt.length,
            toolsEnabled: b.toolsEnabled,
            inboxes: b.inboxes.map((i) => i.name),
          })),
        },
        started,
      )
    },
  }

  private conversationStats: AdminToolDef = {
    name: 'conversation_stats',
    description:
      'Conversation and message volume over the last N days (default 7, max 90), split by status and by inbound/outbound. Use for "how busy are we", trends and drop-offs.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90 },
      },
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const days = Math.min(Math.max(Number(input.days ?? 7), 1), 90)
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const [byStatus, inbound, outbound, newConversations] = await Promise.all([
        this.prisma.conversation.groupBy({
          by: ['status'],
          where: { accountId: ctx.accountId },
          _count: { _all: true },
        }),
        this.prisma.message.count({
          where: { accountId: ctx.accountId, senderType: 'CONTACT', createdAt: { gte: since } },
        }),
        this.prisma.message.count({
          where: {
            accountId: ctx.accountId,
            senderType: { in: ['USER', 'AGENT_BOT'] },
            createdAt: { gte: since },
          },
        }),
        this.prisma.conversation.count({
          where: { accountId: ctx.accountId, createdAt: { gte: since } },
        }),
      ])
      return ok(
        {
          windowDays: days,
          conversationsByStatus: Object.fromEntries(
            byStatus.map((r) => [r.status, r._count._all]),
          ),
          newConversations,
          inboundMessages: inbound,
          outboundMessages: outbound,
        },
        started,
      )
    },
  }

  private aiSpend: AdminToolDef = {
    name: 'ai_spend',
    description:
      'AI spend this calendar month against the account budget, plus per-bot spend in the last 24h. Use for cost questions and budget headroom.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      const [account, month, sessions] = await Promise.all([
        this.prisma.account.findUnique({
          where: { id: ctx.accountId },
          select: { monthlyAiBudgetUsd: true },
        }),
        this.prisma.aiAgentSession.aggregate({
          where: { accountId: ctx.accountId, lastActiveAt: { gte: monthStart } },
          _sum: { totalCostUsd: true },
        }),
        this.prisma.aiAgentSession.count({ where: { accountId: ctx.accountId } }),
      ])
      const spent = Number(month._sum.totalCostUsd ?? 0)
      const cap = Number(account?.monthlyAiBudgetUsd ?? 0)
      return ok(
        {
          monthToDateUsd: spent,
          monthlyBudgetUsd: cap,
          remainingUsd: cap > 0 ? Math.max(0, cap - spent) : null,
          totalAiSessions: sessions,
        },
        started,
      )
    },
  }

  private recentAuditLog: AdminToolDef = {
    name: 'recent_audit_log',
    description:
      'Most recent administrative actions on this account (who did what, when). Use to answer "what changed recently" or "who did this".',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100)
      const rows = await this.prisma.auditLog.findMany({
        where: { accountId: ctx.accountId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { actor: { select: { email: true } } },
      })
      return ok(
        {
          entries: rows.map((r) => ({
            action: r.action,
            target: r.target,
            actor: r.actor?.email ?? null,
            metadata: r.metadata,
            at: r.createdAt.toISOString(),
          })),
        },
        started,
      )
    },
  }

  private listTeams: AdminToolDef = {
    name: 'list_teams',
    description: 'Teams and how many members each has. Use for routing and workload questions.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.team.findMany({
        where: { accountId: ctx.accountId },
        include: { members: { select: { userId: true } } },
        orderBy: { name: 'asc' },
      })
      return ok(
        { teams: rows.map((t) => ({ id: t.id, name: t.name, memberCount: t.members.length })) },
        started,
      )
    },
  }

  private listLabels: AdminToolDef = {
    name: 'list_labels',
    description: 'Labels defined on this account, with how many conversations carry each.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.label.findMany({
        where: { accountId: ctx.accountId },
        include: { conversationLabels: { select: { conversationId: true } } },
        orderBy: { title: 'asc' },
      })
      return ok(
        {
          labels: rows.map((l) => ({
            id: l.id, title: l.title, color: l.color,
            usedBy: l.conversationLabels.length,
          })),
        },
        started,
      )
    },
  }

  private listCannedResponses: AdminToolDef = {
    name: 'list_canned_responses',
    description: 'Saved replies agents can insert, by shortcut.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.cannedResponse.findMany({
        where: { accountId: ctx.accountId },
        orderBy: { shortcode: 'asc' },
        take: 200,
      })
      return ok(
        {
          responses: rows.map((r) => ({
            id: r.id, shortcode: r.shortcode, content: r.content.slice(0, 300),
          })),
        },
        started,
      )
    },
  }

  private listTickets: AdminToolDef = {
    name: 'list_tickets',
    description:
      'Support tickets raised by conversation flows, newest first. Optionally filter by status (OPEN, PENDING, RESOLVED, CLOSED).',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const status = typeof input.status === 'string' ? input.status : undefined
      const rows = await this.prisma.supportTicket.findMany({
        where: {
          accountId: ctx.accountId,
          ...(status ? { status: status as never } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Number(input.limit ?? 25), 1), 100),
      })
      return ok(
        {
          tickets: rows.map((t) => ({
            number: t.number, subject: t.subject, status: t.status,
            priority: t.priority, category: t.category,
            createdAt: t.createdAt.toISOString(),
          })),
        },
        started,
      )
    },
  }

  private csatSummary: AdminToolDef = {
    name: 'csat_summary',
    description:
      'Customer satisfaction: surveys sent, responded, average rating and the rating spread over the last N days (default 30, max 365).',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const days = Math.min(Math.max(Number(input.days ?? 30), 1), 365)
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      const rows = await this.prisma.csatSurvey.findMany({
        where: { accountId: ctx.accountId, promptedAt: { gte: since } },
        select: { rating: true, respondedAt: true },
      })
      const answered = rows.filter((r) => r.rating != null)
      const spread: Record<string, number> = {}
      for (const r of answered) spread[String(r.rating)] = (spread[String(r.rating)] ?? 0) + 1
      return ok(
        {
          windowDays: days,
          sent: rows.length,
          responded: answered.length,
          averageRating:
            answered.length > 0
              ? Number(
                  (answered.reduce((a, r) => a + (r.rating ?? 0), 0) / answered.length).toFixed(2),
                )
              : null,
          ratingSpread: spread,
        },
        started,
      )
    },
  }

  private searchConversations: AdminToolDef = {
    name: 'search_conversations',
    description:
      'Find recent conversations by message text. Returns the conversation, its status and a snippet — not the whole thread.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const q = String(input.query ?? '').trim()
      if (q.length < 2) return ok({ error: 'query too short' }, started)
      const rows = await this.prisma.message.findMany({
        where: {
          accountId: ctx.accountId,
          isPrivate: false,
          content: { contains: q, mode: 'insensitive' },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Number(input.limit ?? 10), 1), 25),
        include: { conversation: { select: { id: true, displayId: true, status: true } } },
      })
      return ok(
        {
          hits: rows.map((m) => ({
            conversationId: m.conversation.id,
            displayId: m.conversation.displayId,
            status: m.conversation.status,
            senderType: m.senderType,
            snippet: (m.content ?? '').slice(0, 200),
            at: m.createdAt.toISOString(),
          })),
        },
        started,
      )
    },
  }

  private listArticles: AdminToolDef = {
    name: 'list_articles',
    description:
      'Knowledge-base articles the AI agents answer from: title, status and whether each is embedded for semantic search.',
    input_schema: { type: 'object', properties: {} },
    critical: false,
    handler: async (_input, ctx) => {
      const started = Date.now()
      const rows = await this.prisma.article.findMany({
        where: { accountId: ctx.accountId },
        select: { id: true, slug: true, title: true, status: true, tags: true, updatedAt: true },
        orderBy: { title: 'asc' },
        take: 300,
      })
      return ok(
        {
          count: rows.length,
          articles: rows.map((a) => ({
            slug: a.slug, title: a.title, status: a.status, tags: a.tags,
            updatedAt: a.updatedAt.toISOString(),
          })),
        },
        started,
      )
    },
  }

  // ── Write ───────────────────────────────────────────────────────────

  private setInboxAiMode: AdminToolDef = {
    name: 'set_inbox_ai_mode',
    description:
      "Change an inbox's AI auto-reply mode. DRAFT means the bot only suggests and a human sends; AUTO_SAFE sends confident replies and holds the rest as suggestions; AUTO_FULL sends everything. Customer-visible.",
    input_schema: {
      type: 'object',
      properties: {
        inboxId: { type: 'string' },
        mode: { type: 'string', enum: ['DRAFT', 'AUTO_SAFE', 'AUTO_FULL'] },
      },
      required: ['inboxId', 'mode'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const inboxId = String(input.inboxId ?? '')
      const mode = String(input.mode ?? '')
      if (!['DRAFT', 'AUTO_SAFE', 'AUTO_FULL'].includes(mode)) {
        return ok({ error: `unknown mode "${mode}"` }, started)
      }
      // Scoped by accountId as well as id: an inbox from another workspace is
      // a miss, not an update.
      const existing = await this.prisma.inbox.findFirst({
        where: { id: inboxId, accountId: ctx.accountId },
        select: { id: true, name: true, aiAutoreplyMode: true },
      })
      if (!existing) return ok({ error: 'no such inbox in this account' }, started)
      await this.prisma.inbox.update({
        where: { id: existing.id },
        data: { aiAutoreplyMode: mode as 'DRAFT' | 'AUTO_SAFE' | 'AUTO_FULL' },
      })
      return ok(
        { inbox: existing.name, from: existing.aiAutoreplyMode, to: mode },
        started,
      )
    },
  }

  private setAgentBotConfig: AdminToolDef = {
    name: 'set_agent_bot_config',
    description:
      "Tune an agent bot: model, auto-send confidence threshold (0-100), daily budget in USD, or active state. Only the fields you pass change. Customer-visible — it alters what the bot sends.",
    input_schema: {
      type: 'object',
      properties: {
        botId: { type: 'string' },
        model: { type: 'string' },
        autoSafeConfidenceThreshold: { type: 'integer', minimum: 0, maximum: 100 },
        dailyBudgetUsd: { type: 'number', minimum: 0, maximum: 1000 },
        isActive: { type: 'boolean' },
      },
      required: ['botId'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const bot = await this.prisma.agentBot.findFirst({
        where: { id: String(input.botId ?? ''), accountId: ctx.accountId },
        select: { id: true, name: true },
      })
      if (!bot) return ok({ error: 'no such agent bot in this account' }, started)
      const data: Record<string, unknown> = {}
      if (typeof input.model === 'string') data.model = input.model
      if (input.autoSafeConfidenceThreshold !== undefined) {
        data.autoSafeConfidenceThreshold = Math.min(
          Math.max(Number(input.autoSafeConfidenceThreshold), 0),
          100,
        )
      }
      if (input.dailyBudgetUsd !== undefined) {
        data.dailyBudgetUsd = Math.min(Math.max(Number(input.dailyBudgetUsd), 0), 1000)
      }
      if (typeof input.isActive === 'boolean') data.isActive = input.isActive
      if (Object.keys(data).length === 0) {
        return ok({ error: 'nothing to change' }, started)
      }
      const updated = await this.prisma.agentBot.update({ where: { id: bot.id }, data })
      return ok(
        {
          bot: bot.name,
          applied: data,
          now: {
            model: updated.model,
            autoSafeConfidenceThreshold: updated.autoSafeConfidenceThreshold,
            dailyBudgetUsd: Number(updated.dailyBudgetUsd),
            isActive: updated.isActive,
          },
        },
        started,
      )
    },
  }

  private setMemberRole: AdminToolDef = {
    name: 'set_member_role',
    description:
      "Change a member's role, or deactivate them. Roles: ADMINISTRATOR, SUPERVISOR, AGENT.",
    input_schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        role: { type: 'string', enum: ['ADMINISTRATOR', 'SUPERVISOR', 'AGENT'] },
        isActive: { type: 'boolean' },
      },
      required: ['userId'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const userId = String(input.userId ?? '')
      const member = await this.prisma.accountMember.findUnique({
        where: { accountId_userId: { accountId: ctx.accountId, userId } },
      })
      if (!member) return ok({ error: 'no such member in this account' }, started)

      const role = typeof input.role === 'string' ? input.role : undefined
      const isActive =
        typeof input.isActive === 'boolean' ? input.isActive : undefined
      if (role && !['ADMINISTRATOR', 'SUPERVISOR', 'AGENT'].includes(role)) {
        return ok({ error: `unknown role "${role}"` }, started)
      }

      // Locking everyone out of their own workspace is not recoverable from
      // inside the product, so it is refused regardless of approval mode.
      const losesAdmin =
        member.role === 'ADMINISTRATOR' &&
        ((role !== undefined && role !== 'ADMINISTRATOR') || isActive === false)
      if (losesAdmin) {
        const admins = await this.prisma.accountMember.count({
          where: { accountId: ctx.accountId, role: 'ADMINISTRATOR', isActive: true },
        })
        if (admins <= 1) {
          return ok(
            { error: 'refused: this is the last active administrator' },
            started,
          )
        }
      }

      const updated = await this.prisma.accountMember.update({
        where: { accountId_userId: { accountId: ctx.accountId, userId } },
        data: {
          ...(role ? { role: role as 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' } : {}),
          ...(isActive !== undefined ? { isActive } : {}),
        },
      })
      return ok({ userId, role: updated.role, isActive: updated.isActive }, started)
    },
  }

  private setInboxFlowMode: AdminToolDef = {
    name: 'set_inbox_flow_mode',
    description:
      "Change how strictly an inbox's flow holds the conversation: GUIDED (customer can go off-script) or STRICT (only the flow's options are accepted).",
    input_schema: {
      type: 'object',
      properties: { inboxId: { type: 'string' }, mode: { type: 'string', enum: ['GUIDED', 'STRICT'] } },
      required: ['inboxId', 'mode'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const mode = String(input.mode ?? '')
      if (mode !== 'GUIDED' && mode !== 'STRICT') {
        return ok({ error: `unknown mode "${mode}" — use GUIDED or STRICT` }, started)
      }
      const inbox = await this.prisma.inbox.findFirst({
        where: { id: String(input.inboxId ?? ''), accountId: ctx.accountId },
      })
      if (!inbox) return ok({ error: 'no such inbox in this account' }, started)
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: { flowMode: mode as never },
      })
      return ok({ inbox: inbox.name, from: inbox.flowMode, to: mode }, started)
    },
  }

  private setCsatEnabled: AdminToolDef = {
    name: 'set_csat_enabled',
    description:
      'Turn the satisfaction survey on or off for an inbox. Enabling it means every resolved conversation sends a survey to a real customer, so it is always confirmed as a change to customer-facing behaviour.',
    input_schema: {
      type: 'object',
      properties: { inboxId: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['inboxId', 'enabled'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      if (typeof input.enabled !== 'boolean') return ok({ error: 'enabled must be true or false' }, started)
      const inbox = await this.prisma.inbox.findFirst({
        where: { id: String(input.inboxId ?? ''), accountId: ctx.accountId },
      })
      if (!inbox) return ok({ error: 'no such inbox in this account' }, started)
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: { csatEnabled: input.enabled },
      })
      return ok(
        {
          inbox: inbox.name,
          from: inbox.csatEnabled,
          to: input.enabled,
          note: input.enabled
            ? 'Resolved conversations will now send a survey link to the contact.'
            : 'No further surveys will be sent.',
        },
        started,
      )
    },
  }

  /**
   * Note what is NOT here: `adminAgentRequiresApproval`. That column decides
   * whether this assistant's critical calls wait for a human, so exposing it
   * as a tool would make disarming the gate itself a gated action — one
   * approval click, and every future one is skipped. It is set in Settings
   * by a person, and nowhere else.
   */
  private setAccountSettings: AdminToolDef = {
    name: 'set_account_settings',
    description:
      'Change account-wide settings: display name, default locale, default timezone, and the monthly AI budget in USD (0 means uncapped). Only the fields supplied are changed. The approval setting for this assistant is deliberately not changeable here — an administrator sets that in Settings.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        defaultLocale: { type: 'string' },
        defaultTimezone: { type: 'string' },
        monthlyAiBudgetUsd: { type: 'number', minimum: 0, maximum: 10000 },
      },
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const data: Record<string, unknown> = {}
      if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim().slice(0, 120)
      if (typeof input.defaultLocale === 'string') {
        const locale = input.defaultLocale
        if (!LOCALES.includes(locale)) {
          return ok({ error: `unknown locale "${locale}" — use one of ${LOCALES.join(', ')}` }, started)
        }
        data.defaultLocale = locale
      }
      if (typeof input.defaultTimezone === 'string') {
        const tz = input.defaultTimezone
        // Reject a timezone Node can't resolve rather than storing a string
        // that silently breaks every scheduled report on the account.
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz })
        } catch {
          return ok({ error: `"${tz}" is not a valid IANA timezone` }, started)
        }
        data.defaultTimezone = tz
      }
      if (input.monthlyAiBudgetUsd != null) {
        const n = Number(input.monthlyAiBudgetUsd)
        if (!Number.isFinite(n) || n < 0) return ok({ error: 'monthlyAiBudgetUsd must be >= 0' }, started)
        data.monthlyAiBudgetUsd = Math.min(n, 10_000)
      }
      if (Object.keys(data).length === 0) return ok({ error: 'nothing to change' }, started)
      const updated = await this.prisma.account.update({
        where: { id: ctx.accountId },
        data: data as never,
        select: {
          name: true, defaultLocale: true, defaultTimezone: true, monthlyAiBudgetUsd: true,
        },
      })
      return ok(
        {
          changed: Object.keys(data),
          account: { ...updated, monthlyAiBudgetUsd: Number(updated.monthlyAiBudgetUsd) },
        },
        started,
      )
    },
  }

  private createLabel: AdminToolDef = {
    name: 'create_label',
    description: 'Add a label agents can apply to conversations. Colour is a hex like #6366F1.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 60 },
        color: { type: 'string' },
      },
      required: ['title'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const title = String(input.title ?? '').trim()
      if (!title) return ok({ error: 'title is required' }, started)
      const color = String(input.color ?? '#6366F1')
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return ok({ error: `"${color}" is not a 6-digit hex colour` }, started)
      }
      const existing = await this.prisma.label.findFirst({
        where: { accountId: ctx.accountId, title },
      })
      if (existing) return ok({ error: `a label called "${title}" already exists` }, started)
      const row = await this.prisma.label.create({
        data: { accountId: ctx.accountId, title: title.slice(0, 60), color },
      })
      return ok({ created: { id: row.id, title: row.title, color: row.color } }, started)
    },
  }

  private createCannedResponse: AdminToolDef = {
    name: 'create_canned_response',
    description:
      'Add a saved reply agents can insert by typing /shortcode in the composer.',
    input_schema: {
      type: 'object',
      properties: {
        shortcode: { type: 'string', minLength: 1, maxLength: 40 },
        content: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['shortcode', 'content'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const shortcode = String(input.shortcode ?? '').trim().replace(/^\//, '')
      const content = String(input.content ?? '').trim()
      if (!shortcode || !content) return ok({ error: 'shortcode and content are both required' }, started)
      if (!/^[a-z0-9_-]+$/i.test(shortcode)) {
        return ok({ error: 'shortcode may only contain letters, digits, - and _' }, started)
      }
      const existing = await this.prisma.cannedResponse.findFirst({
        where: { accountId: ctx.accountId, shortcode },
      })
      if (existing) return ok({ error: `/${shortcode} already exists` }, started)
      const row = await this.prisma.cannedResponse.create({
        data: { accountId: ctx.accountId, shortcode, content: content.slice(0, 4000) },
      })
      return ok({ created: { id: row.id, shortcode: row.shortcode } }, started)
    },
  }

  // ── Flow editing ────────────────────────────────────────────────────
  //
  // Every edit here writes the DRAFT (`definition`), never the live version.
  // Publishing is its own tool, so no single call can put untested changes in
  // front of a customer. Each edit is validated before it is saved: a flow
  // with a dangling edge does not throw, it silently strands people
  // mid-conversation.

  private updateFlowBlock: AdminToolDef = {
    name: 'update_flow_block',
    description:
      "Change a block in a flow's draft — its message text, or any option (fields are merged, so send only what changes). Use get_flow with a blockId first to see the current options. Does not affect the live flow until publish_flow.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        blockId: { type: 'string' },
        content: { type: 'string', description: 'New message text, for blocks that say something.' },
        options: { type: 'object', description: 'Option fields to merge into the block.' },
      },
      required: ['flowId', 'blockId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const found = findBlock(def, String(input.blockId ?? ''))
        if (!found) return `no block "${String(input.blockId)}" in this flow`
        const before = summariseBlock(found.block)
        // The summary is truncated for readability, so two different blocks
        // can summarise identically. Compare the whole block to decide
        // whether anything actually changed — reporting "before: X, after: X"
        // on a real edit reads as "nothing happened".
        const beforeFull = JSON.stringify(found.block)

        if (typeof input.content === 'string') {
          // Imported flows keep the text under `options`; native ones keep it
          // at the top level. Write wherever it already lives so the editor
          // and the engine both keep reading the same field.
          const opts = found.block.options as Record<string, unknown> | undefined
          if (opts && typeof opts === 'object' && 'content' in opts) {
            opts.content = input.content
          } else {
            found.block.content = input.content
          }
        }
        if (input.options && typeof input.options === 'object') {
          found.block.options = {
            ...((found.block.options as Record<string, unknown>) ?? {}),
            ...(input.options as Record<string, unknown>),
          }
        }
        if (typeof input.content !== 'string' && !input.options) return 'nothing to change'
        const changed = JSON.stringify(found.block) !== beforeFull
        const after = summariseBlock(found.block)
        return {
          blockId: found.block.id,
          changed,
          before,
          after,
          ...(changed && before === after
            ? { note: 'The change is past the preview cutoff, so before/after look alike here.' }
            : {}),
          ...(!changed ? { note: 'The block already had those values.' } : {}),
        }
      })
    },
  }

  private addFlowBlock: AdminToolDef = {
    name: 'add_flow_block',
    description:
      "Add a block to a group in a flow's draft. Give the group id from get_flow. The block is appended to the end of that group unless afterBlockId is given. A new block has no outgoing edge — use connect_flow_blocks if it should lead somewhere.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        groupId: { type: 'string' },
        type: {
          type: 'string',
          description:
            'Block type: "text" to say something, "choice input" for a menu (then call set_flow_choice_options), "text input" to ask a question.',
        },
        content: { type: 'string' },
        options: { type: 'object', description: 'Block options, e.g. { "variableId": "..." } to store an answer.' },
        afterBlockId: { type: 'string', description: 'Insert directly after this block.' },
      },
      required: ['flowId', 'groupId', 'type'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const group = def.groups.find((g) => g.id === String(input.groupId ?? ''))
        if (!group) return `no group "${String(input.groupId)}" in this flow`
        const id = newId('blk', allBlockIds(def))
        const block = {
          id,
          ...shapeNewBlock({
            type: String(input.type),
            ...(typeof input.content === 'string' ? { content: input.content } : {}),
            ...(input.options && typeof input.options === 'object'
              ? { options: input.options as Record<string, unknown> }
              : {}),
          }),
        }
        const after = typeof input.afterBlockId === 'string' ? input.afterBlockId : null
        const at = after ? group.blocks.findIndex((b) => b.id === after) : -1
        if (after && at < 0) return `no block "${after}" in group "${group.id}"`
        if (at >= 0) group.blocks.splice(at + 1, 0, block)
        else group.blocks.push(block)
        return { added: id, group: group.id, position: at >= 0 ? at + 1 : group.blocks.length - 1 }
      })
    },
  }

  private deleteFlowBlock: AdminToolDef = {
    name: 'delete_flow_block',
    description:
      "Remove a block from a flow's draft. Any edge starting at that block is removed with it, and any block pointing at those edges is detached, so the flow stays consistent — but check afterwards that nothing downstream became unreachable.",
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string' }, blockId: { type: 'string' } },
      required: ['flowId', 'blockId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const blockId = String(input.blockId ?? '')
        const found = findBlock(def, blockId)
        if (!found) return `no block "${blockId}" in this flow`
        found.group.blocks.splice(found.index, 1)

        // Leaving an edge that starts at a deleted block would be exactly the
        // dangling reference the validator rejects, so clean up in the same
        // operation rather than failing.
        const orphaned = def.edges.filter((e) => e.from?.blockId === blockId).map((e) => e.id)
        def.edges = def.edges.filter((e) => e.from?.blockId !== blockId)
        for (const g of def.groups) {
          for (const b of g.blocks) {
            if (typeof b.outgoingEdgeId === 'string' && orphaned.includes(b.outgoingEdgeId)) {
              b.outgoingEdgeId = null
            }
          }
        }
        return { deleted: blockId, removedEdges: orphaned }
      })
    },
  }

  private connectFlowBlocks: AdminToolDef = {
    name: 'connect_flow_blocks',
    description:
      "Make a block lead to a group in a flow's draft. Replaces that block's existing outgoing edge if it has one. Use get_flow to find the block and target group ids.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        fromBlockId: { type: 'string' },
        toGroupId: { type: 'string' },
      },
      required: ['flowId', 'fromBlockId', 'toGroupId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const fromId = String(input.fromBlockId ?? '')
        const toId = String(input.toGroupId ?? '')
        const found = findBlock(def, fromId)
        if (!found) return `no block "${fromId}" in this flow`
        if (!def.groups.some((g) => g.id === toId)) return `no group "${toId}" in this flow`

        const previous = def.edges.filter((e) => e.from?.blockId === fromId).map((e) => e.id)
        def.edges = def.edges.filter((e) => e.from?.blockId !== fromId)
        const edgeId = newId('edge', allEdgeIds(def))
        def.edges.push({ id: edgeId, from: { blockId: fromId }, to: { groupId: toId } })
        found.block.outgoingEdgeId = edgeId
        return { from: fromId, to: toId, edgeId, replaced: previous }
      })
    },
  }

  /*
   * Draft-only edits are not `critical`. Approval exists to protect customers,
   * and nothing in a draft reaches one until publish_flow, which stays
   * critical. Gating every draft edit made building a flow impossible in
   * practice: every one of the 36 accounts has approval on, and the loop stops
   * at each queued call, so a ten-step menu took ten round trips of approve.
   */
  private addFlowGroup: AdminToolDef = {
    name: 'add_flow_group',
    description:
      "Add a new group (a step of the flow) to a flow's draft, optionally with its first blocks. Returns the new group and block ids. To make something lead here, use connect_flow_blocks or set_flow_choice_options.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: 80 },
        blocks: {
          type: 'array',
          description: 'Blocks to create in order, e.g. [{ "type": "text", "content": "..." }].',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              content: { type: 'string' },
              options: { type: 'object' },
            },
            required: ['type'],
          },
        },
      },
      required: ['flowId', 'title'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const title = String(input.title ?? '').trim()
        if (!title) return 'a group needs a title'
        const blocks = Array.isArray(input.blocks)
          ? (input.blocks as Array<{ type?: unknown; content?: unknown; options?: unknown }>)
          : []
        if (blocks.some((b) => typeof b?.type !== 'string' || !b.type)) {
          return 'every block needs a type'
        }
        const made = addGroup(
          def,
          title,
          blocks.map((b) => ({
            type: String(b.type),
            ...(typeof b.content === 'string' ? { content: b.content } : {}),
            ...(b.options && typeof b.options === 'object'
              ? { options: b.options as Record<string, unknown> }
              : {}),
          })),
        )
        return { added: made.groupId, title, blocks: made.blockIds }
      })
    },
  }
  private renameFlowGroup: AdminToolDef = {
    name: 'rename_flow_group',
    description: "Rename a group (step) in a flow's draft.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        groupId: { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: 80 },
      },
      required: ['flowId', 'groupId', 'title'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        const group = def.groups.find((g) => g.id === String(input.groupId ?? ''))
        if (!group) return `no group "${String(input.groupId)}" in this flow`
        const title = String(input.title ?? '').trim()
        if (!title) return 'a group needs a title'
        const before = typeof group.title === 'string' ? group.title : null
        group.title = title
        return { group: group.id, before, after: title }
      })
    },
  }
  private deleteFlowGroup: AdminToolDef = {
    name: 'delete_flow_group',
    description:
      "Delete a group (step) and its blocks from a flow's draft. Every connection into or out of it is removed with it, so nothing is left pointing at it. The start group cannot be deleted.",
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string' }, groupId: { type: 'string' } },
      required: ['flowId', 'groupId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) =>
        removeGroup(def, String(input.groupId ?? '')),
      )
    },
  }
  private setFlowChoiceOptions: AdminToolDef = {
    name: 'set_flow_choice_options',
    description:
      "Set the options of a menu block (choice input) in a flow's draft, each with where it leads. Replaces the menu's previous options. Up to 10 options, labels up to 24 characters; 3 or fewer options of up to 20 characters show as WhatsApp buttons, anything else as a list. Create the destination groups first with add_flow_group.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        blockId: { type: 'string', description: 'The choice input block.' },
        question: {
          type: 'string',
          description: 'The question shown above the options (the WhatsApp message body).',
        },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'What the customer sees and taps.' },
              value: { type: 'string', description: 'Optional machine value stored when picked.' },
              toGroupId: { type: 'string', description: 'The group this option leads to.' },
            },
            required: ['label'],
          },
        },
      },
      required: ['flowId', 'blockId', 'options'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) => {
        if (!Array.isArray(input.options)) return 'options must be a list'
        const options = (input.options as Array<Record<string, unknown>>).map((o) => ({
          label: typeof o.label === 'string' ? o.label : '',
          ...(typeof o.value === 'string' && o.value ? { value: o.value } : {}),
          ...(typeof o.toGroupId === 'string' && o.toGroupId ? { toGroupId: o.toGroupId } : {}),
        })) as ChoiceOption[]
        return setChoiceOptions(
          def,
          String(input.blockId ?? ''),
          options,
          typeof input.question === 'string' ? input.question : undefined,
        )
      })
    },
  }
  private connectFlowOption: AdminToolDef = {
    name: 'connect_flow_option',
    description:
      "Make ONE option of a menu lead to a group in a flow's draft, replacing where it led before. Option ids come from get_flow or set_flow_choice_options.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        blockId: { type: 'string' },
        optionId: { type: 'string' },
        toGroupId: { type: 'string' },
      },
      required: ['flowId', 'blockId', 'optionId', 'toGroupId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) =>
        connectOption(
          def,
          String(input.blockId ?? ''),
          String(input.optionId ?? ''),
          String(input.toGroupId ?? ''),
        ),
      )
    },
  }
  private setFlowHoursCondition: AdminToolDef = {
    name: 'set_flow_hours_condition',
    description:
      "Make a flow take one path during opening hours and another outside them, in a flow's draft. Use it whenever what the customer should see depends on the day or time: a different menu after some units close, an out-of-hours message, a handoff only while the team is working. Give groupId to add the check at the end of that group, or blockId to change an existing opening-hours check. Each window is a set of weekdays with an opening and closing time (24h, HH:MM); a day can have two windows (morning and afternoon), and a day with none is closed. Create the two destination groups first with add_flow_group. To offer different menus at different times, chain checks: the 'closed' group of one check can hold the next check. Times are read in the given timezone, or the account's own when omitted.",
    input_schema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        groupId: { type: 'string', description: 'Add a new check at the end of this group.' },
        blockId: { type: 'string', description: 'Or change this existing opening-hours check.' },
        windows: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              days: {
                type: 'array',
                items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
              },
              open: { type: 'string', description: 'HH:MM, 24h. Example: "07:00".' },
              close: { type: 'string', description: 'HH:MM, 24h. Example: "12:00".' },
            },
            required: ['days', 'open', 'close'],
          },
        },
        timezone: { type: 'string', description: 'IANA name, e.g. America/Sao_Paulo. Defaults to the account timezone.' },
        openGroupId: { type: 'string', description: 'Where the flow goes during opening hours.' },
        closedGroupId: { type: 'string', description: 'Where the flow goes the rest of the time.' },
        openLabel: {
          type: 'string',
          description: "Short label for the open branch shown in the flow editor, in the user's language.",
        },
      },
      required: ['flowId', 'windows', 'openGroupId', 'closedGroupId'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const blockId = typeof input.blockId === 'string' && input.blockId ? input.blockId : undefined
      const groupId = typeof input.groupId === 'string' && input.groupId ? input.groupId : undefined
      if (!blockId && !groupId) {
        return ok({ error: 'give groupId to add an opening-hours check, or blockId to change one' }, started)
      }
      let timezone = typeof input.timezone === 'string' ? input.timezone.trim() : ''
      if (!timezone) {
        const account = await this.prisma.account.findUnique({
          where: { id: ctx.accountId },
          select: { defaultTimezone: true },
        })
        timezone = account?.defaultTimezone || 'UTC'
      }
      return this.editDraft(ctx.accountId, String(input.flowId ?? ''), started, (def) =>
        setHoursCondition(def, {
          ...(blockId ? { blockId } : { groupId }),
          windows: (Array.isArray(input.windows) ? input.windows : []) as HoursWindow[],
          timezone,
          openGroupId: String(input.openGroupId ?? ''),
          closedGroupId: String(input.closedGroupId ?? ''),
          ...(typeof input.openLabel === 'string' ? { openLabel: input.openLabel } : {}),
        }),
      )
    },
  }
  private publishFlow: AdminToolDef = {
    name: 'publish_flow',
    description:
      'Make a flow draft live. THIS REACHES REAL CUSTOMERS: the published version is what runs on WhatsApp for anyone in this flow. The previous live version is kept so revert_flow_draft can bring it back.',
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string' } },
      required: ['flowId'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const flow = await this.findFlow(ctx.accountId, String(input.flowId ?? ''))
      if (!flow) return ok({ error: 'no such flow in this account' }, started)
      if (!flow.definition) return ok({ error: 'this flow has no draft to publish' }, started)

      const issues = validateDefinition(flow.definition)
      if (issues.length > 0) {
        return ok({ error: 'the draft is not valid, so it was not published', issues }, started)
      }
      const def = flow.definition as unknown as Definition
      const unreachable = unreachableGroups(def)
      const changes = summariseChange(
        def,
        (flow.published as unknown as Definition | null) ?? null,
      )

      await this.prisma.flow.update({
        where: { id: flow.id },
        data: { published: flow.definition as never, status: 'PUBLISHED' },
      })
      const usedBy = await this.prisma.inbox.findMany({
        where: { accountId: ctx.accountId, defaultFlowId: flow.id },
        select: { name: true },
      })
      return ok(
        {
          published: flow.name,
          liveOnInboxes: usedBy.map((i) => i.name),
          changes,
          ...(unreachable.length > 0
            ? { warning: 'published, but some groups cannot be reached', unreachableGroups: unreachable }
            : {}),
        },
        started,
      )
    },
  }

  private revertFlowDraft: AdminToolDef = {
    name: 'revert_flow_draft',
    description:
      'Throw away the draft and restore it from the live published version. Use this to undo edits that have not been published, or after a bad publish to get back to a known state.',
    input_schema: {
      type: 'object',
      properties: { flowId: { type: 'string' } },
      required: ['flowId'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const flow = await this.findFlow(ctx.accountId, String(input.flowId ?? ''))
      if (!flow) return ok({ error: 'no such flow in this account' }, started)
      if (!flow.published) {
        return ok({ error: 'this flow has never been published, so there is nothing to restore' }, started)
      }
      await this.prisma.flow.update({
        where: { id: flow.id },
        data: { definition: flow.published as never },
      })
      return ok({ reverted: flow.name, note: 'The draft now matches the live version.' }, started)
    },
  }

  private setInboxDefaultFlow: AdminToolDef = {
    name: 'set_inbox_default_flow',
    description:
      'Choose which flow an inbox runs when a conversation starts. Customer-facing: the next person to message this inbox gets the new flow. Pass flowId null to detach.',
    input_schema: {
      type: 'object',
      properties: {
        inboxId: { type: 'string' },
        flowId: { type: ['string', 'null'] },
      },
      required: ['inboxId'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const inbox = await this.prisma.inbox.findFirst({
        where: { id: String(input.inboxId ?? ''), accountId: ctx.accountId },
      })
      if (!inbox) return ok({ error: 'no such inbox in this account' }, started)

      if (input.flowId === null) {
        await this.prisma.inbox.update({
          where: { id: inbox.id },
          data: { defaultFlowId: null },
        })
        return ok({ inbox: inbox.name, detached: true }, started)
      }
      const flow = await this.findFlow(ctx.accountId, String(input.flowId ?? ''))
      if (!flow) return ok({ error: 'no such flow in this account' }, started)
      // An inbox pointed at an unpublished flow runs nothing at all; the
      // runner requires `published`.
      if (!flow.published) {
        return ok({ error: `"${flow.name}" has never been published, so it would not run` }, started)
      }
      await this.prisma.inbox.update({
        where: { id: inbox.id },
        data: { defaultFlowId: flow.id },
      })
      return ok(
        {
          inbox: inbox.name,
          flow: flow.name,
          note:
            inbox.flowMode === 'OFF'
              ? 'This inbox has flowMode OFF, so the flow still will not run until that changes.'
              : undefined,
        },
        started,
      )
    },
  }

  private setAgentBotPrompt: AdminToolDef = {
    name: 'set_agent_bot_prompt',
    description:
      "Replace an AI bot's system prompt — the instructions that decide how it answers customers. Customer-facing and immediate on the next message. Read the current one from list_agent_bots first; this overwrites it whole rather than appending.",
    input_schema: {
      type: 'object',
      properties: {
        botId: { type: 'string' },
        systemPrompt: { type: 'string', minLength: 20, maxLength: 40000 },
      },
      required: ['botId', 'systemPrompt'],
    },
    critical: true,
    handler: async (input, ctx) => {
      const started = Date.now()
      const prompt = String(input.systemPrompt ?? '')
      if (prompt.trim().length < 20) {
        return ok({ error: 'a system prompt that short would make the bot behave unpredictably' }, started)
      }
      const bot = await this.prisma.agentBot.findFirst({
        where: { id: String(input.botId ?? ''), accountId: ctx.accountId },
      })
      if (!bot) return ok({ error: 'no such agent bot in this account' }, started)
      const inboxes = await this.prisma.inbox.findMany({
        where: { accountId: ctx.accountId, agentBotId: bot.id },
        select: { name: true },
      })
      await this.prisma.agentBot.update({
        where: { id: bot.id },
        data: { systemPrompt: prompt.slice(0, 40_000) },
      })
      return ok(
        {
          bot: bot.name,
          previousLength: bot.systemPrompt.length,
          newLength: prompt.length,
          affectsInboxes: inboxes.map((i) => i.name),
        },
        started,
      )
    },
  }

  private createFlow: AdminToolDef = {
    name: 'create_flow',
    description:
      'Create a new conversation flow with a single starting group and an opening message. It is created as a DRAFT and reaches nobody until publish_flow, and nothing until an inbox points at it. Build it up with add_flow_block and connect_flow_blocks.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        firstMessage: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['name', 'firstMessage'],
    },
    critical: false,
    handler: async (input, ctx) => {
      const started = Date.now()
      const name = String(input.name ?? '').trim()
      const first = String(input.firstMessage ?? '').trim()
      if (!name || !first) return ok({ error: 'name and firstMessage are both required' }, started)

      const existing = await this.prisma.flow.findFirst({
        where: { accountId: ctx.accountId, name, status: { not: 'ARCHIVED' } },
      })
      if (existing) {
        // This account already carries 27 duplicated flow names from an
        // import; adding more is how "which one is live?" becomes unanswerable.
        return ok({ error: `a flow called "${name}" already exists` }, started)
      }

      const definition = {
        groups: [
          {
            id: 'start',
            title: 'Start',
            blocks: [{ id: 'blk_1', type: 'text', content: first }],
          },
        ],
        edges: [],
        variables: [],
        startGroupId: 'start',
      }
      const issues = validateDefinition(definition)
      if (issues.length > 0) return ok({ error: 'could not build a valid flow', issues }, started)

      const row = await this.prisma.flow.create({
        data: {
          accountId: ctx.accountId,
          name: name.slice(0, 120),
          definition: definition as never,
          status: 'DRAFT',
        },
      })
      return ok(
        {
          created: { id: row.id, name: row.name },
          startGroupId: 'start',
          firstBlockId: 'blk_1',
          note: 'Draft only. It reaches nobody until you publish it and point an inbox at it.',
        },
        started,
      )
    },
  }

  // ── Shared flow helpers ─────────────────────────────────────────────

  /** Flows are addressable by cuid or by the externalId an admin actually sees. */
  private async findFlow(accountId: string, idOrExternal: string) {
    if (!idOrExternal) return null
    return this.prisma.flow.findFirst({
      where: {
        accountId,
        OR: [{ id: idOrExternal }, { externalId: idOrExternal }],
      },
    })
  }

  /**
   * Apply a mutation to a flow's draft and persist it only if the result is a
   * valid graph. The mutator works on a clone, so a rejected edit leaves the
   * stored flow untouched rather than half-applied.
   */
  private async editDraft(
    accountId: string,
    flowId: string,
    started: number,
    mutate: (def: Definition) => string | Record<string, unknown>,
  ): Promise<AdminToolResult> {
    const flow = await this.findFlow(accountId, flowId)
    if (!flow) return ok({ error: 'no such flow in this account' }, started)
    if (!flow.definition) return ok({ error: 'this flow has no draft to edit' }, started)

    const draft = clone(flow.definition as unknown as Definition)
    const result = mutate(draft)
    if (typeof result === 'string') return ok({ error: result }, started)

    const issues = validateDefinition(draft)
    if (issues.length > 0) {
      return ok({ error: 'that edit would leave the flow invalid, so nothing was saved', issues }, started)
    }
    await this.prisma.flow.update({
      where: { id: flow.id },
      data: { definition: draft as never },
    })
    const unreachable = unreachableGroups(draft)
    return ok(
      {
        ...result,
        flow: flow.name,
        savedTo: 'draft',
        publishHint: 'Not live yet — call publish_flow when you want customers to see it.',
        ...(unreachable.length > 0 ? { unreachableGroups: unreachable } : {}),
      },
      started,
    )
  }
}
