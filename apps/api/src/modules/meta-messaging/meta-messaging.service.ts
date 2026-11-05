import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  BadGatewayException,
  BadRequestException,
  forwardRef,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Inbox } from '@cosmika/db'
import {
  META_PAGE_SECRET_FIELDS,
  type CreateMetaInboxesInput,
  type InteractiveContent,
} from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { decryptSecretsIn } from '../../common/secret-crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { AttachmentsService } from '../attachments/attachments.service'
import type { MessagingWindow, OutboundMedia } from '../channels/channel-adapter'
import { ChannelInboundService } from '../channels/channel-inbound.service'
import { InboxesService } from '../inboxes/inboxes.service'
import { graphCall } from '../whatsapp/embedded-signup.graph'

import { metaGraphBase, metaMessagingSettings } from './meta-messaging.config'

export type MetaChannel = 'FACEBOOK' | 'INSTAGRAM'

/** Longest text each product takes in one message. */
export const META_TEXT_MAX: Record<MetaChannel, number> = { FACEBOOK: 2000, INSTAGRAM: 1000 }
/** Quick replies: at most 13, titles up to 20 characters. */
const QUICK_REPLY_MAX = 13
const QUICK_REPLY_TITLE_MAX = 20
/** The standard messaging window on Messenger and Instagram. */
const WINDOW_MS = 24 * 60 * 60 * 1000

type MetaAttachment = { type?: string; payload?: { url?: string } }
export type MetaMessagingEvent = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    quick_reply?: { payload?: string }
    attachments?: MetaAttachment[]
  }
  postback?: { mid?: string; title?: string; payload?: string }
}
export type MetaWebhookPayload = {
  object?: string
  entry?: Array<{ id?: string; time?: number; messaging?: MetaMessagingEvent[] }>
}

type PageConfig = {
  pageId: string
  pageAccessToken: string
  pageName?: string
  instagramId?: string
  instagramUsername?: string
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const stub = () => process.env.COSMIKA_META_STUB === '1'

const ATTACHMENT_CONTENT_TYPE: Record<string, 'IMAGE' | 'AUDIO' | 'VIDEO' | 'FILE'> = {
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
  file: 'FILE',
}

@Injectable()
export class MetaMessagingService {
  private readonly logger = new Logger(MetaMessagingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    @Inject(forwardRef(() => ChannelInboundService))
    private readonly inbound: ChannelInboundService,
    private readonly inboxes: InboxesService,
  ) {}

  // ─── Webhook ────────────────────────────────────────────────────────

  verifyChallenge(mode?: string, token?: string, challenge?: string): string {
    const s = metaMessagingSettings()
    if (!s?.verifyToken) throw new NotFoundException()
    if (mode !== 'subscribe' || !token || !challenge || !safeEqual(token, s.verifyToken)) {
      throw new ForbiddenException()
    }
    return challenge
  }

  async ingestWebhook(
    rawBody: Buffer,
    headers: { sha256?: string; sha1?: string },
    payload: MetaWebhookPayload,
  ): Promise<{ processed: number; relayed: boolean }> {
    const s = metaMessagingSettings()
    if (!s) throw new NotFoundException()
    const expected = `sha256=${createHmac('sha256', s.appSecret).update(rawBody).digest('hex')}`
    if (!headers.sha256 || !safeEqual(headers.sha256, expected)) throw new ForbiddenException()

    const channel: MetaChannel | null =
      payload.object === 'page' ? 'FACEBOOK' : payload.object === 'instagram' ? 'INSTAGRAM' : null
    if (!channel) return { processed: 0, relayed: false }

    let processed = 0
    let foreign = false
    for (const entry of payload.entry ?? []) {
      const inbox = entry.id ? await this.inboxForEntry(channel, entry.id) : null
      if (!inbox) {
        foreign = true
        continue
      }
      for (const event of entry.messaging ?? []) {
        try {
          if (await this.ingestEvent(inbox, channel, event)) processed += 1
        } catch (err) {
          // 200 anyway: a non-2xx makes Meta retry and then disable the app's
          // subscription; dedupe already covers real retries.
          this.logger.error(
            `${channel} event for inbox ${inbox.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    const relayUrl = channel === 'FACEBOOK' ? s.relay.page : s.relay.instagram
    if (foreign && relayUrl) {
      await this.relay(relayUrl, rawBody, headers)
      return { processed, relayed: true }
    }
    return { processed, relayed: false }
  }

  /**
   * Hand the event, byte for byte and with Meta's signatures, to the other
   * system that still owns pages on this app. Never throws: their outage must
   * not make Meta retry (and eventually unsubscribe) ours.
   */
  private async relay(url: string, rawBody: Buffer, headers: { sha256?: string; sha1?: string }): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(headers.sha256 && { 'x-hub-signature-256': headers.sha256 }),
          ...(headers.sha1 && { 'x-hub-signature': headers.sha1 }),
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) this.logger.warn(`Meta relay to ${url} answered ${res.status}`)
    } catch (err) {
      this.logger.warn(`Meta relay to ${url} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private inboxForEntry(channel: MetaChannel, entryId: string): Promise<Inbox | null> {
    return this.prisma.inbox.findFirst({
      where: {
        channelType: channel,
        channelConfig: { path: [channel === 'FACEBOOK' ? 'pageId' : 'instagramId'], equals: entryId },
      },
    })
  }

  /** True when a message was stored. */
  private async ingestEvent(inbox: Inbox, channel: MetaChannel, event: MetaMessagingEvent): Promise<boolean> {
    const senderId = event.sender?.id
    if (!senderId) return false
    // Our own sends (and replies typed in Meta's inbox) come back as echoes.
    if (event.message?.is_echo) return false
    const msg = event.message
    const postback = event.postback
    if (!msg && !postback) return false // read, delivery, reaction…
    const mid = msg?.mid ?? postback?.mid ?? `${senderId}:${event.timestamp ?? Date.now()}`
    const externalSourceId = `${channel === 'FACEBOOK' ? 'fb' : 'ig'}:${mid}`
    if (await this.inbound.alreadyIngested(inbox.id, externalSourceId)) return false

    const cfg = this.config(inbox)
    const resolved = await this.inbound.resolve(inbox, {
      sourceId: senderId,
      identifier: `${channel === 'FACEBOOK' ? 'messenger' : 'instagram'}:${senderId}`,
      name: () => this.profileName(channel, senderId, cfg.pageAccessToken),
    })
    if (resolved.kind === 'blocked') return false

    const contentAttributes: Record<string, unknown> = {
      ...(event.timestamp ? { external_created_at: new Date(event.timestamp).toISOString() } : {}),
    }
    const replyId = msg?.quick_reply?.payload ?? postback?.payload
    if (replyId) contentAttributes.interactiveReplyId = replyId

    let content = msg?.text ?? postback?.title ?? ''
    let contentType: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'FILE' = 'TEXT'
    let attachmentIds: string[] | undefined
    const att = msg?.attachments?.find((a) => a.type && ATTACHMENT_CONTENT_TYPE[a.type] && a.payload?.url)
    if (att) {
      contentType = ATTACHMENT_CONTENT_TYPE[att.type!]!
      try {
        const res = await fetch(att.payload!.url!, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const mimeType = res.headers.get('content-type') ?? undefined
        const path = new URL(att.payload!.url!).pathname
        const stored = await this.attachments.ingestFromChannel(inbox.accountId, {
          buffer: Buffer.from(await res.arrayBuffer()),
          mimeType,
          fileName: path.slice(path.lastIndexOf('/') + 1) || undefined,
        })
        attachmentIds = [stored.id]
      } catch (err) {
        contentAttributes.mediaDownloadError = err instanceof Error ? err.message : String(err)
      }
    } else if (!content && msg?.attachments?.length) {
      // Shares, stickers and other kinds we can't store as a file.
      content = `[${msg.attachments[0]!.type ?? 'attachment'}]`
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
    return true
  }

  /** Best effort: Meta only tells us who wrote when we ask. */
  private async profileName(channel: MetaChannel, userId: string, token: string): Promise<string | null> {
    if (stub()) return null
    const fields = channel === 'FACEBOOK' ? 'first_name,last_name' : 'name,username'
    const r = await graphCall<{ first_name?: string; last_name?: string; name?: string; username?: string }>(
      metaGraphBase(),
      userId,
      { token, query: { fields } },
    )
    if (!r.ok) return null
    const d = r.data
    const full = [d.first_name, d.last_name].filter(Boolean).join(' ').trim()
    return full || d.name || d.username || null
  }

  // ─── Setup ──────────────────────────────────────────────────────────

  /**
   * Check the Page and its token with Meta, subscribe the Page to our app,
   * then open the requested inboxes (Messenger, Instagram Direct, or both).
   */
  async connectPage(userId: string, accountId: string, input: CreateMetaInboxesInput): Promise<Inbox[]> {
    if (!input.messenger && !input.instagram) {
      throw new BadRequestException(errBody('invalid_input', 'Choose Messenger, Instagram or both'))
    }
    const page = await this.readPage(input.pageId, input.pageAccessToken)
    const ig = page.instagram_business_account
    if (input.instagram && !ig?.id) {
      throw new BadRequestException(
        errBody('meta_instagram_not_linked', 'This Facebook Page has no Instagram professional account linked'),
      )
    }
    await this.subscribePage(input.pageId, input.pageAccessToken)

    const created: Inbox[] = []
    if (input.messenger) {
      created.push(
        await this.inboxes.createMetaInbox(userId, accountId, {
          name: input.messengerName ?? `Messenger ${page.name ?? input.pageId}`,
          channelType: 'FACEBOOK',
          channelConfig: {
            pageId: input.pageId,
            pageAccessToken: input.pageAccessToken,
            pageName: page.name ?? null,
          },
        }),
      )
    }
    if (input.instagram && ig?.id) {
      created.push(
        await this.inboxes.createMetaInbox(userId, accountId, {
          name: input.instagramName ?? `Instagram ${ig.username ? '@' + ig.username : ig.id}`,
          channelType: 'INSTAGRAM',
          channelConfig: {
            pageId: input.pageId,
            pageAccessToken: input.pageAccessToken,
            pageName: page.name ?? null,
            instagramId: ig.id,
            instagramUsername: ig.username ?? null,
          },
        }),
      )
    }
    return created
  }

  private async readPage(
    pageId: string,
    token: string,
  ): Promise<{ id: string; name?: string; instagram_business_account?: { id?: string; username?: string } }> {
    if (stub()) return { id: pageId, name: 'Stub Page', instagram_business_account: { id: '17840000000000000', username: 'stub' } }
    const r = await graphCall<{ id: string; name?: string; instagram_business_account?: { id?: string; username?: string } }>(
      metaGraphBase(),
      pageId,
      { token, query: { fields: 'id,name,instagram_business_account{id,username}' } },
    )
    if (!r.ok) {
      throw new BadRequestException(
        errBody('meta_page_invalid', `Meta did not accept this Page id and token: ${r.error.message}`),
      )
    }
    return r.data
  }

  private async subscribePage(pageId: string, token: string): Promise<void> {
    if (stub()) return
    const r = await graphCall<{ success?: boolean }>(metaGraphBase(), `${pageId}/subscribed_apps`, {
      method: 'POST',
      token,
      query: { subscribed_fields: 'messages,messaging_postbacks' },
    })
    if (!r.ok || r.data.success === false) {
      throw new BadGatewayException(
        errBody(
          'meta_subscribe_failed',
          `Meta refused to subscribe the Page to our app${r.ok ? '' : `: ${r.error.message}`}`,
        ),
      )
    }
  }

  // ─── Outbound ───────────────────────────────────────────────────────

  async recipientForConversation(channel: MetaChannel, conversationId: string): Promise<string | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { inbox: { select: { channelType: true } }, contactInbox: { select: { sourceId: true } } },
    })
    if (!conv || conv.inbox.channelType !== channel) return null
    return conv.contactInbox?.sourceId ?? null
  }

  /** Messenger and Instagram allow free replies for 24 h after the contact's last message. */
  async windowFor(conversationId: string): Promise<MessagingWindow> {
    const last = await this.prisma.message.findFirst({
      where: { conversationId, senderType: 'CONTACT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (!last) return { open: false, lastInboundAt: null, expiresAt: null }
    const expires = new Date(last.createdAt.getTime() + WINDOW_MS)
    return {
      open: expires.getTime() > Date.now(),
      lastInboundAt: last.createdAt.toISOString(),
      expiresAt: expires.toISOString(),
    }
  }

  async sendText(channel: MetaChannel, inboxId: string, to: string, text: string): Promise<{ externalId: string | null }> {
    const max = META_TEXT_MAX[channel]
    let first: string | null = null
    for (let i = 0; i < text.length; i += max) {
      const id = await this.send(inboxId, to, { text: text.slice(i, i + max) })
      first ??= id
    }
    return { externalId: first }
  }

  async sendInteractive(
    inboxId: string,
    to: string,
    content: InteractiveContent,
  ): Promise<{ externalId: string | null }> {
    const options =
      content.kind === 'buttons'
        ? content.buttons.map((b) => ({ id: b.id, label: b.label }))
        : content.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, label: r.title })))
    if (options.length > QUICK_REPLY_MAX) {
      // Past Meta's limit: a numbered list the contact can answer by typing.
      const lines = options.map((o, i) => `${i + 1}. ${o.label}`)
      return { externalId: await this.send(inboxId, to, { text: [content.body, ...lines].join('\n') }) }
    }
    const externalId = await this.send(inboxId, to, {
      text: content.body,
      quick_replies: options.map((o) => ({
        content_type: 'text',
        title:
          o.label.length > QUICK_REPLY_TITLE_MAX
            ? o.label.slice(0, QUICK_REPLY_TITLE_MAX - 1) + '…'
            : o.label,
        payload: o.id,
      })),
    })
    return { externalId }
  }

  async sendMedia(
    channel: MetaChannel,
    inboxId: string,
    to: string,
    media: OutboundMedia,
  ): Promise<{ externalId: string | null }> {
    // Instagram Direct takes no documents: send the link instead.
    if (channel === 'INSTAGRAM' && media.kind === 'document') {
      const link = 'link' in media.source ? media.source.link : null
      const text = [media.caption, media.fileName, link].filter(Boolean).join('\n')
      return this.sendText(channel, inboxId, to, text)
    }
    const type = media.kind === 'document' ? 'file' : media.kind
    let first: string | null = null
    // Meta has no caption on attachments: the text goes first, on its own.
    if (media.caption) first = (await this.sendText(channel, inboxId, to, media.caption)).externalId
    let id: string | null
    if ('link' in media.source) {
      id = await this.send(inboxId, to, { attachment: { type, payload: { url: media.source.link, is_reusable: true } } })
    } else {
      id = await this.upload(inboxId, to, type, media.source, media.fileName)
    }
    return { externalId: first ?? id }
  }

  private async send(inboxId: string, to: string, message: Record<string, unknown>): Promise<string | null> {
    if (stub()) return `stub-meta-${Date.now()}`
    const cfg = await this.configFor(inboxId)
    const r = await graphCall<{ message_id?: string }>(metaGraphBase(), `${cfg.pageId}/messages`, {
      method: 'POST',
      token: cfg.pageAccessToken,
      body: { recipient: { id: to }, messaging_type: 'RESPONSE', message },
    })
    if (!r.ok) throw new Error(`Meta send failed (${r.error.status}): ${r.error.message}`)
    return r.data.message_id ?? null
  }

  /** Bytes with no public link: multipart upload with the message. */
  private async upload(
    inboxId: string,
    to: string,
    type: string,
    file: { buffer: Buffer; mimeType: string; fileName: string },
    fileName?: string,
  ): Promise<string | null> {
    if (stub()) return `stub-meta-${Date.now()}`
    const cfg = await this.configFor(inboxId)
    const form = new FormData()
    form.append('recipient', JSON.stringify({ id: to }))
    form.append('messaging_type', 'RESPONSE')
    form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }))
    form.append('filedata', new Blob([file.buffer], { type: file.mimeType }), fileName ?? file.fileName)
    const res = await fetch(`${metaGraphBase()}/${cfg.pageId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.pageAccessToken}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const data = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string } }
    if (!res.ok) throw new Error(`Meta upload failed (${res.status}): ${data.error?.message ?? 'unknown error'}`)
    return data.message_id ?? null
  }

  private async configFor(inboxId: string): Promise<PageConfig> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || (inbox.channelType !== 'FACEBOOK' && inbox.channelType !== 'INSTAGRAM')) {
      throw new NotFoundException()
    }
    return this.config(inbox)
  }

  private config(inbox: Inbox): PageConfig {
    const raw = (inbox.channelConfig ?? {}) as Record<string, unknown>
    const cfg = decryptSecretsIn(raw, META_PAGE_SECRET_FIELDS) as Partial<PageConfig>
    if (!cfg.pageId || !cfg.pageAccessToken) {
      throw new BadRequestException(errBody('meta_credentials_missing', 'This inbox is missing its Page token'))
    }
    return cfg as PageConfig
  }
}

