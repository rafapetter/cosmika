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

import { TG_CAPTION_MAX, type TelegramService } from './telegram.service'

// Bot API upload ceilings: 10MB for a photo, 50MB for anything else.
const TG_MAX_BYTES: Record<OutboundMediaKind, number> = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  document: 50 * 1024 * 1024,
}
const TG_PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** Telegram bots behind the channel contract. No reply window: a bot may always answer. */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channelType = 'TELEGRAM' as const
  readonly captionMax = TG_CAPTION_MAX

  constructor(
    private readonly telegram: TelegramService,
    private readonly inbound: ChannelInboundService,
  ) {}

  recipientFor(conversationId: string): Promise<string | null> {
    return this.telegram.recipientForConversation(conversationId)
  }

  async windowFor(): Promise<MessagingWindow | null> {
    return null
  }

  sendText(inboxId: string, to: string, text: string): Promise<ChannelSendResult> {
    return this.telegram.sendText(inboxId, to, text)
  }

  sendMedia(inboxId: string, to: string, media: OutboundMedia): Promise<ChannelSendResult> {
    return this.telegram.sendMedia(inboxId, to, media)
  }

  sendInteractive(inboxId: string, to: string, content: InteractiveContent): Promise<ChannelSendResult> {
    return this.telegram.sendInteractive(inboxId, to, content)
  }

  stampOutbound(messageId: string, externalIds: Array<string | null | undefined>): Promise<void> {
    return this.inbound.stampOutbound(messageId, externalIds)
  }

  mediaKindFor(fileType: FileType, mimeType: string | null, fileSize?: number | null): OutboundMediaKind {
    const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim()
    const fits = (kind: OutboundMediaKind) => fileSize == null || fileSize <= TG_MAX_BYTES[kind]
    switch (fileType) {
      case 'IMAGE':
        return TG_PHOTO_MIME.has(mime) && fits('image') ? 'image' : 'document'
      case 'VIDEO':
        return mime === 'video/mp4' ? 'video' : 'document'
      case 'AUDIO':
        return 'audio'
      default:
        return 'document'
    }
  }

  mediaMaxBytes(kind: OutboundMediaKind): number {
    return TG_MAX_BYTES[kind]
  }

  captionFits(): boolean {
    return true
  }
}
