import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  AccountMember,
  Attachment,
  Contact,
  Conversation,
  ConversationParticipant,
  ConversationStatus as PrismaConversationStatus,
  Inbox,
  Message,
  Prisma,
  Role,
  SlaPolicy,
  User,
} from '@cosmika/db'
import {
  AddParticipantInput,
  BulkConversationActionInput,
  ConversationSort,
  CreateConversationInput,
  InboundMessageInput,
  ListConversationsQuery,
  SendMessageInput,
  SendTemplateMessageInput,
  UpdateConversationInput,
  type ProtocolHistoryDTO,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { AnthropicClient } from '../ai/anthropic-client'
import { OrchestratorService } from '../ai/orchestrator.service'
import { FlowRunnerService } from '../flows/flow-runner.service'
import { ActivityService } from '../activity/activity.service'
import { AssignmentService } from '../assignment/assignment.service'
import { errBody } from '../../common/app-error'
import { RealtimeService } from '../realtime/realtime.service'
import { AutomationEngine } from '../automation/automation.engine'
import { WhatsappService } from '../whatsapp/whatsapp.service'
import { ChannelsService } from '../channels/channels.service'
import { PRIVILEGED_ROLES, conversationAccessWhere } from './conversation-access'
import { AttachmentsService } from '../attachments/attachments.service'
import { NotificationsService } from '../notifications/notifications.service'
import { WebhooksService } from '../webhooks/webhooks.service'
import { CsatService } from '../csat/csat.service'
import { closingVariables, renderClosingMessage } from './closing-message'
import { SlaService } from '../sla/sla.service'
import { UsageService } from '../usage/usage.service'

import { AutoReplyService } from './auto-reply.service'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_MESSAGES_PAGE = 200

export type ConversationDetail = Conversation & {
  contact: Contact
  inbox: Inbox & { slaPolicy: SlaPolicy | null }
  assignee: User | null
  participants: Array<ConversationParticipant & { user: User }>
}

/**
 * Initial control mode for a brand-new conversation. A conversation is
 * BOT-controlled when its inbox has an agent bot in an auto-reply mode
 * (AUTO_SAFE / AUTO_FULL); in DRAFT mode the bot only suggests and a human
 * sends, so control stays HUMAN. Used at the inbound-creation sites.
 */
export function initialControlMode(
  inbox: Pick<Inbox, 'agentBotId' | 'aiAutoreplyMode' | 'flowMode'>,
): 'BOT' | 'HUMAN' {
  // A deterministic flow drives the conversation from the first message.
  if (inbox.flowMode && inbox.flowMode !== 'OFF') return 'BOT'
  return inbox.agentBotId &&
    (inbox.aiAutoreplyMode === 'AUTO_SAFE' ||
      inbox.aiAutoreplyMode === 'AUTO_FULL')
    ? 'BOT'
    : 'HUMAN'
}

/**
 * Substitute a WhatsApp template body's {{1}}..{{n}} placeholders with the
 * supplied variables (1-indexed). Unmatched placeholders are left as-is.
 */
export function renderTemplateBody(body: string, variables: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, idx: string) => {
    const v = variables[Number(idx) - 1]
    return v === undefined ? whole : v
  })
}

/**
 * Map the UI sort option to a Prisma orderBy. Every option keeps `id` as the
 * final tiebreaker so cursor pagination stays stable.
 *
 * "Activity" means `lastMessageAt` (when a real message last landed), NOT
 * `updatedAt`. `updatedAt` bumps on any row write — a label, an assignment, a
 * bulk migration — so after the Nebula import it ordered the inbox by "when
 * did a batch job last touch this", putting 2021 threads above yesterday's.
 * `nulls: 'last'` keeps any un-backfilled row out of the way.
 */
export function orderByForSort(
  sort: ConversationSort | undefined,
): Prisma.ConversationOrderByWithRelationInput[] {
  switch (sort) {
    case 'ACTIVITY_ASC':
      return [{ lastMessageAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
    case 'CREATED_DESC':
      return [{ createdAt: 'desc' }, { id: 'desc' }]
    case 'CREATED_ASC':
      return [{ createdAt: 'asc' }, { id: 'asc' }]
    case 'PRIORITY_DESC':
      return [
        { priority: 'desc' },
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ]
    case 'ACTIVITY_DESC':
    default:
      // Newly-active conversations float to the top.
      return [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]
  }
}

/**
 * The message a list row should preview: the newest one the customer
 * actually exchanged, so neither an activity note nor a private message (an
 * internal note, an AI draft waiting for review). Conversation 8741
 * (2026-10-13) showed "[draft] Olá! Como posso ajudar?" in the list while
 * the customer's own last message, a "?" after 43 minutes of silence, was
 * what the desk needed to see.
 *
 * Falls back to the newest non-activity message (a thread with only internal
 * notes still says something), then to the newest of any kind.
 */
export function pickPreviewMessage<
  T extends { contentAttributes?: unknown; isPrivate?: boolean },
>(messages: T[] | undefined): T | undefined {
  if (!messages || messages.length === 0) return undefined
  const notActivity = (m: T) => {
    const attrs = (m.contentAttributes ?? {}) as Record<string, unknown>
    return !(attrs && typeof attrs === 'object' && 'activity' in attrs)
  }
  return (
    messages.find((m) => notActivity(m) && !m.isPrivate) ??
    messages.find(notActivity) ??
    messages[0]
  )
}

/** Whether a message is a desk activity note ("assigned to Ana by Bia"). */
function isActivityNote(contentAttributes: unknown): boolean {
  const attrs = (contentAttributes ?? {}) as Record<string, unknown>
  return Boolean(attrs) && typeof attrs === 'object' && 'activity' in attrs
}

export type ConversationListRow = Conversation & {
  contact: Pick<Contact, 'id' | 'name' | 'email' | 'phoneNumber' | 'customAttributes'>
  inbox: Pick<Inbox, 'id' | 'name' | 'channelType'> & {
    slaPolicy: SlaPolicy | null
  }
  messages: Array<
    Pick<
      Message,
      'content' | 'senderType' | 'isPrivate' | 'createdAt' | 'contentAttributes'
    >
  >
  conversationLabels: Array<{
    label: { id: string; title: string; color: string }
  }>
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: OrchestratorService,
    private readonly realtime: RealtimeService,
    private readonly automation: AutomationEngine,
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp: WhatsappService,
    private readonly attachmentsSvc: AttachmentsService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly csat: CsatService,
    private readonly sla: SlaService,
    private readonly usage: UsageService,
    private readonly activity: ActivityService,
    // forwardRef: auto-reply.service imports WhatsappService, which imports
    // this file back. Without it the param type resolves to undefined at
    // decoration time and Nest fails to boot ("dependency at index [12]").
    @Inject(forwardRef(() => AutoReplyService))
    private readonly autoReply: AutoReplyService,
    private readonly ai: AnthropicClient,
    @Inject(forwardRef(() => FlowRunnerService))
    private readonly flowRunner: FlowRunnerService,
    private readonly assignment: AssignmentService,
    // forwardRef: ChannelsService imports WhatsappService, which imports this
    // file back (same cycle as AutoReplyService above).
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
  ) {}

  /**
   * Parse `@<username>` tokens out of a message's content. Username is the
   * `local-part` of the user's email (everything before `@`). Returns the
   * set of usernames found (lowercased).
   */
  private parseMentionUsernames(content: string): string[] {
    /* c8 ignore next -- defensive: callers already guard `msg.content` truthy */
    if (!content) return []
    // \b@ won't work with the @ being a non-word char; use a manual boundary:
    // mention starts at beginning of string or after whitespace, then `@`,
    // then [a-z0-9._-]+ (email local-part chars).
    const re = /(^|\s)@([a-z0-9._-]+)\b/gi
    const out = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      /* c8 ignore next -- defensive: capture group 2 always matches when the regex matches */
      const u = (m[2] ?? '').toLowerCase()
      if (u) out.add(u)
    }
    return Array.from(out)
  }

  private async resolveMentionTargets(
    accountId: string,
    content: string,
  ): Promise<string[]> {
    const usernames = this.parseMentionUsernames(content)
    if (usernames.length === 0) return []
    // Match by email local-part on active account members.
    const members = await this.prisma.accountMember.findMany({
      where: { accountId, isActive: true },
      include: { user: { select: { id: true, email: true } } },
    })
    const matches: string[] = []
    for (const m of members) {
      /* c8 ignore next -- defensive: String.split always returns ≥1 element */
      const local = (m.user.email.split('@')[0] ?? '').toLowerCase()
      if (usernames.includes(local)) matches.push(m.user.id)
    }
    return matches
  }

  private async fireAutomation(
    event: 'CONVERSATION_CREATED' | 'MESSAGE_CREATED' | 'CONVERSATION_UPDATED',
    args: {
      accountId: string
      conversationId: string
      latestMessage?: {
        id: string
        content: string | null
        senderType: 'CONTACT' | 'USER' | 'AGENT_BOT' | 'SYSTEM'
      } | null
      isFirstMessage?: boolean
    },
  ): Promise<void> {
    try {
      await this.automation.evaluate({ event, ...args })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[automation] evaluate failed:`, m)
    }
  }

  private async getMembership(
    userId: string,
    accountId: string,
  ): Promise<AccountMember> {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return membership
  }

  private isPrivileged(role: Role): boolean {
    return PRIVILEGED_ROLES.includes(role)
  }

  /**
   * Filter that narrows a conversation query to what the user is allowed to
   * see. Privileged users see everything in the account; agents see only
   * inboxes they belong to, conversations they own, or where they're a
   * participant.
   */
  /** See conversation-access.ts: the one visibility rule for every reader. */
  private async accessFilter(
    membership: AccountMember,
  ): Promise<Prisma.ConversationWhereInput> {
    if (this.isPrivileged(membership.role)) {
      return { accountId: membership.accountId }
    }
    const account = await this.prisma.account.findUnique({
      where: { id: membership.accountId },
      select: { teamScopedVisibility: true },
    })
    return conversationAccessWhere(membership, account?.teamScopedVisibility === true)
  }

  /**
   * Build the OR clauses for free-text search. Matches message bodies and the
   * contact's name / email / phone (Nebula searches contact identity, not just
   * message content). A purely-numeric query also matches the conversation's
   * display number.
   */
  private buildSearchOr(q: string): Prisma.ConversationWhereInput[] {
    const clauses: Prisma.ConversationWhereInput[] = [
      { messages: { some: { content: { contains: q, mode: 'insensitive' } } } },
      { contact: { name: { contains: q, mode: 'insensitive' } } },
      { contact: { email: { contains: q, mode: 'insensitive' } } },
      { contact: { phoneNumber: { contains: q, mode: 'insensitive' } } },
    ]
    if (/^\d+$/.test(q)) {
      clauses.push({ displayId: Number(q) })
    }
    return clauses
  }

  /**
   * One timeline for a protocol: every conversation of the same contact that
   * shares this conversation's protocol, on any channel the member may see,
   * with their public messages in order. The contact told the website chat
   * something yesterday; the agent on WhatsApp reads it here without asking
   * again.
   */
  async protocolHistory(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<ProtocolHistoryDTO> {
    const { membership, conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    const conversations = conversation.protocol
      ? await this.prisma.conversation.findMany({
          where: {
            ...(await this.accessFilter(membership)),
            AND: [{ protocol: conversation.protocol, contactId: conversation.contactId }],
          },
          include: { inbox: { select: { name: true, channelType: true } } },
          orderBy: { createdAt: 'asc' },
          take: 20,
        })
      : [{ ...conversation, inbox: await this.prisma.inbox.findUniqueOrThrow({
          where: { id: conversation.inboxId },
          select: { name: true, channelType: true },
        }) }]
    const byId = new Map(conversations.map((c) => [c.id, c]))
    const messages = await this.prisma.message.findMany({
      where: { conversationId: { in: [...byId.keys()] }, isPrivate: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        conversationId: true,
        senderType: true,
        content: true,
        contentType: true,
        createdAt: true,
        contentAttributes: true,
      },
    })
    return {
      protocol: conversation.protocol ?? null,
      conversations: conversations.map((c) => ({
        id: c.id,
        displayId: c.displayId,
        status: c.status,
        inboxName: c.inbox.name,
        channelType: c.inbox.channelType,
        createdAt: c.createdAt.toISOString(),
      })),
      messages: messages
        // Activity notes describe the desk, not the conversation with the contact.
        .filter((m) => !isActivityNote(m.contentAttributes))
        .map((m) => {
          const c = byId.get(m.conversationId)!
          return {
            id: m.id,
            conversationId: m.conversationId,
            channelType: c.inbox.channelType,
            inboxName: c.inbox.name,
            senderType: m.senderType,
            content: m.content,
            contentType: m.contentType,
            createdAt: m.createdAt.toISOString(),
          }
        }),
    }
  }

  async assertConversationAccess(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<{ membership: AccountMember; conversation: Conversation }> {
    const membership = await this.getMembership(userId, accountId)
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        ...(await this.accessFilter(membership)),
      },
    })
    if (!conversation) throw new NotFoundException()
    return { membership, conversation }
  }

  /**
   * Discard an AI suggestion the agent doesn't want.
   *
   * Deliberately narrow: it will only delete a private AGENT_BOT message that
   * is still PENDING — i.e. exactly the shape the orchestrator writes for a
   * draft. It is NOT a general message-delete, so it can't be pointed at a
   * customer's message or at anything already delivered, however the id is
   * supplied.
   */
  async discardAgentDraft(
    userId: string,
    accountId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    const draft = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        accountId,
        senderType: 'AGENT_BOT',
        isPrivate: true,
        status: 'PENDING',
      },
      select: { id: true },
    })
    if (!draft) throw new NotFoundException('No such AI suggestion')
    await this.prisma.message.delete({ where: { id: draft.id } })
    await this.realtime.publish({
      type: 'MessageDeleted',
      accountId,
      conversationId,
      messageId: draft.id,
    })
  }

  // ─── list / get ──────────────────────────────────────────────────

  async list(
    userId: string,
    accountId: string,
    query: ListConversationsQuery,
  ): Promise<{ data: ConversationListRow[]; nextCursor: string | null }> {
    const membership = await this.getMembership(userId, accountId)
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const where: Prisma.ConversationWhereInput = {
      ...(await this.accessFilter(membership)),
      ...(query.status && { status: query.status }),
      ...(query.controlMode && { controlMode: query.controlMode }),
      ...(query.inboxId && { inboxId: query.inboxId }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(query.teamId && { teamId: query.teamId }),
      ...(query.labelId && {
        conversationLabels: { some: { labelId: query.labelId } },
      }),
      ...(query.contactId && { contactId: query.contactId }),
      ...(query.displayId !== undefined && { displayId: query.displayId }),
      ...(query.country && {
        contact: {
          additionalAttributes: {
            path: ['country_code'],
            equals: query.country,
          },
        },
      }),
      ...((query.createdAfter || query.createdBefore) && {
        createdAt: {
          ...(query.createdAfter && { gte: query.createdAfter }),
          ...(query.createdBefore && { lte: query.createdBefore }),
        },
      }),
      ...((query.lastActivityAfter || query.lastActivityBefore) && {
        updatedAt: {
          ...(query.lastActivityAfter && { gte: query.lastActivityAfter }),
          ...(query.lastActivityBefore && { lte: query.lastActivityBefore }),
        },
      }),
      ...(query.excludeId && { NOT: { id: query.excludeId } }),
      // Free-text search across message bodies + contact identity. Wrapped in
      // an AND so the OR doesn't clobber the access-scoping OR built by
      // accessFilter() for non-privileged members.
      ...(query.q && { AND: [{ OR: this.buildSearchOr(query.q) }] }),
    }
    const rows = await this.prisma.conversation.findMany({
      where,
      include: {
        contact: {
          select: {
            id: true,
            name: true,
            email: true,
            phoneNumber: true,
            customAttributes: true,
          },
        },
        inbox:   {
          select: {
            id: true,
            name: true,
            channelType: true,
            slaPolicy: true,
          },
        },
        messages: {
          // A few, not one: the preview should show the last real message,
          // skipping activity notes. Otherwise a row reads "Label X added by
          // Ana" while its timestamp (lastMessageAt) points at the actual
          // last message — two different events on one line. Filtering in
          // code avoids relying on JSON-path filter semantics in the hot
          // inbox query.
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            content: true,
            senderType: true,
            isPrivate: true,
            createdAt: true,
            contentAttributes: true,
          },
        },
        conversationLabels: {
          include: { label: { select: { id: true, title: true, color: true } } },
        },
      },
      orderBy: orderByForSort(query.sort),
      take: limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
    })
    let nextCursor: string | null = null
    if (rows.length > limit) {
      const next = rows.pop()
      nextCursor = next ? next.id : null
    }
    return { data: rows, nextCursor }
  }

  async getDetail(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<{
    conversation: ConversationDetail
    messageCount: number
    lastMessageAt: Date | null
    forwardedFrom: { id: string; displayId: number } | null
    messagingWindow: {
      open: boolean
      lastInboundAt: string | null
      expiresAt: string | null
    } | null
  }> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: true,
        inbox: { include: { slaPolicy: true } },
        assignee: true,
        participants: {
          include: { user: true },
          orderBy: { createdAt: 'asc' },
        },
        conversationLabels: {
          include: { label: { select: { id: true, title: true, color: true } } },
        },
      },
    })
    if (!conversation) throw new NotFoundException()
    const aggregate = await this.prisma.message.aggregate({
      where: { conversationId },
      _count: { _all: true },
      _max: { createdAt: true },
    })
    let forwardedFrom: { id: string; displayId: number } | null = null
    if (conversation.forwardedFromConversationId) {
      const src = await this.prisma.conversation.findUnique({
        where: { id: conversation.forwardedFromConversationId },
        select: { id: true, displayId: true },
      })
      if (src) forwardedFrom = src
    }
    // Only channels with a provider reply window report one; the rest are
    // always writable.
    const messagingWindow = await this.channels.windowFor(
      conversation.inbox.channelType,
      conversationId,
    )
    return {
      conversation,
      messageCount: aggregate._count._all,
      lastMessageAt: aggregate._max.createdAt ?? null,
      forwardedFrom,
      messagingWindow,
    }
  }

  /**
   * Permanently delete a conversation. All children (messages, participants,
   * AI session, labels, automation runs, CSAT) cascade via the schema's
   * onDelete rules.
   */
  async remove(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<void> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    await this.prisma.conversation.delete({ where: { id: conversationId } })
  }

  /**
   * Render a plain-text transcript of every public message in a conversation,
   * for download. Internal notes are excluded — a transcript is what the
   * customer saw.
   */
  async buildTranscript(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<{ displayId: number; filename: string; text: string }> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    })
    if (!conversation) throw new NotFoundException()
    const messages = await this.prisma.message.findMany({
      where: { conversationId, isPrivate: false },
      orderBy: { createdAt: 'asc' },
      select: {
        content: true,
        senderType: true,
        createdAt: true,
        contentType: true,
      },
    })
    const contactName =
      conversation.contact.name ||
      conversation.contact.email ||
      conversation.contact.phoneNumber ||
      'Contact'
    const speaker = (senderType: string): string => {
      switch (senderType) {
        case 'CONTACT':
          return contactName
        case 'AGENT_BOT':
          return 'Bot'
        case 'SYSTEM':
          return 'System'
        default:
          return 'Agent'
      }
    }
    const header = `Conversation #${conversation.displayId} — ${contactName}\n${'='.repeat(48)}\n`
    const body = messages
      .map((m) => {
        const ts = m.createdAt.toISOString()
        const text = m.content ?? `[${m.contentType.toLowerCase()}]`
        return `[${ts}] ${speaker(m.senderType)}: ${text}`
      })
      .join('\n')
    return {
      displayId: conversation.displayId,
      filename: `conversation-${conversation.displayId}.txt`,
      text: `${header}${body}\n`,
    }
  }

  // ─── create ──────────────────────────────────────────────────────

  async create(
    userId: string,
    accountId: string,
    input: CreateConversationInput,
  ): Promise<Conversation> {
    const membership = await this.getMembership(userId, accountId)
    // No plan check here, on purpose. This used to refuse with 402 when the
    // account was over its conversation caps, which contradicts sections 4.1
    // and 4.2 of the published terms ("nenhuma conversa é bloqueada") and hit
    // paid-up customers with "Payment Required" for opening a conversation.
    // Usage above the cap is billed as overage, not blocked; the customer is
    // warned at 90% and offered an upgrade at 100% (decision 3).

    return this.prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findUnique({
        where: { id: input.contactId },
        select: { id: true, accountId: true },
      })
      if (!contact || contact.accountId !== accountId) {
        throw new NotFoundException('Contact not found')
      }

      const inbox = await tx.inbox.findUnique({
        where: { id: input.inboxId },
      })
      if (!inbox || inbox.accountId !== accountId) {
        throw new NotFoundException('Inbox not found')
      }

      // Agents can only spin up conversations on inboxes they belong to.
      if (!this.isPrivileged(membership.role)) {
        const inboxMember = await tx.inboxMember.findUnique({
          where: {
            inboxId_userId: { inboxId: inbox.id, userId },
          },
        })
        if (!inboxMember) {
          throw new ForbiddenException(errBody('not_inbox_member', 'Not a member of this inbox'))
        }
      }

      // ContactInbox upsert: reuse if (contactId, inboxId) exists; on collision
      // with (inboxId, sourceId), fall through to the existing one.
      let contactInbox = await tx.contactInbox.findUnique({
        where: {
          contactId_inboxId: {
            contactId: input.contactId,
            inboxId: input.inboxId,
          },
        },
      })
      if (!contactInbox) {
        if (input.sourceId) {
          const bySource = await tx.contactInbox.findUnique({
            where: {
              inboxId_sourceId: {
                inboxId: input.inboxId,
                sourceId: input.sourceId,
              },
            },
          })
          if (bySource && bySource.contactId !== input.contactId) {
            throw new ConflictException(errBody('source_id_taken', 'sourceId already used by another contact on this inbox'))
          }
          contactInbox = bySource
        }
        if (!contactInbox) {
          contactInbox = await tx.contactInbox.create({
            data: {
              contactId: input.contactId,
              inboxId: input.inboxId,
              sourceId: input.sourceId,
            },
          })
        }
      }

      const conversation = await tx.conversation.create({
        data: {
          accountId,
          inboxId: input.inboxId,
          contactId: input.contactId,
          contactInboxId: contactInbox.id,
          status: 'OPEN',
          // An agent reached out from the desk: a real new conversation,
          // billable from creation.
          origin: 'AGENT',
          billableAt: new Date(),
        },
      })

      if (input.initialMessage) {
        const now = new Date()
        const msg = input.initialMessage
        const isContact = msg.senderType === 'CONTACT'
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            inboxId: input.inboxId,
            accountId,
            senderType: msg.senderType,
            senderUserId: isContact ? null : userId,
            senderContactId: isContact ? input.contactId : null,
            content: msg.content,
            contentType: msg.contentType,
            isPrivate: msg.isPrivate,
            status: 'SENT',
          },
        })
        if (msg.senderType === 'USER' && !msg.isPrivate) {
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { firstReplyAt: now, agentLastSeenAt: now },
          })
        }
      }

      const fresh = await tx.conversation.findUnique({
        where: { id: conversation.id },
      })
      if (!fresh) throw new NotFoundException()
      return fresh
    }).then(async (conversation) => {
      await this.realtime.publish({
        type: 'ConversationCreated',
        accountId,
        conversationId: conversation.id,
        inboxId: conversation.inboxId,
        contactId: conversation.contactId,
        createdAt: conversation.createdAt.toISOString(),
      })
      await this.fireAutomation('CONVERSATION_CREATED', {
        accountId,
        conversationId: conversation.id,
        isFirstMessage: input.initialMessage?.senderType === 'CONTACT',
      })
      void this.webhooks
        .dispatch(accountId, 'conversation.created', {
          conversationId: conversation.id,
          displayId: conversation.displayId,
          inboxId: conversation.inboxId,
          contactId: conversation.contactId,
        })
        .catch(() => undefined)
      return conversation
    })
  }

  // ─── patch (status + assignment) ─────────────────────────────────

  async update(
    userId: string,
    accountId: string,
    conversationId: string,
    input: UpdateConversationInput,
  ): Promise<Conversation> {
    const { conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )

    const now = new Date()
    const data: Prisma.ConversationUpdateInput = {}

    if (input.status !== undefined) {
      this.assertStaysClosed(conversation.status, input.status)
      data.status = input.status
      data.resolvedAt = this.deriveResolvedAt(conversation.status, input.status, conversation.resolvedAt, now)
    }
    if (input.priority !== undefined) data.priority = input.priority
    // Explicit control toggle (take over / hand back to the bot).
    if (input.controlMode !== undefined) data.controlMode = input.controlMode
    if (input.assigneeId !== undefined) {
      if (input.assigneeId === null) {
        data.assignee = { disconnect: true }
      } else {
        await this.ensureAccountMember(accountId, input.assigneeId)
        data.assignee = { connect: { id: input.assigneeId } }
        // Assigning a human is a takeover — flip control to HUMAN unless the
        // caller explicitly set controlMode in the same request.
        if (input.controlMode === undefined) data.controlMode = 'HUMAN'
      }
    }
    if (input.teamId !== undefined) {
      if (input.teamId === null) {
        data.team = { disconnect: true }
      } else {
        // Teams aren't created by Module 4. Validate existence + account scope.
        const team = await this.prisma.team.findUnique({
          where: { id: input.teamId },
          select: { accountId: true },
        })
        if (!team || team.accountId !== accountId) {
          throw new NotFoundException('Team not found')
        }
        data.team = { connect: { id: input.teamId } }
      }
    }
    if (input.aiSummary !== undefined) data.aiSummary = input.aiSummary
    if (input.aiSentiment !== undefined) data.aiSentiment = input.aiSentiment
    if (input.aiTags !== undefined) data.aiTags = input.aiTags
    if (input.customAttributes !== undefined) {
      data.customAttributes = input.customAttributes as Prisma.InputJsonValue
    }

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data,
    })

    // ── Activity notes in the transcript (Nebula parity) ────────────────
    // Resolved names are looked up only when something actually changed, so
    // a no-op PATCH costs nothing extra.
    // Resolve once: repeating the null-check at each call site multiplies
    // the same branch across every case below.
    const actorName = await this.activity.actorName(userId)
    const by = ActivityService.by(actorName)

    if (input.status !== undefined && input.status !== conversation.status) {
      const verb =
        updated.status === 'RESOLVED' ? 'resolved' : `marked ${updated.status.toLowerCase()}`
      await this.activity.log(updated, {
        type: 'status',
        text: `Conversation ${verb}${by}`,
        actorName,
        from: conversation.status,
        to: updated.status,
      })
    }

    if (input.assigneeId !== undefined && input.assigneeId !== conversation.assigneeId) {
      if (input.assigneeId === null) {
        await this.activity.log(updated, {
          type: 'assignee',
          text: `Conversation unassigned${by}`,
          actorName,
          from: conversation.assigneeId,
          to: null,
        })
      } else {
        const target = await this.prisma.user.findUnique({
          where: { id: input.assigneeId },
          select: { fullName: true },
        })
        const name = target?.fullName ?? 'an agent'
        // "assigned to themselves" reads better than "Ana assigned to Ana".
        const text =
          input.assigneeId === userId
            ? `${actorName ?? 'An agent'} self-assigned this conversation`
            : `Conversation assigned to ${name}${by}`
        await this.activity.log(updated, {
          type: 'assignee',
          text,
          actorName,
          from: conversation.assigneeId,
          to: name,
        })
      }
      // Tell the new owner, and retire the old one's pending bell. Outside the
      // if/else because the unassign branch above needs the second half.
      await this.notifications.createAssignment({
        accountId,
        conversationId,
        assigneeId: input.assigneeId,
        assignedByUserId: userId,
        previousAssigneeId: conversation.assigneeId,
      })
    }

    if (input.teamId !== undefined && input.teamId !== conversation.teamId) {
      if (input.teamId === null) {
        await this.activity.log(updated, {
          type: 'team',
          text: `Conversation removed from its team${by}`,
          actorName,
          from: conversation.teamId,
          to: null,
        })
      } else {
        const team = await this.prisma.team.findUnique({
          where: { id: input.teamId },
          select: { name: true },
        })
        await this.activity.log(updated, {
          type: 'team',
          text: `Conversation assigned to team ${team?.name ?? 'unknown'}${by}`,
          actorName,
          from: conversation.teamId,
          to: team?.name ?? null,
        })
      }
    }

    // A transfer note only means something next to a handover: a new
    // assignee or team. The receiver reads it in the thread, private.
    const handedOver =
      (input.assigneeId !== undefined && input.assigneeId !== conversation.assigneeId) ||
      (input.teamId !== undefined && input.teamId !== conversation.teamId)
    if (input.transferNote && handedOver) {
      const note = await this.prisma.message.create({
        data: {
          conversationId,
          inboxId: updated.inboxId,
          accountId,
          senderType: 'USER',
          senderUserId: userId,
          content: input.transferNote,
          contentType: 'TEXT',
          contentAttributes: { transferNote: true },
          isPrivate: true,
          status: 'SENT',
        },
      })
      await this.realtime.publish({
        type: 'MessageCreated',
        accountId,
        conversationId,
        inboxId: updated.inboxId,
        messageId: note.id,
        senderType: 'USER',
        content: note.content,
        isPrivate: true,
        createdAt: note.createdAt.toISOString(),
      })
    }

    if (input.priority !== undefined && input.priority !== conversation.priority) {
      await this.activity.log(updated, {
        type: 'priority',
        text: `Priority changed to ${updated.priority.toLowerCase()}${by}`,
        actorName,
        from: conversation.priority,
        to: updated.priority,
      })
    }

    // A new team distributes the conversation among its available members,
    // unless the same request chose the assignee (Nebula's AssignmentHandler).
    if (
      input.teamId &&
      input.teamId !== conversation.teamId &&
      input.assigneeId === undefined
    ) {
      const routed = await this.assignment.route(conversationId, 'team_changed')
      if (routed) updated.assigneeId = routed.assigneeId
    }

    if (input.status !== undefined && input.status !== conversation.status) {
      await this.realtime.publish({
        type: 'ConversationStatusChanged',
        accountId,
        conversationId,
        status: updated.status,
        changedAt: new Date().toISOString(),
      })
    }
    // Fire automation when any tracked field changed.
    if (
      input.status !== undefined ||
      input.priority !== undefined ||
      input.assigneeId !== undefined ||
      input.teamId !== undefined
    ) {
      await this.fireAutomation('CONVERSATION_UPDATED', {
        accountId,
        conversationId,
      })
    }
    if (input.status !== undefined && input.status !== conversation.status) {
      if (input.status === 'RESOLVED') {
        void this.webhooks
          .dispatch(accountId, 'conversation.resolved', {
            conversationId,
            displayId: updated.displayId,
            status: updated.status,
          })
          .catch(() => undefined)
        // The goodbye first, then the survey, so the contact reads them in
        // that order.
        await this.sendClosingMessage(conversationId, actorName)
        void this.csat
          .maybeCreateForResolvedConversation(conversationId)
          .catch(() => undefined)
      }
    }
    return updated
  }

  /**
   * The inbox's closing message (pilot, item 08), sent when an agent
   * resolves the conversation, with the contact's variables filled in.
   *
   * Written straight to the thread: the conversation is already RESOLVED, so
   * the reply path would refuse it as a write to a closed conversation, and
   * this is the one message that belongs after the close. The row goes in
   * first and its status settles from the real push, like every outbound.
   *
   * Never throws: the resolution has already happened and must stand.
   */
  private async sendClosingMessage(conversationId: string, agentName: string | null): Promise<void> {
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { inbox: { select: { name: true, closingMessage: true } }, contact: true },
      })
      const template = conv?.inbox.closingMessage
      if (!conv || !template) return
      const text = renderClosingMessage(template, closingVariables(conv, agentName))
      if (!text) return
      const msg = await this.prisma.message.create({
        data: {
          conversationId,
          inboxId: conv.inboxId,
          accountId: conv.accountId,
          senderType: 'AGENT_BOT',
          content: text,
          contentType: 'TEXT',
          status: 'PENDING',
        },
      })
      let status: 'SENT' | 'FAILED' = 'SENT'
      try {
        await this.maybePushOutboundToChannel(conv, text, [], msg.id)
      } catch (err) {
        status = 'FAILED'
        const m = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[closing] outbound failed for ${conversationId}:`, m)
      }
      // Only a row still PENDING: a delivery receipt that raced ahead of us
      // (delivered, read, failed) already holds the truer status.
      await this.prisma.message.updateMany({ where: { id: msg.id, status: 'PENDING' }, data: { status } })
      await this.realtime.publish({
        type: 'MessageCreated',
        accountId: conv.accountId,
        conversationId,
        inboxId: conv.inboxId,
        messageId: msg.id,
        senderType: 'AGENT_BOT',
        content: text,
        isPrivate: false,
        createdAt: msg.createdAt.toISOString(),
      })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[closing] closing message failed for ${conversationId}:`, m)
    }
  }

  /** Closing messages for a bulk resolve, in order. Never throws (each call doesn't). */
  private async sendClosingMessages(conversationIds: string[], agentName: string | null): Promise<void> {
    for (const id of conversationIds) await this.sendClosingMessage(id, agentName)
  }

  /**
   * Apply one action to many conversations atomically. Conversations the
   * caller can't access are silently skipped (returned count reflects only
   * the rows actually touched). Useful for the inbox bulk-action bar.
   */
  async bulk(
    userId: string,
    accountId: string,
    ids: string[],
    action: BulkConversationActionInput,
  ): Promise<{ updated: number }> {
    const membership = await this.getMembership(userId, accountId)
    // Filter to ids the caller can actually see + that belong to this account.
    const allowedWhere: Prisma.ConversationWhereInput = {
      ...(await this.accessFilter(membership)),
      id: { in: ids },
    }
    const visible = await this.prisma.conversation.findMany({
      where: allowedWhere,
      select: {
        id: true,
        status: true,
        resolvedAt: true,
        reopenedAt: true,
        // Needed to write the transcript activity notes below.
        inboxId: true,
        assigneeId: true,
        priority: true,
      },
    })
    if (visible.length === 0) return { updated: 0 }
    const visibleIds = visible.map((c) => c.id)
    const now = new Date()
    const bulkActorName = await this.activity.actorName(membership.userId)
    const bulkBy = ActivityService.by(bulkActorName)

    switch (action.type) {
      case 'STATUS': {
        // A closed conversation is never reopened, so a bulk "mark open" or
        // "mark pending" leaves the closed ones in the selection alone
        // instead of failing the whole action. The count returned says how
        // many were actually touched.
        const movable =
          action.status === 'RESOLVED'
            ? visible
            : visible.filter((c) => c.status !== 'RESOLVED')
        // Update each conversation independently so resolvedAt is derived
        // per-row.
        await this.prisma.$transaction(
          movable.map((c) =>
            this.prisma.conversation.update({
              where: { id: c.id },
              data: {
                status: action.status,
                resolvedAt: this.deriveResolvedAt(
                  c.status,
                  action.status,
                  c.resolvedAt,
                  now,
                ),
              },
            }),
          ),
        )
        // Fire realtime events outside the transaction.
        const closed: string[] = []
        for (const c of movable) {
          if (c.status !== action.status) {
            await this.realtime.publish({
              type: 'ConversationStatusChanged',
              accountId,
              conversationId: c.id,
              status: action.status,
              changedAt: now.toISOString(),
            })
            const verb =
              action.status === 'RESOLVED' ? 'resolved' : `marked ${action.status.toLowerCase()}`
            await this.activity.log(
              { id: c.id, inboxId: c.inboxId, accountId },
              {
                type: 'status',
                text: `Conversation ${verb}${bulkBy}`,
                actorName: bulkActorName,
                from: c.status,
                to: action.status,
              },
            )
            if (action.status === 'RESOLVED') closed.push(c.id)
          }
        }
        // A person resolved them, so each contact gets the same goodbye as
        // from the single resolve. In the background, one after another: a
        // hundred channel sends inside this request would outlast the proxy.
        if (closed.length > 0) void this.sendClosingMessages(closed, bulkActorName)
        return { updated: movable.length }
      }
      case 'PRIORITY': {
        const res = await this.prisma.conversation.updateMany({
          where: { id: { in: visibleIds } },
          data: { priority: action.priority },
        })
        for (const c of visible) {
          if (c.priority !== action.priority) {
            await this.activity.log(
              { id: c.id, inboxId: c.inboxId, accountId },
              {
                type: 'priority',
                text: `Priority changed to ${action.priority.toLowerCase()}${bulkBy}`,
                actorName: bulkActorName,
                from: c.priority,
                to: action.priority,
              },
            )
          }
        }
        return { updated: res.count }
      }
      case 'ASSIGN': {
        if (action.assigneeId !== null) {
          await this.ensureAccountMember(accountId, action.assigneeId)
        }
        const res = await this.prisma.conversation.updateMany({
          where: { id: { in: visibleIds } },
          data: { assigneeId: action.assigneeId },
        })
        // One name lookup for the whole batch, not one per conversation.
        const assignee =
          action.assigneeId === null
            ? null
            : await this.prisma.user.findUnique({
                where: { id: action.assigneeId },
                select: { fullName: true },
              })
        for (const c of visible) {
          if (c.assigneeId !== action.assigneeId) {
            await this.activity.log(
              { id: c.id, inboxId: c.inboxId, accountId },
              {
                type: 'assignee',
                text:
                  action.assigneeId === null
                    ? `Conversation unassigned${bulkBy}`
                    : `Conversation assigned to ${assignee?.fullName ?? 'an agent'}${bulkBy}`,
                actorName: bulkActorName,
                from: c.assigneeId,
                to: assignee?.fullName ?? null,
              },
            )
            // One per conversation: assigning 50 threads to someone really is
            // 50 things they now own. Grouping, if it ever annoys anyone,
            // belongs in the bell with real usage behind it.
            await this.notifications.createAssignment({
              accountId,
              conversationId: c.id,
              assigneeId: action.assigneeId,
              assignedByUserId: userId,
              previousAssigneeId: c.assigneeId,
            })
          }
        }
        return { updated: res.count }
      }
      case 'APPLY_LABEL': {
        // Verify label belongs to the account.
        const label = await this.prisma.label.findUnique({
          where: { id: action.labelId },
          select: { accountId: true },
        })
        if (!label || label.accountId !== accountId) {
          throw new NotFoundException('Label not found')
        }
        // createMany + skipDuplicates respects the unique join constraint.
        const res = await this.prisma.conversationLabel.createMany({
          data: visibleIds.map((cid) => ({
            conversationId: cid,
            labelId: action.labelId,
          })),
          skipDuplicates: true,
        })
        return { updated: res.count }
      }
      case 'REMOVE_LABEL': {
        const res = await this.prisma.conversationLabel.deleteMany({
          where: {
            conversationId: { in: visibleIds },
            labelId: action.labelId,
          },
        })
        return { updated: res.count }
      }
    }
  }

  private deriveResolvedAt(
    prev: PrismaConversationStatus,
    next: PrismaConversationStatus,
    existing: Date | null,
    now: Date,
  ): Date | null | undefined {
    if (next === 'RESOLVED' && prev !== 'RESOLVED') return now
    return existing
  }

  /**
   * A closed conversation is never reopened (published Terms, 4.2). Whoever
   * wants to talk to that contact again starts a new conversation, which is
   * what the plan's meter counts and what restarts the inbox flow.
   *
   * Throws 409 `conversation_closed` when a change would take a conversation
   * out of RESOLVED.
   */
  private assertStaysClosed(
    prev: PrismaConversationStatus,
    next: PrismaConversationStatus,
  ): void {
    if (prev === 'RESOLVED' && next !== 'RESOLVED') this.rejectClosed()
  }

  private rejectClosed(): never {
    throw new ConflictException(
      errBody(
        'conversation_closed',
        'This conversation is closed and cannot be reopened. Start a new conversation with this contact.',
      ),
    )
  }

  private async ensureAccountMember(accountId: string, userId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) {
      throw new NotFoundException('User is not a member of this account')
    }
  }

  // ─── auto-assign by availability ─────────────────────────────────

  /**
   * Distribute this conversation now, with the same rules as automatic
   * routing (see AssignmentService): an active member of the inbox (and of
   * the team, when set) whose schedule covers this moment, in round robin.
   * Re-picks even when someone is already assigned. Returns the assignee, or
   * null when nobody is available; the conversation is then left as it was.
   */
  async autoAssign(
    userId: string,
    accountId: string,
    conversationId: string,
  ): Promise<{ assigneeId: string | null }> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    const routed = await this.assignment.route(conversationId, 'manual', {
      force: true,
    })
    return { assigneeId: routed?.pickedId ?? null }
  }

  // ─── forwarding ──────────────────────────────────────────────────

  async forwardToInbox(
    userId: string,
    accountId: string,
    conversationId: string,
    input: {
      targetInboxId: string
      note?: string
      copyAssignee?: boolean
    },
  ): Promise<{ conversationId: string; displayId: number }> {
    const { membership, conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )

    return this.prisma.$transaction(async (tx) => {
      const inbox = await tx.inbox.findUnique({
        where: { id: input.targetInboxId },
      })
      if (!inbox || inbox.accountId !== accountId) {
        throw new NotFoundException('Target inbox not found')
      }
      if (!this.isPrivileged(membership.role)) {
        const inboxMember = await tx.inboxMember.findUnique({
          where: {
            inboxId_userId: { inboxId: inbox.id, userId },
          },
        })
        if (!inboxMember) {
          throw new ForbiddenException(errBody('not_target_inbox_member', 'Not a member of the target inbox'))
        }
      }

      let ci = await tx.contactInbox.findUnique({
        where: {
          contactId_inboxId: {
            contactId: conversation.contactId,
            inboxId: input.targetInboxId,
          },
        },
      })
      if (!ci) {
        ci = await tx.contactInbox.create({
          data: {
            contactId: conversation.contactId,
            inboxId: input.targetInboxId,
          },
        })
      }

      const next = await tx.conversation.create({
        data: {
          accountId,
          inboxId: input.targetInboxId,
          contactId: conversation.contactId,
          contactInboxId: ci.id,
          status: 'OPEN',
          assigneeId:
            input.copyAssignee && conversation.assigneeId
              ? conversation.assigneeId
              : null,
          forwardedFromConversationId: conversation.id,
          // A forward is the same conversation continuing on another inbox.
          // It was billed once already, when the contact first wrote in, so
          // `billableAt` stays null and the meter never counts it twice.
          origin: 'FORWARD',
        },
      })

      const transcriptLines: string[] = []
      const sourceMessages = await tx.message.findMany({
        where: { conversationId: conversation.id, isPrivate: false },
        orderBy: { createdAt: 'asc' },
        take: 200,
      })
      for (const m of sourceMessages) {
        const who =
          m.senderType === 'CONTACT'
            ? 'Contact'
            : m.senderType === 'AGENT_BOT'
              ? 'Bot'
              : 'Agent'
        transcriptLines.push(`[${m.createdAt.toISOString()}] ${who}: ${m.content}`)
      }
      const header = [
        `Forwarded from conversation #${conversation.displayId}.`,
        input.note ? `Note: ${input.note}` : null,
        '',
        '— Transcript —',
      ]
        .filter(Boolean)
        .join('\n')

      await tx.message.create({
        data: {
          conversationId: next.id,
          inboxId: input.targetInboxId,
          accountId,
          senderType: 'USER',
          senderUserId: userId,
          content: `${header}\n${transcriptLines.join('\n')}`,
          contentType: 'TEXT',
          isPrivate: true,
          status: 'SENT',
        },
      })

      return { conversationId: next.id, displayId: next.displayId, inboxId: input.targetInboxId, contactId: conversation.contactId }
    }).then(async (result) => {
      await this.realtime.publish({
        type: 'ConversationCreated',
        accountId,
        conversationId: result.conversationId,
        inboxId: result.inboxId,
        contactId: result.contactId,
        createdAt: new Date().toISOString(),
      })
      void this.webhooks
        .dispatch(accountId, 'conversation.created', {
          conversationId: result.conversationId,
          displayId: result.displayId,
          inboxId: result.inboxId,
          contactId: result.contactId,
          source: 'forward',
        })
        .catch(() => undefined)
      return {
        conversationId: result.conversationId,
        displayId: result.displayId,
      }
    })
  }

  // ─── participants ────────────────────────────────────────────────

  async addParticipant(
    userId: string,
    accountId: string,
    conversationId: string,
    input: AddParticipantInput,
  ): Promise<ConversationParticipant & { user: User }> {
    const { membership } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    if (!this.isPrivileged(membership.role) && input.userId !== userId) {
      throw new ForbiddenException(errBody('agents_add_self_only', 'Agents can only add themselves as participants'))
    }
    await this.ensureAccountMember(accountId, input.userId)
    const existing = await this.prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: { conversationId, userId: input.userId },
      },
    })
    if (existing) {
      throw new ConflictException(errBody('already_participant', 'User is already a participant'))
    }
    return this.prisma.conversationParticipant.create({
      data: { conversationId, userId: input.userId },
      include: { user: true },
    })
  }

  async removeParticipant(
    userId: string,
    accountId: string,
    conversationId: string,
    participantUserId: string,
  ): Promise<void> {
    const { membership } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    if (
      !this.isPrivileged(membership.role) &&
      participantUserId !== userId
    ) {
      throw new ForbiddenException(errBody('agents_remove_self_only', 'Agents can only remove themselves as participants'))
    }
    const existing = await this.prisma.conversationParticipant.findUnique({
      where: {
        conversationId_userId: {
          conversationId,
          userId: participantUserId,
        },
      },
    })
    if (!existing) throw new NotFoundException()
    await this.prisma.conversationParticipant.delete({
      where: {
        conversationId_userId: {
          conversationId,
          userId: participantUserId,
        },
      },
    })
  }

  // ─── messages ────────────────────────────────────────────────────

  async listMessages(
    userId: string,
    accountId: string,
    conversationId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ data: Array<Message & { attachments: Attachment[] }>; nextCursor: string | null }> {
    await this.assertConversationAccess(userId, accountId, conversationId)
    const take = Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_MESSAGES_PAGE)
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      include: { attachments: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    })
    let nextCursor: string | null = null
    if (rows.length > take) {
      const next = rows.pop()
      nextCursor = next ? next.id : null
    }
    return { data: rows, nextCursor }
  }

  async sendAgentMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<Message> {
    const { conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    if (input.inReplyToId) {
      const parent = await this.prisma.message.findUnique({
        where: { id: input.inReplyToId },
        select: { conversationId: true },
      })
      if (!parent || parent.conversationId !== conversationId) {
        throw new NotFoundException('inReplyToId not found in this conversation')
      }
    }
    // Replying to the contact in a closed conversation would reopen it. An
    // internal note is still fine: it reaches nobody and changes no status.
    if (conversation.status === 'RESOLVED' && !input.isPrivate) this.rejectClosed()

    const now = new Date()
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          inboxId: conversation.inboxId,
          accountId,
          senderType: 'USER',
          senderUserId: userId,
          content: input.content,
          contentType: input.contentType,
          contentAttributes:
            (input.contentAttributes as Prisma.InputJsonValue | undefined) ??
            {},
          status: 'SENT',
          isPrivate: input.isPrivate,
          inReplyToId: input.inReplyToId,
        },
      })

      const convoPatch: Prisma.ConversationUpdateInput = {
        agentLastSeenAt: now,
      }
      if (!input.isPrivate && conversation.firstReplyAt === null) {
        convoPatch.firstReplyAt = now
      }
      // A human sending a public reply is a takeover — flip control to HUMAN.
      // Internal notes don't count (the bot may still be driving the convo).
      if (!input.isPrivate && conversation.controlMode === 'BOT') {
        convoPatch.controlMode = 'HUMAN'
      }
      await tx.conversation.update({
        where: { id: conversationId },
        data: convoPatch,
      })

      return message
    }).then(async (msg) => {
      // Attach uploaded files (draft attachments) to this new message.
      let attachments: Attachment[] = []
      if (input.attachmentIds && input.attachmentIds.length > 0) {
        attachments = await this.attachmentsSvc.attachToMessage(
          accountId,
          msg.id,
          input.attachmentIds,
        )
      }
      // Parse @-mentions and notify targeted account members. Mentions only
      // matter on internal notes today (external messages may also contain
      // @-handles but they're not meant for our internal users).
      if (input.isPrivate && msg.content) {
        try {
          const targetIds = await this.resolveMentionTargets(
            accountId,
            msg.content,
          )
          if (targetIds.length > 0) {
            await this.notifications.createMentions({
              accountId,
              conversationId,
              messageId: msg.id,
              mentionedByUserId: userId,
              targetUserIds: targetIds,
            })
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`[notifications] mention parse failed:`, m)
        }
      }
      await this.realtime.publish({
        type: 'MessageCreated',
        accountId,
        conversationId,
        inboxId: msg.inboxId,
        messageId: msg.id,
        senderType: msg.senderType,
        content: msg.content,
        isPrivate: msg.isPrivate,
        createdAt: msg.createdAt.toISOString(),
      })
      // Push to WhatsApp Cloud API when this inbox is WHATSAPP-typed and the
      // message is public (not an internal note). Attachment-only messages
      // have no content but still have to reach the contact. Errors are logged
      // but don't fail the agent's send — the agent already saw a 200 in their
      // UI.
      let sent = msg
      if (!input.isPrivate && (msg.content || attachments.length > 0)) {
        try {
          await this.maybePushOutboundToChannel(
            conversation,
            msg.content ?? '',
            attachments,
            msg.id,
          )
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`[whatsapp] outbound failed for ${conversationId}:`, m)
          // The message is in the thread but never reached the contact. Mark
          // it so the agent sees a failure instead of a delivered tick — the
          // push is awaited before we respond, so the caller gets the truth.
          sent = await this.prisma.message
            .update({ where: { id: msg.id }, data: { status: 'FAILED' } })
            .catch(() => msg)
        }
      }
      if (!input.isPrivate) {
        void this.webhooks
          .dispatch(accountId, 'message.created', {
            conversationId,
            messageId: msg.id,
            senderType: msg.senderType,
            content: msg.content,
          })
          .catch(() => undefined)
      }
      return sent
    })
  }

  /**
   * Re-attempt delivery of a message that failed to reach the channel.
   *
   * Only a FAILED, public, outbound message qualifies — a customer's inbound
   * message or an already-delivered reply can never be "retried" into a
   * second send however the id is supplied. The row is reused rather than
   * duplicated, so the thread doesn't grow a copy per attempt.
   *
   * Nebula's equivalent had a trap worth naming: its retry cleared the status
   * but kept `source_id`, which the anti-echo guard then treated as
   * already-sent, so retries silently did nothing for 250 messages. Cosmika
   * never stamps an outbound id, so there's nothing to clear — but the shape
   * of that bug (retry reports success, nothing leaves) is why this method
   * settles the status from the actual push result instead of assuming.
   */
  async retryMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    messageId: string,
  ): Promise<Message> {
    const { conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    const msg = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        accountId,
        status: 'FAILED',
        isPrivate: false,
        senderType: { in: ['USER', 'AGENT_BOT'] },
      },
      include: { attachments: true },
    })
    if (!msg) throw new NotFoundException('No failed message to retry')

    try {
      await this.maybePushOutboundToChannel(
        conversation,
        msg.content ?? '',
        msg.attachments,
        msg.id,
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[whatsapp] retry failed for ${messageId}:`, m)
      // Leave it FAILED so the agent can try again rather than seeing a tick
      // for something that still hasn't arrived.
      return msg
    }
    const sent = await this.prisma.message.update({
      where: { id: msg.id },
      data: { status: 'SENT' },
    })
    await this.realtime.publish({
      type: 'MessageCreated',
      accountId,
      conversationId,
      inboxId: sent.inboxId,
      messageId: sent.id,
      senderType: sent.senderType,
      content: sent.content,
      isPrivate: sent.isPrivate,
      createdAt: sent.createdAt.toISOString(),
    })
    return sent
  }

  /**
   * The agent reacts to a message (or takes the reaction off, `emoji: ''`),
   * as the contact can. Only WhatsApp has reactions, and only messages that
   * went through it (they carry a wamid) can be reacted to. A closed
   * conversation is read-only towards the contact, so it refuses there too.
   */
  async reactToMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    messageId: string,
    emoji: string,
  ): Promise<Message> {
    const { conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    if (conversation.status === 'RESOLVED') this.rejectClosed()
    const target = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, accountId, isPrivate: false },
    })
    if (!target?.externalSourceId) {
      throw new NotFoundException(errBody('reaction_unavailable', 'This message cannot be reacted to'))
    }
    const to = await this.whatsapp.recipientForConversation(conversationId)
    if (!to) {
      throw new BadRequestException(errBody('reaction_unavailable', 'This message cannot be reacted to'))
    }
    try {
      await this.whatsapp.sendReaction(conversation.inboxId, to, target.externalSourceId, emoji)
    } catch (err) {
      if (err instanceof HttpException) throw err
      throw new BadRequestException(
        errBody('reaction_failed', err instanceof Error ? err.message : String(err)),
      )
    }
    return this.whatsapp.setReaction(target, 'business', emoji, {
      at: new Date().toISOString(),
      userId,
    })
  }

  /**
   * Send a pre-approved WhatsApp template (HSM) into a conversation. This is
   * the only way to reach a contact proactively or outside the 24h window.
   * Renders the template body with the supplied variables for the thread, and
   * pushes a `type: template` Cloud API message. Treated as a human public
   * reply (flips control to HUMAN). Refused on a closed conversation: reaching
   * that contact again means starting a new one.
   */
  async sendTemplateMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    input: SendTemplateMessageInput,
  ): Promise<Message> {
    const { conversation } = await this.assertConversationAccess(
      userId,
      accountId,
      conversationId,
    )
    const template = await this.prisma.whatsappTemplate.findUnique({
      where: { id: input.templateId },
    })
    if (!template || template.inboxId !== conversation.inboxId) {
      throw new NotFoundException('Template not found for this conversation')
    }
    if (conversation.status === 'RESOLVED') this.rejectClosed()
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(errBody('template_not_approved', 'Template is not approved'))
    }
    if (input.variables.length !== template.variableCount) {
      throw new BadRequestException(errBody('template_variable_count', `Template expects ${template.variableCount} variable(s), got ${input.variables.length}`))
    }
    const rendered = renderTemplateBody(template.body, input.variables)

    const now = new Date()
    return this.prisma
      .$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId,
            inboxId: conversation.inboxId,
            accountId,
            senderType: 'USER',
            senderUserId: userId,
            content: rendered,
            contentType: 'TEXT',
            contentAttributes: {
              whatsappTemplate: {
                name: template.name,
                language: template.language,
                variables: input.variables,
              },
            } as Prisma.InputJsonValue,
            status: 'SENT',
            isPrivate: false,
          },
        })
        const convoPatch: Prisma.ConversationUpdateInput = {
          agentLastSeenAt: now,
        }
        if (conversation.firstReplyAt === null) convoPatch.firstReplyAt = now
        if (conversation.controlMode === 'BOT') convoPatch.controlMode = 'HUMAN'
        await tx.conversation.update({
          where: { id: conversationId },
          data: convoPatch,
        })
        return message
      })
      .then(async (msg) => {
        await this.realtime.publish({
          type: 'MessageCreated',
          accountId,
          conversationId,
          inboxId: msg.inboxId,
          messageId: msg.id,
          senderType: msg.senderType,
          content: msg.content,
          isPrivate: msg.isPrivate,
          createdAt: msg.createdAt.toISOString(),
        })
        // Push the template via the Cloud API (WHATSAPP inboxes only).
        try {
          const inbox = await this.prisma.inbox.findUnique({
            where: { id: conversation.inboxId },
          })
          if (inbox?.channelType === 'WHATSAPP') {
            const to = await this.whatsapp.recipientForConversation(conversationId)
            if (to) {
              await this.whatsapp.sendTemplate(
                inbox.id,
                to,
                template.name,
                template.language,
                input.variables,
              )
            }
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`[whatsapp] template send failed for ${conversationId}:`, m)
        }
        void this.webhooks
          .dispatch(accountId, 'message.created', {
            conversationId,
            messageId: msg.id,
            senderType: msg.senderType,
            content: msg.content,
          })
          .catch(() => undefined)
        return msg
      })
  }

  /**
   * Channel-aware outbound dispatch: push-based channels (WhatsApp, and the
   * ones added behind ChannelsService) get the text and attachments; pull-based
   * ones (WEB_WIDGET, EMAIL, API) deliver via their own paths.
   */
  private async maybePushOutboundToChannel(
    conversation: Conversation,
    content: string,
    attachments: Attachment[],
    /** Message row to stamp with the provider id(s), so delivery receipts match. */
    messageId?: string,
  ): Promise<void> {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: conversation.inboxId },
    })
    if (!inbox) return
    await this.channels.deliverMessage(
      conversation,
      inbox.channelType,
      content,
      attachments,
      messageId,
    )
  }

  async createInboundMessage(
    userId: string,
    accountId: string,
    conversationId: string,
    input: InboundMessageInput,
  ): Promise<Message> {
    const membership = await this.getMembership(userId, accountId)
    if (!this.isPrivileged(membership.role)) {
      throw new ForbiddenException(errBody('inbound_requires_role', 'Inbound message endpoint requires Administrator or Supervisor role'))
    }
    // An integration recording an inbound names the conversation itself, so it
    // is told when that one is closed and must open a new one. (A missing
    // conversation is reported by ingestExternalInbound below.)
    const target = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { status: true },
    })
    if (target?.status === 'RESOLVED') this.rejectClosed()
    return this.ingestExternalInbound({
      accountId,
      conversationId,
      content: input.content,
      contentType: input.contentType,
      contentAttributes: input.contentAttributes,
      externalSourceId: input.externalSourceId,
      inReplyToId: input.inReplyToId,
    })
  }

  /**
   * Internal inbound message ingestion — bypasses the role check that
   * `createInboundMessage` enforces, so external webhook services (e.g.
   * the WhatsApp channel) can deliver messages on behalf of a contact
   * without an authenticated user session. Caller is responsible for
   * validating that the inbound came from a trusted source.
   */
  async ingestExternalInbound(args: {
    accountId: string
    conversationId: string
    content: string
    contentType?:
      | 'TEXT'
      | 'IMAGE'
      | 'VIDEO'
      | 'AUDIO'
      | 'FILE'
      | 'LOCATION'
      | 'CONTACT_CARD'
      | 'CARDS'
      | 'QUICK_REPLIES'
    contentAttributes?: unknown
    externalSourceId?: string
    inReplyToId?: string
    /** Draft attachments the channel already stored for this message. */
    attachmentIds?: string[]
  }): Promise<Message> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: args.conversationId, accountId: args.accountId },
    })
    if (!conversation) throw new NotFoundException()

    const priorInboundCount = await this.prisma.message.count({
      where: { conversationId: args.conversationId, senderType: 'CONTACT' },
    })
    const isFirstMessage = priorInboundCount === 0

    const now = new Date()
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: args.conversationId,
          inboxId: conversation.inboxId,
          accountId: args.accountId,
          senderType: 'CONTACT',
          senderContactId: conversation.contactId,
          content: args.content,
          contentType: args.contentType ?? 'TEXT',
          contentAttributes:
            (args.contentAttributes as Prisma.InputJsonValue | undefined) ??
            {},
          externalSourceId: args.externalSourceId,
          inReplyToId: args.inReplyToId,
          status: 'DELIVERED',
        },
      })
      // Link in the same transaction, so the message is never observable
      // without its file: MessageCreated and the AI turn both run after
      // commit and must see the attachment. Scoped to this account's drafts.
      if (args.attachmentIds?.length) {
        await tx.attachment.updateMany({
          where: {
            id: { in: args.attachmentIds },
            accountId: args.accountId,
            messageId: null,
          },
          data: { messageId: message.id },
        })
      }

      const convoPatch: Prisma.ConversationUpdateInput = {
        contactLastSeenAt: now,
      }
      // A broadcast row becomes a billable conversation the moment the
      // contact answers it, and not before: a campaign to 10.000 numbers
      // nobody replied to is 10.000 rows and zero new conversations, which is
      // what the terms say and what the customer expects to be charged for
      // (decision 16). Stamped once — a second reply must not move the date
      // into a later month.
      if (conversation.origin === 'BROADCAST' && conversation.billableAt === null) {
        convoPatch.billableAt = now
      }
      // Last resort, not a feature. Channels pick a conversation still in
      // progress before calling this, and `createInboundMessage` refuses a
      // closed one, so this only happens when the conversation was closed in
      // the instant between that choice and this write. Losing the
      // customer's message, or filing it where nobody looks, would be worse
      // than the one conversation that reopens.
      if (conversation.status === 'RESOLVED') {
        convoPatch.status = 'OPEN'
        convoPatch.reopenedAt = now
        convoPatch.resolvedAt = null
      }
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: convoPatch,
      })

      await tx.contact.update({
        where: { id: conversation.contactId },
        data: { lastActivityAt: now },
      })

      return message
    }).then(async (msg) => {
      await this.realtime.publish({
        type: 'MessageCreated',
        accountId: args.accountId,
        conversationId: args.conversationId,
        inboxId: msg.inboxId,
        messageId: msg.id,
        senderType: msg.senderType,
        content: msg.content,
        isPrivate: msg.isPrivate,
        createdAt: msg.createdAt.toISOString(),
      })
      // Arbiter: a deterministic flow gets first refusal on the turn. If it
      // handled the message (STRICT mode), the AI agent stands down.
      let flowHandled = false
      try {
        flowHandled = await this.flowRunner.handleInbound({
          accountId: args.accountId,
          conversationId: args.conversationId,
          content: args.content,
          interactiveReplyId:
            (
              args.contentAttributes as
                | { interactiveReplyId?: string | null }
                | undefined
            )?.interactiveReplyId ?? null,
        })
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[flow] runner failed for ${args.conversationId}:`, m)
      }
      if (!flowHandled) {
        try {
          await this.orchestrator.handleInbound({
            accountId: args.accountId,
            conversationId: args.conversationId,
            inboundMessageContent: args.content,
          })
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          // eslint-disable-next-line no-console
          console.error(`[ai] orchestrator failed for ${args.conversationId}:`, m)
        }
      }
      // Distribute a new or reopened conversation to an available agent. Runs
      // after the flow and the AI agent had their turn: a conversation the
      // bot still drives is skipped (its handoff routes it), and a handoff in
      // this very turn has already been routed, which makes this a no-op.
      const reopened = conversation.status === 'RESOLVED'
      if (isFirstMessage || reopened) {
        await this.assignment.route(
          args.conversationId,
          reopened ? 'conversation_reopened' : 'conversation_created',
        )
      }
      // Inbox auto-replies (greeting / out-of-office). Skipped when a flow
      // already answered this turn so customers never get two greetings.
      await this.autoReply.maybeAutoReply({
        conversationId: args.conversationId,
        accountId: args.accountId,
        isFirstMessage,
        flowHandled,
      })
      await this.rescueSilentBotTurn(
        args.accountId,
        args.conversationId,
        msg.createdAt,
      )
      await this.fireAutomation('MESSAGE_CREATED', {
        accountId: args.accountId,
        conversationId: args.conversationId,
        latestMessage: {
          id: msg.id,
          content: msg.content,
          senderType: msg.senderType,
        },
        isFirstMessage,
      })
      void this.webhooks
        .dispatch(args.accountId, 'message.created', {
          conversationId: args.conversationId,
          messageId: msg.id,
          senderType: msg.senderType,
          content: msg.content,
        })
        .catch(() => undefined)
      return msg
    })
  }

  /**
   * Last line of defence: a customer wrote, the bot had the conversation, and
   * nothing came back.
   *
   * Every silent-bot defect ends the same way no matter its cause — a flow
   * parked on a step it never announced, a link cycle that unwound to nothing,
   * an integration that threw, an AI agent that produced no reply. The
   * customer is left staring at their own message and nobody on the desk knows,
   * because a conversation the bot owns raises no notification. Conversation
   * 8739 sat like that for seven hours, and it was a sales lead.
   *
   * So we assert the outcome rather than each cause: if the turn produced no
   * outbound message, the bot is not driving this conversation any more. The
   * orchestrator's handoff takes it from there (control, assignee, a note for
   * the desk, a line for the contact), and its `route` falls back to an agent
   * off shift, which is precisely the 01:45 case.
   *
   * Only reached from the inbound path, where the message is by construction
   * a public CONTACT one, so there is nothing to re-check about `since`.
   *
   * Never throws: this runs after the customer's message is already saved.
   */
  private async rescueSilentBotTurn(
    accountId: string,
    conversationId: string,
    since: Date,
  ): Promise<void> {
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          controlMode: true,
          inbox: {
            select: { flowMode: true, defaultFlowId: true, agentBotId: true },
          },
        },
      })
      // A handoff during this turn already put a human in charge.
      if (!conv || conv.controlMode !== 'BOT') return
      // An inbox with neither a flow nor an AI agent has no bot to be silent:
      // it is a plain human queue, and every message there would trip this.
      const hasBot =
        (conv.inbox.flowMode !== 'OFF' && conv.inbox.defaultFlowId !== null) ||
        conv.inbox.agentBotId !== null
      if (!hasBot) return
      const answered = await this.prisma.message.count({
        where: {
          conversationId,
          senderType: { in: ['AGENT_BOT', 'USER'] },
          createdAt: { gte: since },
        },
      })
      if (answered > 0) return

      await this.orchestrator.handOffSilentTurn({ accountId, conversationId })
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[bot] silent-turn rescue failed for ${conversationId}:`, m)
    }
  }

  // ─── DTO mappers ─────────────────────────────────────────────────

  toSummaryDTO(c: Conversation | ConversationListRow) {
    const hydrated = c as Partial<ConversationListRow>
    const lastMessage = pickPreviewMessage(hydrated.messages)
    // Display the SAME field the list sorts by, so the order can never look
    // wrong against the timestamp shown on the row.
    const lastActivity = c.lastMessageAt ?? lastMessage?.createdAt ?? c.updatedAt
    return {
      id: c.id,
      displayId: c.displayId,
      protocol: c.protocol ?? null,
      accountId: c.accountId,
      inboxId: c.inboxId,
      contactId: c.contactId,
      contactInboxId: c.contactInboxId,
      assigneeId: c.assigneeId,
      teamId: c.teamId,
      status: c.status,
      controlMode: c.controlMode,
      priority: c.priority,
      agentLastSeenAt: c.agentLastSeenAt?.toISOString() ?? null,
      contactLastSeenAt: c.contactLastSeenAt?.toISOString() ?? null,
      firstReplyAt: c.firstReplyAt?.toISOString() ?? null,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      reopenedAt: c.reopenedAt?.toISOString() ?? null,
      aiSummary: c.aiSummary,
      aiSentiment: c.aiSentiment,
      aiTags: c.aiTags,
      customAttributes: (c.customAttributes ?? {}) as Record<string, unknown>,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      contact: hydrated.contact
        ? {
            id: hydrated.contact.id,
            name: hydrated.contact.name ?? null,
            email: hydrated.contact.email ?? null,
            phoneNumber: hydrated.contact.phoneNumber ?? null,
            customAttributes:
              (hydrated.contact.customAttributes as
                | Record<string, unknown>
                | undefined) ?? undefined,
          }
        : null,
      inbox: hydrated.inbox
        ? {
            id: hydrated.inbox.id,
            name: hydrated.inbox.name,
            channelType: hydrated.inbox.channelType,
          }
        : null,
      lastMessage: lastMessage
        ? {
            content: lastMessage.content,
            senderType: lastMessage.senderType,
            isPrivate: lastMessage.isPrivate,
            createdAt: lastMessage.createdAt.toISOString(),
          }
        : null,
      /* c8 ignore start -- defensive: lastActivity is always a Date (c.updatedAt asserted Date by line 1352) */
      lastActivityAt:
        lastActivity instanceof Date
          ? lastActivity.toISOString()
          : (lastActivity as string),
      /* c8 ignore stop */
      labels: (hydrated.conversationLabels ?? []).map((cl) => ({
        id: cl.label.id,
        title: cl.label.title,
        color: cl.label.color,
      })),
      slaStatus: this.sla.computeStatus(
        c,
        (hydrated.inbox as { slaPolicy?: SlaPolicy | null } | undefined)
          ?.slaPolicy ?? null,
      ),
    }
  }

  toDetailDTO(
    c: ConversationDetail,
    messageCount: number,
    lastMessageAt: Date | null,
    forwardedFrom: { id: string; displayId: number } | null,
    messagingWindow: {
      open: boolean
      lastInboundAt: string | null
      expiresAt: string | null
    } | null = null,
  ) {
    return {
      messagingWindow,
      ...this.toSummaryDTO(c),
      contact: {
        id: c.contact.id,
        name: c.contact.name,
        email: c.contact.email,
        phoneNumber: c.contact.phoneNumber,
        identifier: c.contact.identifier,
        blockedAt: c.contact.blockedAt?.toISOString() ?? null,
        customAttributes: (c.contact.customAttributes ?? {}) as Record<
          string,
          unknown
        >,
      },
      inbox: {
        id: c.inbox.id,
        name: c.inbox.name,
        channelType: c.inbox.channelType,
      },
      assignee: c.assignee
        ? {
            id: c.assignee.id,
            email: c.assignee.email,
            fullName: c.assignee.fullName,
          }
        : null,
      participants: c.participants.map((p) => this.toParticipantDTO(p)),
      messageCount,
      lastMessageAt: lastMessageAt?.toISOString() ?? null,
      forwardedFrom,
    }
  }

  toParticipantDTO(p: ConversationParticipant & { user: User }) {
    return {
      id: p.id,
      userId: p.userId,
      user: {
        id: p.user.id,
        email: p.user.email,
        fullName: p.user.fullName,
      },
      createdAt: p.createdAt.toISOString(),
    }
  }

  toMessageDTO(m: Message & { attachments?: Attachment[] }) {
    return {
      id: m.id,
      conversationId: m.conversationId,
      inboxId: m.inboxId,
      accountId: m.accountId,
      senderType: m.senderType,
      senderUserId: m.senderUserId,
      senderAgentBotId: m.senderAgentBotId,
      senderContactId: m.senderContactId,
      content: m.content,
      contentType: m.contentType,
      contentAttributes: (m.contentAttributes ?? {}) as Record<string, unknown>,
      status: m.status,
      isPrivate: m.isPrivate,
      externalSourceId: m.externalSourceId,
      inReplyToId: m.inReplyToId,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        fileType: a.fileType,
        fileUrl: a.fileUrl,
        fileName: a.fileName,
        fileSize: a.fileSize,
        mimeType: a.mimeType,
      })),
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    }
  }
}
