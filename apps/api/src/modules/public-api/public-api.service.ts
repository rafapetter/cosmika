import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@cosmika/db'
import type {
  PublicContactDTO,
  PublicContactsQuery,
  PublicConversationDTO,
  PublicConversationsQuery,
  PublicMessageDTO,
  PublicMessagesQuery,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'

const conversationInclude = {
  inbox: { select: { id: true, name: true, channelType: true } },
  contact: { select: { id: true, name: true, email: true, phoneNumber: true } },
  assignee: { select: { id: true, fullName: true, email: true } },
  team: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>

const messageInclude = {
  senderUser: { select: { id: true, fullName: true } },
  attachments: {
    select: { id: true, fileType: true, fileUrl: true, fileName: true, mimeType: true, fileSize: true },
  },
} satisfies Prisma.MessageInclude

type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>

function period(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: new Date(from) } : {}),
    ...(to ? { lt: new Date(to) } : {}),
  }
}

/** `take: limit + 1` → the overflow row says there is a next page. */
function paginate<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit)
  return { data, nextCursor: rows.length > limit ? data[data.length - 1]!.id : null }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * Read side of the public API v1. Scoped by the API key's account only:
 * there is no user, so no inbox/team visibility filter applies (an API key
 * is an admin-issued credential for the whole account).
 */
@Injectable()
export class PublicApiService {
  constructor(private readonly prisma: PrismaService) {}

  async listConversations(accountId: string, q: PublicConversationsQuery) {
    const createdAt = period(q.from, q.to)
    const rows = await this.prisma.conversation.findMany({
      where: {
        accountId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.inboxId ? { inboxId: q.inboxId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      include: conversationInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })
    const { data, nextCursor } = paginate(rows, q.limit)
    return { data: data.map((c) => this.toConversation(c)), nextCursor }
  }

  async listMessages(accountId: string, conversationRef: string, q: PublicMessagesQuery) {
    const conversation = await this.findConversation(accountId, conversationRef)
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        ...(q.includePrivate ? {} : { isPrivate: false }),
      },
      include: messageInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })
    const contact = await this.prisma.contact.findUnique({
      where: { id: conversation.contactId },
      select: { id: true, name: true },
    })
    const { data, nextCursor } = paginate(rows, q.limit)
    return { data: data.map((m) => this.toMessage(m, contact)), nextCursor }
  }

  async listContacts(accountId: string, q: PublicContactsQuery) {
    const createdAt = period(q.from, q.to)
    const search: Prisma.ContactWhereInput = q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { email: { contains: q.q, mode: 'insensitive' } },
            { phoneNumber: { contains: q.q } },
            { identifier: { contains: q.q } },
          ],
        }
      : {}
    const rows = await this.prisma.contact.findMany({
      where: { accountId, ...search, ...(createdAt ? { createdAt } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    })
    const { data, nextCursor } = paginate(rows, q.limit)
    return { data: data.map((c) => this.toContact(c)), nextCursor }
  }

  /** Accepts the internal id or the number shown on screen (`displayId`). */
  private async findConversation(accountId: string, ref: string) {
    const conversation = /^\d{1,9}$/.test(ref)
      ? await this.prisma.conversation.findUnique({
          where: { accountId_displayId: { accountId, displayId: Number(ref) } },
          select: { id: true, accountId: true, contactId: true },
        })
      : await this.prisma.conversation.findUnique({
          where: { id: ref },
          select: { id: true, accountId: true, contactId: true },
        })
    if (!conversation || conversation.accountId !== accountId) {
      throw new NotFoundException('Conversation not found')
    }
    return conversation
  }

  toConversation(c: ConversationRow): PublicConversationDTO {
    return {
      id: c.id,
      displayId: c.displayId,
      protocol: c.protocol ?? null,
      status: c.status,
      priority: c.priority,
      inbox: { id: c.inbox.id, name: c.inbox.name, channelType: c.inbox.channelType as PublicConversationDTO['inbox']['channelType'] },
      contact: c.contact,
      assignee: c.assignee,
      team: c.team,
      lastMessageAt: iso(c.lastMessageAt),
      resolvedAt: iso(c.resolvedAt),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }
  }

  toMessage(
    m: MessageRow,
    contact: { id: string; name: string | null } | null,
  ): PublicMessageDTO {
    const sender =
      m.senderType === 'USER' && m.senderUser
        ? { id: m.senderUser.id, name: m.senderUser.fullName }
        : m.senderType === 'CONTACT' && contact
          ? { id: contact.id, name: contact.name }
          : null
    return {
      id: m.id,
      conversationId: m.conversationId,
      senderType: m.senderType,
      sender,
      content: m.content,
      contentType: m.contentType,
      status: m.status,
      isPrivate: m.isPrivate,
      attachments: m.attachments,
      createdAt: m.createdAt.toISOString(),
    }
  }

  toContact(c: {
    id: string
    name: string | null
    email: string | null
    phoneNumber: string | null
    identifier: string | null
    customAttributes: Prisma.JsonValue
    createdAt: Date
    updatedAt: Date
  }): PublicContactDTO {
    const attrs = c.customAttributes
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phoneNumber: c.phoneNumber,
      identifier: c.identifier,
      customAttributes:
        attrs && typeof attrs === 'object' && !Array.isArray(attrs) ? (attrs as Record<string, unknown>) : {},
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }
  }
}
