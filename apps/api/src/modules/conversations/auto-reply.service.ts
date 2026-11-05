import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common'
import { Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'
import { ChannelsService } from '../channels/channels.service'
import { WorkingHoursService } from '../working-hours/working-hours.service'

// Inbox auto-replies: greeting on first contact, and the out-of-office
// message outside working hours.
//
// Both settings already existed on Inbox (`greetingMessage`,
// `outOfOfficeMessage`) and were editable in the UI, but nothing ever sent
// them — a dead setting is worse than a missing feature, because the operator
// believes it is working. 8 live Nebula inboxes rely on out-of-office today.
//
// Deliberate rule: if a deterministic flow handled the turn, we stay silent.
// Migrated flows do their own greeting and their own business-hours branch
// (acct 4's "Boas Vindas" opens with exactly that), so replying here too
// would double-message every customer.

// A customer who writes repeatedly while we're closed should be told once,
// not per message. They should still be told again on a later visit.
const OOO_COOLDOWN_MS = 12 * 60 * 60 * 1000

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
    private readonly workingHours: WorkingHoursService,
  ) {}

  async maybeAutoReply(args: {
    conversationId: string
    accountId: string
    isFirstMessage: boolean
    flowHandled: boolean
    now?: Date
  }): Promise<void> {
    // The flow owns the conversation's voice when it replied this turn.
    if (args.flowHandled) return
    try {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: args.conversationId },
        include: { inbox: true, contact: true },
      })
      if (!conv || conv.accountId !== args.accountId) return
      const inbox = conv.inbox
      const now = args.now ?? new Date()

      if (args.isFirstMessage && inbox.greetingEnabled && inbox.greetingMessage) {
        await this.send(conv, inbox.greetingMessage)
      }

      if (inbox.workingHoursEnabled && inbox.outOfOfficeMessage) {
        const open = await this.workingHours.isInboxOpenNow(
          args.accountId,
          inbox.id,
          now,
        )
        if (!open && this.oooCooledDown(conv.customAttributes, now)) {
          await this.send(conv, inbox.outOfOfficeMessage)
          await this.stampOoo(conv.id, conv.customAttributes, now)
        }
      }
    } catch (err) {
      // An auto-reply must never break inbound ingestion.
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`auto-reply failed for ${args.conversationId}: ${m}`)
    }
  }

  private oooCooledDown(customAttributes: unknown, now: Date): boolean {
    const attrs = (customAttributes ?? {}) as Record<string, unknown>
    const last = attrs.lastOutOfOfficeAt
    if (typeof last !== 'string') return true
    const at = Date.parse(last)
    if (Number.isNaN(at)) return true
    return now.getTime() - at >= OOO_COOLDOWN_MS
  }

  private async stampOoo(
    conversationId: string,
    customAttributes: unknown,
    now: Date,
  ): Promise<void> {
    const attrs = (customAttributes ?? {}) as Record<string, unknown>
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        customAttributes: {
          ...attrs,
          lastOutOfOfficeAt: now.toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
  }

  /** Persist as an outgoing bot message and push it to the channel. */
  private async send(
    conv: {
      id: string
      inboxId: string
      accountId: string
      contact: { phoneNumber: string | null } | null
      inbox: { channelType: string }
    },
    text: string,
  ): Promise<void> {
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        inboxId: conv.inboxId,
        accountId: conv.accountId,
        senderType: 'AGENT_BOT',
        content: text,
        contentType: 'TEXT',
        status: 'SENT',
      },
    })
    await this.realtime.publish({
      type: 'MessageCreated',
      accountId: conv.accountId,
      conversationId: conv.id,
      inboxId: conv.inboxId,
      messageId: msg.id,
      senderType: 'AGENT_BOT',
      content: text,
      isPrivate: false,
      createdAt: msg.createdAt.toISOString(),
    })
    // Widget/API channels are pull-based and have no adapter; push-based ones
    // resolve the recipient (WhatsApp's phone/BSUID fallback included) there.
    const adapter = this.channels.adapterFor(conv.inbox.channelType)
    if (!adapter) return
    const to = await adapter.recipientFor(conv.id)
    if (!to) return
    try {
      const { externalId } = await adapter.sendText(conv.inboxId, to, text)
      await adapter.stampOutbound(msg.id, [externalId])
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`auto-reply push failed for ${conv.id}: ${m}`)
    }
  }
}
