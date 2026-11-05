import { forwardRef, Inject, Injectable } from '@nestjs/common'
import type { Contact, ContactInbox, Conversation, Inbox, Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { ConversationsService, initialControlMode } from '../conversations/conversations.service'
import { RealtimeService } from '../realtime/realtime.service'

/** Who wrote in, as the channel identifies them. */
export type InboundSender = {
  /** The channel's stable id for this person in this inbox (Telegram chat id, Messenger PSID…). */
  sourceId: string
  /** Account-wide contact identifier, `<channel>:<id>`. */
  identifier: string
  /**
   * The sender's name, or a lookup for it. A lookup only runs when the
   * contact has no name yet, so channels that must ask the provider (Meta)
   * don't spend a call on every message.
   */
  name?: string | null | (() => Promise<string | null>)
  additionalAttributes?: Record<string, unknown>
}

export type ResolvedInbound =
  | { kind: 'blocked' }
  | { kind: 'ok'; contact: Contact; contactInbox: ContactInbox; conversation: Conversation }

/**
 * The inbound half every channel after WhatsApp shares: find or create the
 * contact and its ContactInbox, then the conversation in progress.
 *
 * Same rules as WhatsappService.processInboundMessage, written once:
 * - a blocked contact's message is dropped;
 * - only a conversation still in progress is reused; a closed one never
 *   reopens, a new message starts a new (billable) conversation (Terms 4.2);
 * - "look, then create" runs under a per-ContactInbox advisory lock, so two
 *   messages arriving together cannot open two conversations.
 */
@Injectable()
export class ChannelInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Inject(forwardRef(() => ConversationsService))
    private readonly conversations: ConversationsService,
  ) {}

  /** True when this provider message was already stored (providers retry). */
  async alreadyIngested(inboxId: string, externalSourceId: string): Promise<boolean> {
    const existing = await this.prisma.message.findFirst({
      where: { inboxId, externalSourceId },
      select: { id: true },
    })
    return existing !== null
  }

  async resolve(inbox: Inbox, sender: InboundSender): Promise<ResolvedInbound> {
    const accountId = inbox.accountId
    const bySource = await this.prisma.contactInbox.findUnique({
      where: { inboxId_sourceId: { inboxId: inbox.id, sourceId: sender.sourceId } },
      include: { contact: true },
    })
    let contactInbox: ContactInbox | null = bySource
    let contact: Contact | null = bySource?.contact ?? null

    if (!contact) {
      contact = await this.prisma.contact.findFirst({
        where: { accountId, identifier: sender.identifier },
      })
    }
    const nameOf = async (): Promise<string | null> =>
      typeof sender.name === 'function' ? sender.name() : (sender.name ?? null)
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          accountId,
          name: await nameOf(),
          identifier: sender.identifier,
          ...(sender.additionalAttributes && {
            additionalAttributes: sender.additionalAttributes as Prisma.InputJsonValue,
          }),
        },
      })
    } else if (sender.name && !contact.name) {
      const name = await nameOf()
      if (name) {
        contact = await this.prisma.contact.update({
          where: { id: contact.id },
          data: { name },
        })
      }
    }
    if (contact.blockedAt) return { kind: 'blocked' }

    if (!contactInbox) {
      contactInbox =
        (await this.prisma.contactInbox.findUnique({
          where: { contactId_inboxId: { contactId: contact.id, inboxId: inbox.id } },
        })) ??
        (await this.prisma.contactInbox.create({
          data: { contactId: contact.id, inboxId: inbox.id, sourceId: sender.sourceId },
        }))
    }

    const contactInboxId = contactInbox.id
    const contactId = contact.id
    const { conversation, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${contactInboxId}))`
      const inProgress = await tx.conversation.findFirst({
        where: { accountId, inboxId: inbox.id, contactId, status: { not: 'RESOLVED' } },
        orderBy: { createdAt: 'desc' },
      })
      if (inProgress) return { conversation: inProgress, created: false }
      const fresh = await tx.conversation.create({
        data: {
          accountId,
          inboxId: inbox.id,
          contactId,
          contactInboxId,
          status: 'OPEN',
          controlMode: initialControlMode(inbox),
          // The contact wrote in: billable from the first message.
          origin: 'INBOUND',
          billableAt: new Date(),
        },
      })
      return { conversation: fresh, created: true }
    })
    if (created) {
      await this.realtime.publish({
        type: 'ConversationCreated',
        accountId,
        conversationId: conversation.id,
        inboxId: inbox.id,
        contactId,
        createdAt: conversation.createdAt.toISOString(),
      })
    }
    return { kind: 'ok', contact, contactInbox, conversation }
  }

  /** Hand the normalized message to the shared chain (flow, AI, automation, realtime). */
  ingest(args: Parameters<ConversationsService['ingestExternalInbound']>[0]) {
    return this.conversations.ingestExternalInbound(args)
  }

  /**
   * Record provider message ids on an outbound row so receipts and retries
   * find it. Replaces any previous stamp: a retry's new id must win.
   */
  async stampOutbound(
    messageId: string,
    externalIds: Array<string | null | undefined>,
  ): Promise<void> {
    const ids = externalIds.filter((x): x is string => typeof x === 'string' && x !== '')
    if (ids.length === 0) return
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } })
    if (!msg) return
    const attrs = (msg.contentAttributes ?? {}) as Record<string, unknown>
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        externalSourceId: ids[0],
        contentAttributes: { ...attrs, externalIds: ids } as Prisma.InputJsonValue,
      },
    })
  }
}
