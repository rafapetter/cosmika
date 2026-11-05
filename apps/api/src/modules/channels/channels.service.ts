import { forwardRef, Inject, Injectable } from '@nestjs/common'
import type { Attachment, ChannelType } from '@cosmika/db'

import { AttachmentsService } from '../attachments/attachments.service'
import { MetaChannelAdapter } from '../meta-messaging/meta-channel.adapter'
import { MetaMessagingService } from '../meta-messaging/meta-messaging.service'
import { TelegramChannelAdapter } from '../telegram/telegram-channel.adapter'
import { TelegramService } from '../telegram/telegram.service'
import { WhatsappService } from '../whatsapp/whatsapp.service'

import type { ChannelAdapter, MessagingWindow } from './channel-adapter'
import { ChannelInboundService } from './channel-inbound.service'
import { WhatsappChannelAdapter } from './whatsapp-channel.adapter'

/** Human name for log and error text. */
const CHANNEL_LABEL: Partial<Record<ChannelType, string>> = {
  WHATSAPP: 'WhatsApp',
  TELEGRAM: 'Telegram',
  FACEBOOK: 'Messenger',
  INSTAGRAM: 'Instagram',
}

/**
 * The one place that knows which channels push and how. Every outbound path
 * (agent reply, flow, AI agent, auto-reply, CSAT) goes through here, so a new
 * channel is one adapter instead of six `if (channelType === …)` edits.
 */
@Injectable()
export class ChannelsService {
  private adapters: Map<ChannelType, ChannelAdapter> | null = null

  constructor(
    // forwardRef: WhatsappService imports ConversationsService, which imports
    // this service back.
    @Inject(forwardRef(() => WhatsappService))
    private readonly whatsapp: WhatsappService,
    private readonly attachments: AttachmentsService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegram: TelegramService,
    @Inject(forwardRef(() => ChannelInboundService))
    private readonly inbound: ChannelInboundService,
    @Inject(forwardRef(() => MetaMessagingService))
    private readonly meta: MetaMessagingService,
  ) {}

  // Built on first use, not in the constructor: under forwardRef the injected
  // instance is not guaranteed to be ready while this one is being built.
  private registry(): Map<ChannelType, ChannelAdapter> {
    if (!this.adapters) {
      this.adapters = new Map<ChannelType, ChannelAdapter>([
        ['WHATSAPP', new WhatsappChannelAdapter(this.whatsapp)],
        ['TELEGRAM', new TelegramChannelAdapter(this.telegram, this.inbound)],
        ['FACEBOOK', new MetaChannelAdapter('FACEBOOK', this.meta, this.inbound)],
        ['INSTAGRAM', new MetaChannelAdapter('INSTAGRAM', this.meta, this.inbound)],
      ])
    }
    return this.adapters
  }

  /** The adapter for a push-based channel, or null for a pull-based one. */
  adapterFor(channelType: ChannelType | string | null | undefined): ChannelAdapter | null {
    if (!channelType) return null
    return this.registry().get(channelType as ChannelType) ?? null
  }

  /** Free-reply window for the conversation's channel; null when it has none. */
  async windowFor(
    channelType: ChannelType | string,
    conversationId: string,
  ): Promise<MessagingWindow | null> {
    const adapter = this.adapterFor(channelType)
    return adapter ? adapter.windowFor(conversationId) : null
  }

  /**
   * Send an agent message (text and attachments) to the contact.
   *
   * Text rides along as the caption of the first attachment that can carry
   * one so the contact sees a single message; when it can't (no attachments,
   * only caption-less media, or a body past the caption limit) it goes out on
   * its own first. Returns without sending for pull-based channels and for
   * conversations with no reachable recipient.
   */
  async deliverMessage(
    conversation: { id: string; inboxId: string },
    channelType: ChannelType | string,
    content: string,
    attachments: Attachment[],
    /** Message row to stamp with the provider id(s), so receipts match. */
    messageId?: string,
  ): Promise<void> {
    const adapter = this.adapterFor(channelType)
    if (!adapter) return
    const to = await adapter.recipientFor(conversation.id)
    if (!to) return
    const label = CHANNEL_LABEL[adapter.channelType] ?? adapter.channelType
    const externalIds: Array<string | null> = []

    const kinds = attachments.map((a) => adapter.mediaKindFor(a.fileType, a.mimeType, a.fileSize))
    // Past the largest ceiling there's no type left to fall back to. Fail
    // loudly rather than posting a send the provider will reject.
    attachments.forEach((att, i) => {
      const max = adapter.mediaMaxBytes(kinds[i]!)
      if (att.fileSize != null && att.fileSize > max) {
        throw new Error(
          `attachment ${att.fileName ?? att.id} is ${att.fileSize} bytes; ` +
            `${label} accepts at most ${max} for ${kinds[i]}`,
        )
      }
    })
    const captionIndex =
      content && adapter.captionMax > 0 && content.length <= adapter.captionMax
        ? kinds.findIndex((k) => adapter.captionFits(k))
        : -1
    if (content && captionIndex === -1) {
      const { externalId } = await adapter.sendText(conversation.inboxId, to, content)
      externalIds.push(externalId)
    }
    for (const [i, att] of attachments.entries()) {
      const media = await this.attachments.resolveOutboundMedia(att)
      const { externalId } = await adapter.sendMedia(conversation.inboxId, to, {
        kind: kinds[i]!,
        source:
          media.kind === 'link'
            ? { link: media.url }
            : {
                buffer: media.buffer,
                mimeType: media.mimeType,
                fileName: media.fileName,
              },
        ...(att.fileName ? { fileName: att.fileName } : {}),
        ...(i === captionIndex ? { caption: content } : {}),
      })
      externalIds.push(externalId)
    }
    if (messageId) await adapter.stampOutbound(messageId, externalIds)
  }
}
