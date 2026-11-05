import type { FileType } from '@cosmika/db'
import type { InteractiveContent } from '@cosmika/shared'

import type {
  ChannelAdapter,
  ChannelSendResult,
  MessagingWindow,
  OutboundMedia,
  OutboundMediaKind,
} from '../channels/channel-adapter'
import type { ChannelInboundService } from '../channels/channel-inbound.service'

import type { MetaChannel, MetaMessagingService } from './meta-messaging.service'

// Messenger Platform attachment ceiling (25MB), and the narrower image one.
const META_MAX_BYTES: Record<OutboundMediaKind, number> = {
  image: 8 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  document: 25 * 1024 * 1024,
}
const META_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif'])

/** Messenger and Instagram Direct behind the channel contract; one class, two channel types. */
export class MetaChannelAdapter implements ChannelAdapter {
  // Meta attachments carry no caption; the text goes as its own message.
  readonly captionMax = 0

  constructor(
    readonly channelType: MetaChannel,
    private readonly meta: MetaMessagingService,
    private readonly inbound: ChannelInboundService,
  ) {}

  recipientFor(conversationId: string): Promise<string | null> {
    return this.meta.recipientForConversation(this.channelType, conversationId)
  }

  windowFor(conversationId: string): Promise<MessagingWindow | null> {
    return this.meta.windowFor(conversationId)
  }

  sendText(inboxId: string, to: string, text: string): Promise<ChannelSendResult> {
    return this.meta.sendText(this.channelType, inboxId, to, text)
  }

  sendMedia(inboxId: string, to: string, media: OutboundMedia): Promise<ChannelSendResult> {
    return this.meta.sendMedia(this.channelType, inboxId, to, media)
  }

  sendInteractive(inboxId: string, to: string, content: InteractiveContent): Promise<ChannelSendResult> {
    return this.meta.sendInteractive(inboxId, to, content)
  }

  stampOutbound(messageId: string, externalIds: Array<string | null | undefined>): Promise<void> {
    return this.inbound.stampOutbound(messageId, externalIds)
  }

  mediaKindFor(fileType: FileType, mimeType: string | null, fileSize?: number | null): OutboundMediaKind {
    const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim()
    const fits = (kind: OutboundMediaKind) => fileSize == null || fileSize <= META_MAX_BYTES[kind]
    switch (fileType) {
      case 'IMAGE':
        return META_IMAGE_MIME.has(mime) && fits('image') ? 'image' : 'document'
      case 'VIDEO':
        return 'video'
      case 'AUDIO':
        return 'audio'
      default:
        return 'document'
    }
  }

  mediaMaxBytes(kind: OutboundMediaKind): number {
    return META_MAX_BYTES[kind]
  }

  captionFits(): boolean {
    return false
  }
}
