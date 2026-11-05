import type { FileType } from '@cosmika/db'
import type { InteractiveContent } from '@cosmika/shared'

import {
  WA_CAPTION_MAX,
  WA_MEDIA_MAX_BYTES,
  waMediaKind,
  type WhatsappService,
} from '../whatsapp/whatsapp.service'

import type {
  ChannelAdapter,
  ChannelSendResult,
  MessagingWindow,
  OutboundMedia,
  OutboundMediaKind,
} from './channel-adapter'

/**
 * WhatsApp Cloud API behind the channel contract. A thin delegate on purpose:
 * every rule (BSUID fallback, 24h window anchor, media upload, list vs
 * buttons) stays in WhatsappService, where its tests already pin it.
 */
export class WhatsappChannelAdapter implements ChannelAdapter {
  readonly channelType = 'WHATSAPP' as const
  readonly captionMax = WA_CAPTION_MAX

  constructor(private readonly whatsapp: WhatsappService) {}

  recipientFor(conversationId: string): Promise<string | null> {
    return this.whatsapp.recipientForConversation(conversationId)
  }

  windowFor(conversationId: string): Promise<MessagingWindow | null> {
    return this.whatsapp.messagingWindowFor(conversationId)
  }

  async sendText(inboxId: string, to: string, text: string): Promise<ChannelSendResult> {
    const { wamid } = await this.whatsapp.sendOutbound(inboxId, to, text)
    return { externalId: wamid }
  }

  async sendMedia(inboxId: string, to: string, media: OutboundMedia): Promise<ChannelSendResult> {
    const { wamid } = await this.whatsapp.sendMedia(inboxId, to, media)
    return { externalId: wamid }
  }

  async sendInteractive(
    inboxId: string,
    to: string,
    content: InteractiveContent,
  ): Promise<ChannelSendResult> {
    const { wamid } = await this.whatsapp.sendInteractive(inboxId, to, content)
    return { externalId: wamid }
  }

  stampOutbound(messageId: string, externalIds: Array<string | null | undefined>): Promise<void> {
    return this.whatsapp.stampOutbound(messageId, externalIds)
  }

  mediaKindFor(fileType: FileType, mimeType: string | null, fileSize?: number | null): OutboundMediaKind {
    return waMediaKind(fileType, mimeType, fileSize)
  }

  mediaMaxBytes(kind: OutboundMediaKind): number {
    return WA_MEDIA_MAX_BYTES[kind]
  }

  // The Cloud API has no caption field on audio.
  captionFits(kind: OutboundMediaKind): boolean {
    return kind !== 'audio'
  }
}
