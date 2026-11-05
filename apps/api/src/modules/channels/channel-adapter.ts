import type { ChannelType, FileType } from '@cosmika/db'
import type { InteractiveContent } from '@cosmika/shared'

/**
 * The contract every push-based channel implements. Pull-based channels
 * (the web widget and the API inbox read the thread itself) have no adapter:
 * writing the Message row IS their delivery.
 *
 * Callers never branch on `channelType` to send anymore; they ask
 * ChannelsService for the adapter and treat a null as "nothing to push".
 */
export type OutboundMediaKind = 'image' | 'video' | 'audio' | 'document'

/**
 * Where the bytes come from: a URL the provider fetches itself, or the file
 * itself, which the adapter uploads first when the provider needs that.
 */
export type OutboundMediaSource =
  | { link: string }
  | { buffer: Buffer; mimeType: string; fileName: string }

export type OutboundMedia = {
  kind: OutboundMediaKind
  source: OutboundMediaSource
  /** Shown as the file name on `document` sends. */
  fileName?: string
  /** Dropped by adapters whose provider has no caption for this kind. */
  caption?: string
}

export type ChannelSendResult = {
  /** Provider message id (wamid, Messenger mid, Telegram message_id), when one came back. */
  externalId: string | null
}

export type MessagingWindow = {
  open: boolean
  lastInboundAt: string | null
  expiresAt: string | null
}

export interface ChannelAdapter {
  readonly channelType: ChannelType

  /**
   * Who to send to for this conversation, or null when nobody is reachable
   * (conversation gone, contact without a channel identity).
   */
  recipientFor(conversationId: string): Promise<string | null>

  /** The provider's free-reply window, or null when the channel has none. */
  windowFor(conversationId: string): Promise<MessagingWindow | null>

  sendText(inboxId: string, to: string, text: string): Promise<ChannelSendResult>
  sendMedia(inboxId: string, to: string, media: OutboundMedia): Promise<ChannelSendResult>
  /** Buttons or a list, rendered with whatever the channel has natively. */
  sendInteractive(
    inboxId: string,
    to: string,
    content: InteractiveContent,
  ): Promise<ChannelSendResult>

  /** Record provider ids on the outbound row so delivery receipts can find it. */
  stampOutbound(messageId: string, externalIds: Array<string | null | undefined>): Promise<void>

  /** Media type this channel would send one of our attachments as. */
  mediaKindFor(fileType: FileType, mimeType: string | null, fileSize?: number | null): OutboundMediaKind
  /** Provider size ceiling for a media type. */
  mediaMaxBytes(kind: OutboundMediaKind): number
  /** Longest caption the provider takes on media; 0 when it takes none. */
  readonly captionMax: number
  /** Whether this media type carries a caption at all. */
  captionFits(kind: OutboundMediaKind): boolean
}
