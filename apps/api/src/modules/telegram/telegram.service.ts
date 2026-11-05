import { createHash, timingSafeEqual } from 'node:crypto'

import {
  BadGatewayException,
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import type { Inbox, Prisma } from '@cosmika/db'
import { InteractiveContent, TELEGRAM_SECRET_FIELDS } from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { decryptSecretsIn } from '../../common/secret-crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { AttachmentsService } from '../attachments/attachments.service'
import type { OutboundMedia } from '../channels/channel-adapter'
import { ChannelInboundService } from '../channels/channel-inbound.service'

import { tgCall, tgDownload, type TgSentMessage, type TgUser } from './telegram.api'

/** Telegram's ceiling on a text message. */
export const TG_TEXT_MAX = 4096
/** Telegram's ceiling on a media caption. */
export const TG_CAPTION_MAX = 1024
/** callback_data is limited to 64 bytes; option ids can be longer. */
const TG_CALLBACK_MAX_BYTES = 64

type TgConfig = {
  botToken: string
  webhookSecret: string
  botUsername?: string
  botId?: number
}

type TgFileRef = { file_id: string; mime_type?: string; file_name?: string }
type TgMessage = {
  message_id: number
  date?: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
  caption?: string
  photo?: Array<TgFileRef & { width?: number; file_size?: number }>
  voice?: TgFileRef
  audio?: TgFileRef
  video?: TgFileRef
  document?: TgFileRef
  location?: { latitude: number; longitude: number }
  sticker?: { emoji?: string }
}
export type TgUpdate = {
  update_id: number
  message?: TgMessage
  callback_query?: {
    id: string
    from: TgUser
    data?: string
    message?: { message_id: number; chat: { id: number; type: string } }
  }
}

/** The callback_data we put on a button: the option id, or a short hash of it. */
export function callbackDataFor(optionId: string): string {
  if (Buffer.byteLength(optionId, 'utf8') <= TG_CALLBACK_MAX_BYTES) return optionId
  return 'h:' + createHash('sha256').update(optionId).digest('base64url').slice(0, 22)
}

/** Every option of a menu as {id, label}, buttons and list rows alike. */
export function menuOptions(content: InteractiveContent): Array<{ id: string; label: string }> {
  return content.kind === 'buttons'
    ? content.buttons.map((b) => ({ id: b.id, label: b.label }))
    : content.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, label: r.title })))
}

function displayName(u: TgUser | undefined): string | null {
  if (!u) return null
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return full || u.username || null
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const stub = () => process.env.COSMIKA_TELEGRAM_STUB === '1'

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    // forwardRef: channel-inbound.service imports conversations.service,
    // which reaches this file back through channels.service.
    @Inject(forwardRef(() => ChannelInboundService))
    private readonly inbound: ChannelInboundService,
  ) {}

  // ─── Setup ──────────────────────────────────────────────────────────

  /** Ask Telegram who the token belongs to; a 400 the admin can act on if it's wrong. */
  async verifyToken(botToken: string): Promise<TgUser> {
    if (stub()) return { id: 1, is_bot: true, username: 'stub_bot', first_name: 'Stub' }
    try {
      return await tgCall<TgUser>(botToken, 'getMe')
    } catch (err) {
      this.logger.warn(`Telegram getMe refused the token: ${err instanceof Error ? err.message : String(err)}`)
      throw new BadRequestException(
        errBody('telegram_token_invalid', 'Telegram did not accept this bot token. Copy it again from @BotFather.'),
      )
    }
  }

  /** Point the bot's webhook at this inbox and remember who the bot is. */
  async connect(inbox: Inbox, bot: TgUser, publicApiUrl: string): Promise<Inbox> {
    const url = `${publicApiUrl.replace(/\/+$/, '')}/webhooks/telegram/${inbox.id}`
    if (!stub()) {
      const cfg = this.config(inbox)
      try {
        await tgCall(cfg.botToken, 'setWebhook', {
          url,
          secret_token: cfg.webhookSecret,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        })
      } catch (err) {
        throw new BadGatewayException(
          errBody(
            'telegram_webhook_failed',
            `Telegram refused the webhook: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    }
    const stored = (inbox.channelConfig ?? {}) as Record<string, unknown>
    return this.prisma.inbox.update({
      where: { id: inbox.id },
      data: {
        channelConfig: {
          ...stored,
          botUsername: bot.username ?? null,
          botId: bot.id,
          webhookUrl: url,
        } as Prisma.InputJsonValue,
      },
    })
  }

  // ─── Inbound ────────────────────────────────────────────────────────

  async ingestWebhook(inboxId: string, secretHeader: string | undefined, update: TgUpdate): Promise<void> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'TELEGRAM') throw new NotFoundException()
    const cfg = this.config(inbox)
    if (!secretHeader || !safeEqual(secretHeader, cfg.webhookSecret)) {
      throw new UnauthorizedException()
    }
    try {
      if (update.callback_query) await this.ingestCallback(inbox, cfg, update.callback_query)
      else if (update.message) await this.ingestMessage(inbox, cfg, update.message)
    } catch (err) {
      // Answer 200 anyway: a non-2xx makes Telegram redeliver the same update
      // for hours, and dedupe already protects a real retry.
      this.logger.error(
        `Telegram update ${update.update_id} for inbox ${inbox.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private async ingestMessage(inbox: Inbox, cfg: TgConfig, msg: TgMessage): Promise<void> {
    // Groups and channels are out of scope: a support inbox talks one to one.
    if (msg.chat.type !== 'private') return
    const externalSourceId = `tg:${msg.chat.id}:${msg.message_id}`
    if (await this.inbound.alreadyIngested(inbox.id, externalSourceId)) return
    const resolved = await this.inbound.resolve(inbox, {
      sourceId: String(msg.chat.id),
      identifier: `telegram:${msg.from?.id ?? msg.chat.id}`,
      name: displayName(msg.from),
      ...(msg.from?.username && { additionalAttributes: { telegramUsername: msg.from.username } }),
    })
    if (resolved.kind === 'blocked') return

    const { content, contentType, file } = this.normalize(msg)
    const contentAttributes: Record<string, unknown> = {
      ...(msg.date ? { external_created_at: new Date(msg.date * 1000).toISOString() } : {}),
      ...(msg.location ? { latitude: msg.location.latitude, longitude: msg.location.longitude } : {}),
    }
    let attachmentIds: string[] | undefined
    if (file) {
      try {
        const { buffer, filePath } = await tgDownload(cfg.botToken, file.file_id)
        const att = await this.attachments.ingestFromChannel(inbox.accountId, {
          buffer,
          mimeType: file.mime_type ?? file.fallbackMime,
          fileName: file.file_name ?? filePath.slice(filePath.lastIndexOf('/') + 1),
        })
        attachmentIds = [att.id]
      } catch (err) {
        contentAttributes.mediaDownloadError = err instanceof Error ? err.message : String(err)
      }
    }
    await this.inbound.ingest({
      accountId: inbox.accountId,
      conversationId: resolved.conversation.id,
      content,
      contentType,
      contentAttributes,
      externalSourceId,
      attachmentIds,
    })
  }

  private async ingestCallback(
    inbox: Inbox,
    cfg: TgConfig,
    cb: NonNullable<TgUpdate['callback_query']>,
  ): Promise<void> {
    // Stop the button's spinner first; the contact sees it right away.
    if (!stub()) {
      await tgCall(cfg.botToken, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => undefined)
    }
    const chat = cb.message?.chat
    if (!chat || chat.type !== 'private' || !cb.data) return
    const externalSourceId = `tgcb:${cb.id}`
    if (await this.inbound.alreadyIngested(inbox.id, externalSourceId)) return
    const resolved = await this.inbound.resolve(inbox, {
      sourceId: String(chat.id),
      identifier: `telegram:${cb.from.id}`,
      name: displayName(cb.from),
    })
    if (resolved.kind === 'blocked') return
    const option = await this.optionForCallback(resolved.conversation.id, cb.data)
    await this.inbound.ingest({
      accountId: inbox.accountId,
      conversationId: resolved.conversation.id,
      content: option?.label ?? cb.data,
      contentType: 'TEXT',
      contentAttributes: { interactiveReplyId: option?.id ?? cb.data },
      externalSourceId,
    })
  }

  /** The menu option a tapped button stands for, read off the latest menu sent. */
  private async optionForCallback(
    conversationId: string,
    data: string,
  ): Promise<{ id: string; label: string } | null> {
    const menus = await this.prisma.message.findMany({
      where: { conversationId, contentType: 'QUICK_REPLIES' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { contentAttributes: true },
    })
    for (const m of menus) {
      const parsed = InteractiveContent.safeParse(m.contentAttributes)
      if (!parsed.success) continue
      const hit = menuOptions(parsed.data).find((o) => callbackDataFor(o.id) === data)
      if (hit) return hit
    }
    return null
  }

  private normalize(msg: TgMessage): {
    content: string
    contentType: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'FILE' | 'LOCATION'
    file?: TgFileRef & { fallbackMime?: string }
  } {
    const caption = msg.caption ?? ''
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]!
      return { content: caption, contentType: 'IMAGE', file: { ...largest, fallbackMime: 'image/jpeg' } }
    }
    if (msg.voice) return { content: caption, contentType: 'AUDIO', file: { ...msg.voice, fallbackMime: 'audio/ogg' } }
    if (msg.audio) return { content: caption, contentType: 'AUDIO', file: { ...msg.audio, fallbackMime: 'audio/mpeg' } }
    if (msg.video) return { content: caption, contentType: 'VIDEO', file: { ...msg.video, fallbackMime: 'video/mp4' } }
    if (msg.document) return { content: caption, contentType: 'FILE', file: msg.document }
    if (msg.location) return { content: '', contentType: 'LOCATION' }
    if (msg.sticker) return { content: msg.sticker.emoji ?? '', contentType: 'TEXT' }
    return { content: msg.text ?? '', contentType: 'TEXT' }
  }

  // ─── Outbound ───────────────────────────────────────────────────────

  /** The chat id to send to, or null when this isn't a reachable Telegram conversation. */
  async recipientForConversation(conversationId: string): Promise<string | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { inbox: { select: { channelType: true } }, contactInbox: { select: { sourceId: true } } },
    })
    if (!conv || conv.inbox.channelType !== 'TELEGRAM') return null
    return conv.contactInbox?.sourceId ?? null
  }

  async sendText(inboxId: string, chatId: string, text: string): Promise<{ externalId: string | null }> {
    const token = await this.tokenFor(inboxId)
    let first: string | null = null
    // Longer than one Telegram message: send it in order, in pieces.
    for (let i = 0; i < text.length; i += TG_TEXT_MAX) {
      const sent = await this.send(token, 'sendMessage', { chat_id: chatId, text: text.slice(i, i + TG_TEXT_MAX) })
      first ??= sent
    }
    return { externalId: first }
  }

  async sendInteractive(
    inboxId: string,
    chatId: string,
    content: InteractiveContent,
  ): Promise<{ externalId: string | null }> {
    const token = await this.tokenFor(inboxId)
    const keyboard = menuOptions(content).map((o) => [
      { text: o.label, callback_data: callbackDataFor(o.id) },
    ])
    const externalId = await this.send(token, 'sendMessage', {
      chat_id: chatId,
      text: content.body,
      reply_markup: { inline_keyboard: keyboard },
    })
    return { externalId }
  }

  async sendMedia(inboxId: string, chatId: string, media: OutboundMedia): Promise<{ externalId: string | null }> {
    const token = await this.tokenFor(inboxId)
    const isVoice =
      media.kind === 'audio' &&
      ('link' in media.source
        ? /\.(ogg|oga|opus)(\?|#|$)/i.test(media.source.link)
        : /ogg|opus/i.test(media.source.mimeType))
    const [method, field] =
      media.kind === 'image'
        ? ['sendPhoto', 'photo']
        : media.kind === 'video'
          ? ['sendVideo', 'video']
          : media.kind === 'audio'
            ? isVoice
              ? ['sendVoice', 'voice']
              : ['sendAudio', 'audio']
            : ['sendDocument', 'document']
    const caption = media.caption ? media.caption.slice(0, TG_CAPTION_MAX) : undefined
    if ('link' in media.source) {
      const externalId = await this.send(token, method, {
        chat_id: chatId,
        [field]: media.source.link,
        ...(caption && { caption }),
      })
      return { externalId }
    }
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) form.append('caption', caption)
    form.append(
      field,
      new Blob([media.source.buffer], { type: media.source.mimeType }),
      media.fileName ?? media.source.fileName,
    )
    return { externalId: await this.send(token, method, form) }
  }

  private async send(
    token: string,
    method: string,
    body: Record<string, unknown> | FormData,
  ): Promise<string | null> {
    if (stub()) return `stub-tg-${Date.now()}`
    const sent = await tgCall<TgSentMessage>(token, method, body)
    return `${sent.chat.id}:${sent.message_id}`
  }

  private async tokenFor(inboxId: string): Promise<string> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'TELEGRAM') throw new NotFoundException()
    return this.config(inbox).botToken
  }

  private config(inbox: Inbox): TgConfig {
    const raw = (inbox.channelConfig ?? {}) as Record<string, unknown>
    const cfg = decryptSecretsIn(raw, TELEGRAM_SECRET_FIELDS) as Partial<TgConfig>
    if (!cfg.botToken || !cfg.webhookSecret) {
      throw new BadRequestException(errBody('telegram_credentials_missing', 'Telegram inbox missing its bot token'))
    }
    return cfg as TgConfig
  }
}
