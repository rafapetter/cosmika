import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import * as Sentry from '@sentry/node'
import type { Contact, ContactInbox, FileType, Inbox, Message, Prisma } from '@cosmika/db'
import { WHATSAPP_SECRET_FIELDS, type InteractiveContent } from '@cosmika/shared'

import { decryptSecretsIn } from '../../common/secret-crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { AttachmentsService } from '../attachments/attachments.service'
import { RealtimeService } from '../realtime/realtime.service'
import { errBody } from '../../common/app-error'
import { phoneLookupVariants } from '../../common/phone'
import {
  ConversationsService,
  initialControlMode,
} from '../conversations/conversations.service'

type WaConfig = {
  phoneNumberId: string
  businessAccountId: string
  accessToken?: string
  appSecret?: string
  webhookVerifyToken?: string
}

// Shape of a template object from the Graph API `message_templates` edge.
export type MetaTemplate = {
  name: string
  language: string
  category: string
  status: string
  id?: string
  components?: Array<{
    type: string // HEADER | BODY | FOOTER | BUTTONS
    text?: string
    format?: string
  }>
}

// Fixture returned by fetchTemplatesFromMeta when COSMIKA_WHATSAPP_STUB=1, so
// the sync + send flows are exercisable without a live WhatsApp Business
// Account.
const STUB_TEMPLATES: MetaTemplate[] = [
  {
    name: 'hello_world',
    language: 'en_US',
    category: 'UTILITY',
    status: 'APPROVED',
    id: 'stub-hello-world',
    components: [{ type: 'BODY', text: 'Hello, welcome to our service!' }],
  },
  {
    name: 'appointment_reminder',
    language: 'pt_BR',
    category: 'UTILITY',
    status: 'APPROVED',
    id: 'stub-appt',
    components: [
      {
        type: 'BODY',
        text: 'Olá {{1}}, lembrete do seu atendimento em {{2}}.',
      },
    ],
  },
]

// Meta Business-Scoped User ID (2026 usernames rollout): "CC.alphanum", with
// an "ENT." segment for parent BSUIDs (e.g. "BR.13491208…", "US.ENT.11815…").
const WA_BSUID_REGEX = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/

export function isWaBsuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && WA_BSUID_REGEX.test(value)
}

// ─── Outbound media ─────────────────────────────────────────────────

/**
 * Ceiling for a file a contact sends us. Meta's own limit for a document is
 * 100 MB, so matching it means nothing Meta accepts is ever dropped by us.
 */
const INBOUND_MEDIA_MAX_BYTES = Number(
  process.env.WHATSAPP_INBOUND_MEDIA_MAX_BYTES ?? 100 * 1024 * 1024,
)

/** Per-request cap on the media lookup and download (see fetchInboundMedia). */
const INBOUND_MEDIA_TIMEOUT_MS = 10_000

/** Images, voice notes and videos arrive without a name; give them one. */
export function defaultFileName(mimeType: string | undefined): string {
  const subtype = mimeType?.split('/')[1]
  // `audio/ogg; codecs=opus` → `ogg`. split() always yields an element 0.
  const ext = subtype ? subtype.split(';')[0]!.trim() : ''
  return ext ? `whatsapp-media.${ext}` : 'whatsapp-media'
}

export type WaMediaKind = 'image' | 'video' | 'audio' | 'document'

/** Longest caption the Cloud API accepts on a media message. */
export const WA_CAPTION_MAX = 1024

// Mime types Meta accepts for each rich-media type. A png sent as `image` is
// fine, an svg is not — the Graph API rejects the whole send rather than
// degrading, so anything off these lists rides as a document instead.
const WA_IMAGE_MIME = new Set(['image/jpeg', 'image/png'])
const WA_VIDEO_MIME = new Set(['video/mp4', 'video/3gp', 'video/3gpp'])
const WA_AUDIO_MIME = new Set([
  'audio/aac',
  'audio/amr',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
])

/**
 * Meta's per-type size ceilings. Our own upload cap (ATTACHMENTS_MAX_BYTES,
 * 25MB by default) is well above the image one, so a perfectly acceptable
 * upload can still be too big to send as a photo.
 */
export const WA_MEDIA_MAX_BYTES: Record<WaMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
}

/**
 * Cloud API media type for one of our attachments. Falls back to `document`
 * whenever the richer type won't take it — an unsupported mime, or a file over
 * that type's size ceiling. A document send accepts any mime and allows 100MB,
 * so the contact still gets the file instead of a hard 400 from the Graph API.
 */
export function waMediaKind(
  fileType: FileType,
  mimeType: string | null,
  fileSize?: number | null,
): WaMediaKind {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0]!.trim()
  const fits = (kind: WaMediaKind) =>
    fileSize == null || fileSize <= WA_MEDIA_MAX_BYTES[kind]
  switch (fileType) {
    case 'IMAGE':
      return WA_IMAGE_MIME.has(mime) && fits('image') ? 'image' : 'document'
    case 'VIDEO':
      return WA_VIDEO_MIME.has(mime) && fits('video') ? 'video' : 'document'
    case 'AUDIO':
      return WA_AUDIO_MIME.has(mime) && fits('audio') ? 'audio' : 'document'
    default:
      return 'document'
  }
}

/**
 * Where the bytes come from: a URL Meta's servers fetch themselves, or the
 * file itself, which we upload to the media store first.
 */
export type WaMediaSource =
  | { link: string }
  | { buffer: Buffer; mimeType: string; fileName: string }

export type WaOutboundMedia = {
  kind: WaMediaKind
  source: WaMediaSource
  /** Shown as the file name on `document` sends; ignored for other kinds. */
  fileName?: string
  /** Dropped on `audio` sends — the Cloud API has no caption field there. */
  caption?: string
}

type CloudApiContactEntry = {
  // Phone number. Omitted once the user adopts a username and no 30-day
  // interaction window is open.
  wa_id?: string
  // BSUID — present on all webhooks since Meta's 2026 rollout.
  user_id?: string
  parent_user_id?: string
  profile?: { name?: string; username?: string }
}

type CloudApiInboundMessage = {
  from?: string // whatsapp ID (phone); omitted when the user's phone is hidden
  from_user_id?: string // BSUID; replaces `from` for username-only users
  id: string // wamid
  timestamp: string
  type:
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'location'
    | 'contacts'
    | 'sticker'
    | 'reaction'
    | 'button'
    | 'interactive'
    | 'unknown'
  text?: { body: string }
  image?: { caption?: string; mime_type?: string; sha256?: string; id?: string }
  audio?: { mime_type?: string; id?: string }
  video?: { caption?: string; mime_type?: string; id?: string }
  document?: { caption?: string; filename?: string; mime_type?: string; id?: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  // A reaction to an earlier message (either side's). An empty emoji means
  // the contact removed it.
  reaction?: { message_id?: string; emoji?: string }
  // Quick-reply button tap on a template message.
  button?: { text?: string; payload?: string }
  // Reply to an interactive (button/list) message.
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
}

type CloudApiWebhookEntry = {
  id: string
  changes: Array<{
    value: {
      messaging_product: 'whatsapp'
      metadata: { display_phone_number: string; phone_number_id: string }
      contacts?: CloudApiContactEntry[]
      messages?: CloudApiInboundMessage[]
      statuses?: Array<CloudApiStatusEntry>
    }
    field: 'messages'
  }>
}

export type CloudApiStatusEntry = {
  id: string // wamid of the OUTBOUND message this receipt is about
  recipient_id?: string // phone; omitted when sent to a BSUID
  recipient_user_id?: string // BSUID; always present since 2026
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  // Present on failed receipts. 131047 = 24h window closed, 131026 =
  // marketing cap / undeliverable — the async failure class that caused
  // Alos's "conversas não chegando" in Nebula.
  errors?: Array<{
    code: number
    title?: string
    message?: string
    error_data?: { details?: string }
  }>
}

type CloudApiWebhookPayload = {
  object: 'whatsapp_business_account'
  entry: CloudApiWebhookEntry[]
}

/** WhatsApp's customer-service window: 24h from the customer's last message. */
const WA_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Cloud API sends `timestamp` as Unix SECONDS in a string. Returns an ISO
 * string, or null for anything unparseable — a malformed timestamp must not
 * poison contentAttributes or make a live window look expired.
 */
export function externalCreatedAt(raw: unknown): string | null {
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs <= 0) return null
  const d = new Date(secs * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Read back the provider timestamp we stored, if it's there and valid. */
export function providerTimestamp(attrs: unknown): Date | null {
  if (!attrs || typeof attrs !== 'object') return null
  const raw = (attrs as Record<string, unknown>).external_created_at
  if (typeof raw !== 'string') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

@Injectable()
export class WhatsappService {
  private readonly graphBase =
    process.env.WHATSAPP_GRAPH_BASE_URL ?? 'https://graph.facebook.com/v20.0'

  private readonly logger = new Logger(WhatsappService.name)

  constructor(
    private readonly prisma: PrismaService,
    // forwardRef: conversations.service imports channels.service, which
    // imports this file back; depending on load order the class is still
    // undefined when this constructor's types are recorded.
    @Inject(forwardRef(() => ConversationsService))
    private readonly conversations: ConversationsService,
    private readonly realtime: RealtimeService,
    private readonly attachments: AttachmentsService,
  ) {}

  /**
   * This inbox's Cloud API credentials, unwrapped for immediate use.
   *
   * The secrets are encrypted at rest (see common/secret-crypto.ts), so every
   * consumer goes through here: the webhook verify token, the HMAC signature
   * check, outbound text, interactive and template sends, inbound media
   * downloads and the template sync. Nothing is cached: a plaintext token
   * exists only for the duration of the call that uses it.
   *
   * A value that predates encryption is returned as it is, so a channel that
   * has not been through the data migration keeps working.
   */
  private waConfig(inbox: Inbox): WaConfig | null {
    const raw = inbox.channelConfig
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return decryptSecretsIn(
      raw as unknown as Record<string, unknown>,
      WHATSAPP_SECRET_FIELDS,
    ) as unknown as WaConfig
  }

  // ─── Webhook subscription challenge ───────────────────────────────

  async verifyChallenge(
    inboxId: string,
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): Promise<string> {
    if (mode !== 'subscribe' || !token || !challenge) {
      throw new ForbiddenException()
    }
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.webhookVerifyToken || cfg.webhookVerifyToken !== token) {
      throw new ForbiddenException()
    }
    return challenge
  }

  // ─── Webhook event ingest ─────────────────────────────────────────

  async ingestWebhook(
    inboxId: string,
    rawBody: Buffer,
    signatureHeader: string | undefined,
    payload: CloudApiWebhookPayload,
  ): Promise<{ processed: number }> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.appSecret) {
      // Don't disclose that the inbox exists but is misconfigured — return
      // the same generic 403 as any other signature failure. Operators will
      // notice misconfigured inboxes via their own monitoring; an external
      // probe should learn nothing.
      throw new ForbiddenException('Forbidden')
    }
    this.verifySignature(rawBody, cfg.appSecret, signatureHeader)
    if (payload.object !== 'whatsapp_business_account') {
      throw new BadRequestException('Unexpected webhook object')
    }

    let processed = 0
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        // Cross-delivery guard: a Meta app's callback is app-level, so during
        // multi-number subscriptions a payload for ANOTHER number can arrive
        // at this inbox's URL. Processing it here would pollute this inbox
        // with another number's contacts and conversations — drop it instead
        // (the app subscribed for that number delivers its own copy).
        if (
          cfg.phoneNumberId &&
          value.metadata?.phone_number_id &&
          value.metadata.phone_number_id !== cfg.phoneNumberId
        ) {
          continue
        }
        const inboundMessages = value.messages ?? []
        const contacts = value.contacts ?? []
        for (const msg of inboundMessages) {
          // Pair the message with its contacts[] entry by phone or BSUID;
          // webhooks carry one entry per change, so fall back to the first.
          const contactEntry =
            contacts.find(
              (c) =>
                (msg.from != null && c.wa_id === msg.from) ||
                (msg.from_user_id != null && c.user_id === msg.from_user_id),
            ) ?? contacts[0]
          await this.processInboundMessage(inbox, msg, contactEntry)
          processed += 1
        }
        // Delivery receipts. Before 2026-08-15 these were acknowledged and
        // discarded, which left every outbound message frozen at SENT and
        // made async failures (131047 closed window, 131026 marketing cap)
        // invisible — the exact class behind Alos's "conversas não chegando".
        for (const st of value.statuses ?? []) {
          if (await this.processStatusUpdate(inbox, st)) processed += 1
        }
      }
    }
    return { processed }
  }

  /**
   * Advance an outbound message from a Meta delivery receipt.
   *
   * The ladder is monotonic (SENT→DELIVERED→READ) because receipts arrive
   * out of order; a FAILED verdict only yields to real progress (DELIVERED/
   * READ — e.g. a successful retry), never to a stale 'sent'. Returns false
   * for receipts we can't match, which includes every message sent before
   * wamids were stamped.
   */
  private async processStatusUpdate(
    inbox: Inbox,
    st: CloudApiStatusEntry,
  ): Promise<boolean> {
    const outbound = { inboxId: inbox.id, senderType: { not: 'CONTACT' as const } }
    const msg =
      (await this.prisma.message.findFirst({
        where: { ...outbound, externalSourceId: st.id },
      })) ??
      // Multi-part sends (text + media) stamp the first wamid on the column;
      // the rest live in contentAttributes.wamids.
      (await this.prisma.message.findFirst({
        where: {
          ...outbound,
          contentAttributes: { path: ['wamids'], array_contains: st.id },
        },
      }))
    if (!msg) return false

    const attrs = (msg.contentAttributes ?? {}) as Record<string, unknown>
    let nextStatus: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
    let nextAttrs = attrs

    if (st.status === 'failed') {
      const err = st.errors?.[0]
      nextStatus = 'FAILED'
      nextAttrs = {
        ...attrs,
        deliveryError: {
          code: err?.code ?? null,
          title: err?.title ?? null,
          detail: err?.message ?? err?.error_data?.details ?? null,
          at: externalCreatedAt(st.timestamp),
        },
      }
    } else {
      const rank: Record<string, number> = {
        PENDING: 0,
        SENT: 1,
        DELIVERED: 2,
        READ: 3,
      }
      nextStatus = st.status.toUpperCase() as 'SENT' | 'DELIVERED' | 'READ'
      if (msg.status === 'FAILED') {
        // Only genuine progress clears a failure; a late 'sent' receipt for
        // the same wamid must not hide it.
        if (nextStatus === 'SENT') return false
      } else if ((rank[nextStatus] ?? 0) <= (rank[msg.status] ?? 0)) {
        return false
      }
    }

    await this.prisma.message.update({
      where: { id: msg.id },
      data: {
        status: nextStatus,
        contentAttributes: nextAttrs as Prisma.InputJsonValue,
      },
    })
    await this.realtime.publish({
      type: 'MessageStatusChanged',
      accountId: msg.accountId,
      conversationId: msg.conversationId,
      inboxId: msg.inboxId,
      messageId: msg.id,
      status: nextStatus,
    })
    return true
  }

  /**
   * The message a wamid points at, on either side of the thread. Multi-part
   * sends keep their extra wamids in contentAttributes.wamids.
   */
  private async messageByWamid(inboxId: string, wamid: string) {
    return (
      (await this.prisma.message.findFirst({
        where: { inboxId, externalSourceId: wamid },
      })) ??
      (await this.prisma.message.findFirst({
        where: { inboxId, contentAttributes: { path: ['wamids'], array_contains: wamid } },
      }))
    )
  }

  /**
   * Put (or take off) the contact's reaction on the message it points at.
   * A reaction to something we never stored (older than the inbox, or a
   * message from another tool) has nothing to attach to and is dropped.
   */
  private async applyInboundReaction(
    inbox: Inbox,
    msg: CloudApiInboundMessage,
  ): Promise<void> {
    const targetWamid = msg.reaction?.message_id
    if (!targetWamid) return
    const target = await this.messageByWamid(inbox.id, targetWamid)
    if (!target) return
    await this.setReaction(target, 'contact', msg.reaction?.emoji ?? '', {
      at: externalCreatedAt(msg.timestamp) ?? new Date().toISOString(),
    })
  }

  /**
   * One reaction per side, as on the phone: a new emoji replaces the old
   * one and an empty emoji removes it. Open threads update in place.
   */
  async setReaction(
    target: Message,
    side: 'contact' | 'business',
    emoji: string,
    extra: Record<string, unknown> = {},
  ): Promise<Message> {
    const attrs = (target.contentAttributes ?? {}) as Record<string, unknown>
    const reactions = { ...((attrs.reactions ?? {}) as Record<string, unknown>) }
    if (emoji) reactions[side] = { emoji, ...extra }
    else delete reactions[side]
    const updated = await this.prisma.message.update({
      where: { id: target.id },
      data: { contentAttributes: { ...attrs, reactions } as Prisma.InputJsonValue },
    })
    await this.realtime.publish({
      type: 'MessageReactionChanged',
      accountId: target.accountId,
      conversationId: target.conversationId,
      inboxId: target.inboxId,
      messageId: target.id,
      reactions,
    })
    return updated
  }

  /**
   * React to a message in the contact's WhatsApp. `emoji: ''` removes our
   * reaction. Meta treats it as a free-form message, so it needs the 24h
   * service window like any reply.
   */
  async sendReaction(
    inboxId: string,
    toPhoneNumber: string,
    targetWamid: string,
    emoji: string,
  ): Promise<void> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') return
    const cfg = await this.requireSendConfig(inboxId)
    const res = await fetch(`${this.graphBase}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...this.recipientParams(toPhoneNumber),
        type: 'reaction',
        reaction: { message_id: targetWamid, emoji },
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp reaction failed (${res.status}): ${body}`)
    }
  }

  /**
   * Record the wamid(s) a send produced on the outbound Message row, so
   * delivery receipts can find it. REPLACES any previous stamp on purpose:
   * a retry produces a new wamid, and receipts for the dead one must stop
   * matching or a stale 'sent' would overwrite the retry's real status.
   */
  async stampOutbound(
    messageId: string,
    wamids: Array<string | null | undefined>,
  ): Promise<void> {
    const ids = wamids.filter((w): w is string => typeof w === 'string' && w !== '')
    if (ids.length === 0) return
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } })
    if (!msg) return
    const attrs = (msg.contentAttributes ?? {}) as Record<string, unknown>
    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        externalSourceId: ids[0],
        contentAttributes: { ...attrs, wamids: ids } as Prisma.InputJsonValue,
      },
    })
  }

  private verifySignature(
    rawBody: Buffer,
    appSecret: string,
    headerValue: string | undefined,
  ): void {
    if (!headerValue) throw new ForbiddenException('Forbidden')
    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
    const expectedFull = `sha256=${expected}`
    const a = Buffer.from(expectedFull)
    const b = Buffer.from(headerValue)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Forbidden')
    }
  }

  private async processInboundMessage(
    inbox: Inbox,
    msg: CloudApiInboundMessage,
    contactEntry: CloudApiContactEntry | undefined,
  ): Promise<void> {
    const accountId = inbox.accountId
    // Meta BSUID (2026): `from`/`wa_id` disappear once the user adopts a
    // username and the 30-day phone-visibility window lapses; `from_user_id`/
    // `user_id` (the business-scoped id) become the only identity.
    const waId = msg.from ?? contactEntry?.wa_id
    const bsuid = msg.from_user_id ?? contactEntry?.user_id
    if (!waId && !bsuid) return
    const username = contactEntry?.profile?.username
    const profileName = contactEntry?.profile?.name ?? username

    // 1. Resolve by BSUID first — it is the durable key; the phone can come
    //    and go from webhooks.
    const byBsuid = bsuid
      ? await this.prisma.contactInbox.findFirst({
          where: { inboxId: inbox.id, bsuid },
          include: { contact: true },
        })
      : null
    let contactInbox: ContactInbox | null = byBsuid
    let contact: Contact | null = byBsuid?.contact ?? null

    if (!contact && waId) {
      // 2. Phone fallback — also the whole path for pre-BSUID webhooks.
      // Meta sends wa_id as bare digits; migrated/Nebula-era contacts store
      // E.164 with a leading '+' — match both or every migrated contact
      // looks brand-new (found live 2026-08-04: dropped inbound + duplicate
      // contacts on the first real message after cutover).
      contact = await this.prisma.contact.findFirst({
        // Also with and without Brazil's ninth digit: a contact who first
        // typed their number in the website chat must be found here, so
        // Webchat and WhatsApp share one contact (and one protocol).
        where: { accountId, phoneNumber: { in: phoneLookupVariants(waId) } },
      })
    } else if (contact && contactInbox && waId && !contact.phoneNumber) {
      // A BSUID-keyed contact just became phone-visible again. If that phone
      // already belongs to another contact (pre-username history), the two
      // records are the same human — fold the BSUID one into it.
      const phoneContact = await this.prisma.contact.findFirst({
        where: { accountId, phoneNumber: waId, id: { not: contact.id } },
      })
      if (phoneContact) {
        const merged = await this.mergeBsuidContactIntoPhoneContact(
          inbox,
          contactInbox,
          contact,
          phoneContact,
          bsuid as string,
        )
        contact = merged.contact
        contactInbox = merged.contactInbox
      } else {
        contact = await this.prisma.contact.update({
          where: { id: contact.id },
          data: { phoneNumber: waId },
        })
      }
    }

    // 2.5. Last resolution before creating anything: the (inboxId, sourceId)
    // pair is unique, so if a ContactInbox already carries this wa_id, that
    // row's contact IS this sender — creating would only trip the unique
    // constraint and drop the message.
    if (!contact && waId) {
      const bySource = await this.prisma.contactInbox.findUnique({
        where: { inboxId_sourceId: { inboxId: inbox.id, sourceId: waId } },
        include: { contact: true },
      })
      if (bySource) {
        contactInbox = bySource
        contact = bySource.contact
      }
    }

    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          accountId,
          phoneNumber: waId ?? null,
          name: profileName ?? null,
          identifier: `whatsapp:${waId ?? bsuid}`,
          ...(username ? { additionalAttributes: { whatsappUsername: username } } : {}),
        },
      })
    } else if (profileName && !contact.name) {
      contact = await this.prisma.contact.update({
        where: { id: contact.id },
        data: { name: profileName },
      })
    }

    // Blocked contact — drop the inbound message silently.
    if (contact.blockedAt) return

    // A reaction is not a message: it decorates one that is already in the
    // thread. Stored as a message it showed up as "[reaction]", woke the bot
    // and the AI (which thanked the contact for a thumbs-up), and could even
    // open a new conversation after the old one closed.
    if (msg.type === 'reaction') {
      await this.applyInboundReaction(inbox, msg)
      return
    }

    // 3. ContactInbox row — sourceId = phone when known, else the BSUID.
    if (!contactInbox) {
      contactInbox = await this.prisma.contactInbox.findUnique({
        where: { contactId_inboxId: { contactId: contact.id, inboxId: inbox.id } },
      })
    }
    if (!contactInbox) {
      contactInbox = await this.prisma.contactInbox.create({
        data: {
          contactId: contact.id,
          inboxId: inbox.id,
          sourceId: waId ?? (bsuid as string),
          ...(bsuid ? { bsuid } : {}),
        },
      })
    } else {
      const patch: { bsuid?: string; sourceId?: string } = {}
      if (bsuid && contactInbox.bsuid !== bsuid) patch.bsuid = bsuid
      // Upgrade a BSUID-keyed sourceId back to the phone when it reappears,
      // so outbound goes back to `to` (Meta prefers phone addressing).
      if (waId && contactInbox.sourceId !== waId && isWaBsuid(contactInbox.sourceId)) {
        patch.sourceId = waId
      }
      if (Object.keys(patch).length > 0) {
        contactInbox = await this.prisma.contactInbox.update({
          where: { id: contactInbox.id },
          data: patch,
        })
      }
    }

    // 4. De-dupe by externalSourceId (wamid) BEFORE touching conversations —
    // Cloud API retries on 5xx. Checked across the inbox, not one
    // conversation: if the conversation that received the first delivery was
    // closed in the meantime, a retry must not open (and bill) a new one.
    const existing = await this.prisma.message.findFirst({
      where: { inboxId: inbox.id, externalSourceId: msg.id },
      select: { id: true },
    })
    if (existing) return

    // 5. Find or create the Conversation. Only a conversation still in
    // progress is reused. A closed conversation is never reopened: a contact
    // who writes after it closed starts a new one, which counts on the plan's
    // monthly meter and runs the inbox's flow from the start (Terms 4.2).
    //
    // The lock makes "look, then create" atomic per contact and inbox. Two
    // messages sent in quick succession arrive as two webhooks; without it
    // both would find nothing in progress and each open its own conversation,
    // billing the customer twice for one contact.
    const contactInboxId = contactInbox.id
    const contactId = contact.id
    const { conversation, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${contactInboxId}))`
      const inProgress = await tx.conversation.findFirst({
        where: {
          accountId,
          inboxId: inbox.id,
          contactId,
          status: { not: 'RESOLVED' },
        },
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
          // A contact wrote in on WhatsApp: billable from the first message.
          origin: 'INBOUND',
          billableAt: new Date(),
        },
      })
      return { conversation: fresh, created: true }
    })
    if (created) {
      // The console list refetches on this — without it a brand-new customer
      // conversation only appears after a manual refresh.
      await this.realtime.publish({
        type: 'ConversationCreated',
        accountId,
        conversationId: conversation.id,
        inboxId: inbox.id,
        contactId,
        createdAt: conversation.createdAt.toISOString(),
      })
    }

    // 6. Translate Cloud API content shape → our message shape.
    const { content, contentType, contentAttributes } = this.normalizeContent(msg)

    // 7. Media arrives as a Meta id, not a file. Pull it into our storage
    //    BEFORE the message exists, so the thread, realtime and the AI turn
    //    all see the file. This step used to be missing entirely: the id was
    //    stored and nothing ever fetched it, so every photo, voice note and
    //    document a contact sent vanished without a trace.
    let attachmentIds: string[] | undefined
    const mediaId = contentAttributes.mediaId
    if (typeof mediaId === 'string' && mediaId) {
      const got = await this.fetchInboundMedia(inbox, mediaId, {
        mimeType: contentAttributes.mimeType as string | undefined,
        fileName: contentAttributes.filename as string | undefined,
      })
      if ('attachmentId' in got) {
        attachmentIds = [got.attachmentId]
      } else {
        // Keep the message; record why the file is missing so a backfill
        // can find it and a human can see something went wrong.
        contentAttributes.mediaDownloadError = got.error
      }
    }

    await this.conversations.ingestExternalInbound({
      accountId,
      conversationId: conversation.id,
      content,
      contentType,
      attachmentIds,
      // WhatsApp anchors the 24h service window on ITS timestamp, not on when
      // the webhook reached us. A phone that was offline syncs late, so
      // arrival time overestimates how much window is left. Keep the provider
      // time under upstream's key so both systems read the same field.
      contentAttributes: {
        ...contentAttributes,
        ...(externalCreatedAt(msg.timestamp)
          ? { external_created_at: externalCreatedAt(msg.timestamp) }
          : {}),
      },
      externalSourceId: msg.id,
    })
  }

  /**
   * The same human exists twice: `phoneContact` (pre-username history) and
   * `strayContact` (created while the phone was hidden, keyed by BSUID via
   * `bsuidCi`). Fold the stray into the phone contact so the thread history
   * lands in one place.
   */
  private async mergeBsuidContactIntoPhoneContact(
    inbox: Inbox,
    bsuidCi: ContactInbox,
    strayContact: Contact,
    phoneContact: Contact,
    bsuid: string,
  ): Promise<{ contact: Contact; contactInbox: ContactInbox }> {
    return this.prisma.$transaction(async (tx) => {
      const phoneCi = await tx.contactInbox.findUnique({
        where: {
          contactId_inboxId: { contactId: phoneContact.id, inboxId: inbox.id },
        },
      })
      if (phoneCi) {
        await tx.conversation.updateMany({
          where: { contactInboxId: bsuidCi.id },
          data: { contactInboxId: phoneCi.id },
        })
      }
      await tx.conversation.updateMany({
        where: { contactId: strayContact.id },
        data: { contactId: phoneContact.id },
      })
      await tx.message.updateMany({
        where: { senderContactId: strayContact.id },
        data: { senderContactId: phoneContact.id },
      })
      await tx.contactNote.updateMany({
        where: { contactId: strayContact.id },
        data: { contactId: phoneContact.id },
      })
      let keptCi: ContactInbox
      if (phoneCi) {
        await tx.contactInbox.delete({ where: { id: bsuidCi.id } })
        keptCi = await tx.contactInbox.update({
          where: { id: phoneCi.id },
          data: { bsuid },
        })
      } else {
        // The phone contact never used this inbox — keep the BSUID
        // contact_inbox and just repoint it.
        keptCi = await tx.contactInbox.update({
          where: { id: bsuidCi.id },
          data: { contactId: phoneContact.id },
        })
      }
      await tx.contact.delete({ where: { id: strayContact.id } })
      return { contact: phoneContact, contactInbox: keptCi }
    })
  }

  /**
   * Fetch a file a contact sent from Meta and store it as a draft attachment.
   *
   * Meta hands us an id, not the bytes: a lookup returns a short-lived URL,
   * and the URL needs the same bearer token. Never throws — losing the file
   * must never lose the message it came with, so failures come back as a
   * reason the caller records.
   */
  private async fetchInboundMedia(
    inbox: Inbox,
    mediaId: string,
    hint: { mimeType?: string; fileName?: string },
    messageId?: string,
  ): Promise<{ attachmentId: string } | { error: string }> {
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken) return { error: 'inbox has no access token' }
    const auth = { authorization: `Bearer ${cfg.accessToken}` }
    // The webhook answers Meta only after this runs, and the duplicate check
    // keys on a message row that doesn't exist yet. A slow download would let
    // a Meta retry slip past it, so each call is capped; a timeout lands as
    // `mediaDownloadError` and the backfill picks it up.
    const signal = () => AbortSignal.timeout(INBOUND_MEDIA_TIMEOUT_MS)
    try {
      const lookup = await fetch(`${this.graphBase}/${mediaId}`, {
        headers: auth,
        signal: signal(),
      })
      if (!lookup.ok) return { error: `media lookup failed (${lookup.status})` }
      const meta = (await lookup.json()) as {
        url?: string
        mime_type?: string
        file_size?: number
      }
      if (!meta.url) return { error: 'media lookup returned no url' }
      if ((meta.file_size ?? 0) > INBOUND_MEDIA_MAX_BYTES) {
        return { error: `media too large (${meta.file_size} bytes)` }
      }
      const file = await fetch(meta.url, { headers: auth, signal: signal() })
      if (!file.ok) return { error: `media download failed (${file.status})` }
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = hint.mimeType ?? meta.mime_type
      const att = await this.attachments.ingestFromChannel(
        inbox.accountId,
        { buffer, mimeType, fileName: hint.fileName ?? defaultFileName(mimeType) },
        messageId,
      )
      return { attachmentId: att.id }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn(`inbound media ${mediaId} not stored: ${reason}`)
      Sentry.captureException(err)
      return { error: reason }
    }
  }

  /**
   * Recover media for messages that arrived before inbound downloads existed
   * (or whose download failed). Meta only keeps received media for a limited
   * time, so this is worth running promptly; anything already expired is
   * reported, not retried forever.
   */
  async backfillInboundMedia(
    inboxId: string,
  ): Promise<{ recovered: number; failed: Array<{ messageId: string; error: string }> }> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox) throw new NotFoundException()
    const candidates = await this.prisma.message.findMany({
      where: {
        inboxId,
        senderType: 'CONTACT',
        contentType: { in: ['IMAGE', 'AUDIO', 'VIDEO', 'FILE'] },
        attachments: { none: {} },
      },
      select: { id: true, contentAttributes: true },
    })
    let recovered = 0
    const failed: Array<{ messageId: string; error: string }> = []
    for (const m of candidates) {
      const attrs = (m.contentAttributes ?? {}) as Record<string, unknown>
      // Stickers ride as FILE with no media id; nothing to fetch.
      if (typeof attrs.mediaId !== 'string' || !attrs.mediaId) continue
      const got = await this.fetchInboundMedia(
        inbox,
        String(attrs.mediaId),
        {
          mimeType: attrs.mimeType as string | undefined,
          fileName: attrs.filename as string | undefined,
        },
        m.id,
      )
      if ('attachmentId' in got) recovered += 1
      else failed.push({ messageId: m.id, error: got.error })
    }
    return { recovered, failed }
  }

  private normalizeContent(msg: CloudApiInboundMessage): {
    content: string
    contentType:
      | 'TEXT'
      | 'IMAGE'
      | 'VIDEO'
      | 'AUDIO'
      | 'FILE'
      | 'LOCATION'
      | 'CONTACT_CARD'
    contentAttributes: Record<string, unknown>
  } {
    switch (msg.type) {
      case 'text':
        return {
          content: msg.text?.body ?? '',
          contentType: 'TEXT',
          contentAttributes: {},
        }
      case 'image':
        return {
          content: msg.image?.caption ?? '[image]',
          contentType: 'IMAGE',
          contentAttributes: { mediaId: msg.image?.id, mimeType: msg.image?.mime_type },
        }
      case 'audio':
        return {
          content: '[audio]',
          contentType: 'AUDIO',
          contentAttributes: { mediaId: msg.audio?.id, mimeType: msg.audio?.mime_type },
        }
      case 'video':
        return {
          content: msg.video?.caption ?? '[video]',
          contentType: 'VIDEO',
          contentAttributes: { mediaId: msg.video?.id, mimeType: msg.video?.mime_type },
        }
      case 'document':
        return {
          content: msg.document?.caption ?? msg.document?.filename ?? '[document]',
          contentType: 'FILE',
          contentAttributes: {
            mediaId: msg.document?.id,
            mimeType: msg.document?.mime_type,
            filename: msg.document?.filename,
          },
        }
      case 'location':
        return {
          content:
            msg.location?.name ?? `📍 ${msg.location?.latitude},${msg.location?.longitude}`,
          contentType: 'LOCATION',
          contentAttributes: {
            latitude: msg.location?.latitude,
            longitude: msg.location?.longitude,
            address: msg.location?.address,
          },
        }
      case 'sticker':
        return {
          content: '[sticker]',
          contentType: 'FILE',
          contentAttributes: { sticker: true },
        }
      case 'contacts':
        return {
          content: '[contact card]',
          contentType: 'CONTACT_CARD',
          contentAttributes: {},
        }
      case 'button':
        // Quick-reply tap on a template: carry the payload so a flow can route.
        return {
          content: msg.button?.text ?? '',
          contentType: 'TEXT',
          contentAttributes: { interactiveReplyId: msg.button?.payload ?? null },
        }
      case 'interactive': {
        // Button/list reply: `content` is the human-readable title; the
        // selected option id is preserved for deterministic flow routing.
        const reply =
          msg.interactive?.button_reply ?? msg.interactive?.list_reply
        return {
          content: reply?.title ?? '',
          contentType: 'TEXT',
          contentAttributes: { interactiveReplyId: reply?.id ?? null },
        }
      }
      default:
        return {
          content: `[${msg.type}]`,
          contentType: 'TEXT',
          contentAttributes: { rawType: msg.type },
        }
    }
  }

  // ─── Outbound ─────────────────────────────────────────────────────

  /**
   * Cloud API addressing: phone numbers go in `to`, BSUIDs (username-only
   * users) go in `recipient` (Meta 2026).
   */
  private recipientParams(to: string): { to: string } | { recipient: string } {
    return isWaBsuid(to) ? { recipient: to } : { to }
  }

  /**
   * Recipient identifier for a conversation: the contact's phone when known,
   * else the contact_inbox's BSUID sourceId (username-only WhatsApp users).
   * Returns null when the conversation has no addressable identity.
   */
  async resolveRecipient(conversationId: string): Promise<string | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        contact: { select: { phoneNumber: true } },
        contactInbox: { select: { sourceId: true } },
      },
    })
    if (!conv) return null
    if (conv.contact.phoneNumber) return conv.contact.phoneNumber
    return isWaBsuid(conv.contactInbox.sourceId) ? conv.contactInbox.sourceId : null
  }

  /**
   * State of the WhatsApp 24-hour customer-service window for a conversation.
   *
   * The window opens on the customer's last inbound message and closes 24h
   * later; while shut, only an approved template may be sent. Anchored on the
   * provider's timestamp where we have it (`external_created_at`), falling
   * back to row creation time for messages ingested before we captured it and
   * for anything migrated — those degrade to the old approximation rather
   * than reporting nonsense.
   *
   * `open: false` with a null `lastInboundAt` means the customer has never
   * written, so no window was ever opened.
   */
  async messagingWindowFor(conversationId: string): Promise<{
    open: boolean
    lastInboundAt: string | null
    expiresAt: string | null
  }> {
    const last = await this.prisma.message.findFirst({
      where: { conversationId, senderType: 'CONTACT' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, contentAttributes: true },
    })
    if (!last) return { open: false, lastInboundAt: null, expiresAt: null }
    const anchor = providerTimestamp(last.contentAttributes) ?? last.createdAt
    const expires = new Date(anchor.getTime() + WA_WINDOW_MS)
    return {
      open: expires.getTime() > Date.now(),
      lastInboundAt: anchor.toISOString(),
      expiresAt: expires.toISOString(),
    }
  }

  /**
   * Who to send to for this conversation, or null when nobody is reachable:
   * the inbox isn't WhatsApp, the conversation is gone, or the contact has
   * neither a phone number nor a BSUID.
   *
   * Every outbound path needs exactly this decision, and each one used to
   * open-code it as `contact?.phoneNumber ?? resolveRecipient(id)` — where
   * the first half duplicates what `resolveRecipient` already does. Four
   * copies of a rule is four chances to drop half of it.
   */
  async recipientForConversation(conversationId: string): Promise<string | null> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        inbox: { select: { channelType: true } },
        contact: { select: { phoneNumber: true } },
        contactInbox: { select: { sourceId: true } },
      },
    })
    if (!conv || conv.inbox.channelType !== 'WHATSAPP') return null
    if (conv.contact.phoneNumber) return conv.contact.phoneNumber
    return isWaBsuid(conv.contactInbox.sourceId) ? conv.contactInbox.sourceId : null
  }

  /**
   * Send a text message to a WhatsApp contact via Cloud API.
   * Called by ConversationsService.sendAgentMessage when the inbox is WHATSAPP.
   * `toPhoneNumber` may also be a BSUID (see recipientParams).
   */
  async sendOutbound(
    inboxId: string,
    toPhoneNumber: string,
    text: string,
  ): Promise<{ wamid: string | null }> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return { wamid: `stub-${Date.now()}` }
    }
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken || !cfg.phoneNumberId) {
      throw new BadRequestException(errBody('whatsapp_credentials_missing', 'WhatsApp inbox missing credentials'))
    }
    const url = `${this.graphBase}/${cfg.phoneNumberId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...this.recipientParams(toPhoneNumber),
        type: 'text',
        text: { body: text },
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp send failed (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> }
    return { wamid: data.messages?.[0]?.id ?? null }
  }

  /**
   * Inbox credentials for a send. Same failure modes the other outbound
   * methods raise: 404 for an inbox that isn't a live WhatsApp one, 400 when
   * it exists but was never given Cloud API credentials.
   */
  private async requireSendConfig(inboxId: string): Promise<WaConfig> {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken || !cfg.phoneNumberId) {
      throw new BadRequestException(errBody('whatsapp_credentials_missing', 'WhatsApp inbox missing credentials'))
    }
    return cfg
  }

  /**
   * Upload a file to the Cloud API media store and return its media id. Used
   * for attachments Meta can't fetch by URL — local-disk storage, or an S3
   * endpoint that only resolves inside our network. Media ids live 30 days,
   * far longer than the send that follows.
   */
  async uploadMedia(
    inboxId: string,
    file: { buffer: Buffer; mimeType: string; fileName: string },
  ): Promise<string> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return `stub-media-${Date.now()}`
    }
    const cfg = await this.requireSendConfig(inboxId)
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', file.mimeType)
    form.append(
      'file',
      new Blob([file.buffer], { type: file.mimeType }),
      file.fileName,
    )
    const res = await fetch(`${this.graphBase}/${cfg.phoneNumberId}/media`, {
      method: 'POST',
      // No content-type header — fetch derives it, boundary included.
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      body: form,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp media upload failed (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { id?: string }
    if (!data.id) throw new Error('WhatsApp media upload returned no media id')
    return data.id
  }

  /**
   * Send an image / video / audio / document to a WhatsApp contact. Called by
   * ConversationsService when an agent's message carries attachments.
   * `toPhoneNumber` may also be a BSUID (see recipientParams).
   */
  async sendMedia(
    inboxId: string,
    toPhoneNumber: string,
    media: WaOutboundMedia,
  ): Promise<{ wamid: string | null }> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return { wamid: `stub-media-msg-${Date.now()}` }
    }
    const source = media.source
    const mediaRef =
      'link' in source
        ? { link: source.link }
        : { id: await this.uploadMedia(inboxId, source) }
    const cfg = await this.requireSendConfig(inboxId)
    const mediaObject: Record<string, unknown> = { ...mediaRef }
    if (media.kind === 'document' && media.fileName) {
      mediaObject.filename = media.fileName
    }
    if (media.kind !== 'audio' && media.caption) {
      mediaObject.caption = media.caption
    }
    const url = `${this.graphBase}/${cfg.phoneNumberId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...this.recipientParams(toPhoneNumber),
        type: media.kind,
        [media.kind]: mediaObject,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp media send failed (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> }
    return { wamid: data.messages?.[0]?.id ?? null }
  }

  /**
   * Send an interactive message — reply buttons (≤3) or a list (≤10 rows).
   * Used by the flow engine for choice / picture-choice blocks.
   */
  async sendInteractive(
    inboxId: string,
    toPhoneNumber: string,
    content: InteractiveContent,
  ): Promise<{ wamid: string | null }> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return { wamid: `stub-int-${Date.now()}` }
    }
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken || !cfg.phoneNumberId) {
      throw new BadRequestException(errBody('whatsapp_credentials_missing', 'WhatsApp inbox missing credentials'))
    }
    const interactive =
      content.kind === 'buttons'
        ? {
            type: 'button',
            body: { text: content.body },
            action: {
              buttons: content.buttons.map((b) => ({
                type: 'reply',
                reply: { id: b.id, title: b.label },
              })),
            },
          }
        : {
            type: 'list',
            body: { text: content.body },
            action: {
              button: content.buttonText,
              sections: content.sections.map((s) => ({
                ...(s.title ? { title: s.title } : {}),
                rows: s.rows.map((r) => ({
                  id: r.id,
                  title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              })),
            },
          }
    const url = `${this.graphBase}/${cfg.phoneNumberId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...this.recipientParams(toPhoneNumber),
        type: 'interactive',
        interactive,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp interactive send failed (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> }
    return { wamid: data.messages?.[0]?.id ?? null }
  }

  /**
   * Send a pre-approved template (HSM) message. This is the only way to reach
   * a contact proactively or outside the 24h customer-service window.
   * `bodyParams` fill the template body's {{1}}..{{n}} placeholders in order.
   */
  async sendTemplate(
    inboxId: string,
    toPhoneNumber: string,
    name: string,
    language: string,
    bodyParams: string[],
  ): Promise<{ wamid: string | null }> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return { wamid: `stub-tmpl-${Date.now()}` }
    }
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken || !cfg.phoneNumberId) {
      throw new BadRequestException(errBody('whatsapp_credentials_missing', 'WhatsApp inbox missing credentials'))
    }
    const components =
      bodyParams.length > 0
        ? [
            {
              type: 'body',
              parameters: bodyParams.map((text) => ({ type: 'text', text })),
            },
          ]
        : []
    const url = `${this.graphBase}/${cfg.phoneNumberId}/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...this.recipientParams(toPhoneNumber),
        type: 'template',
        template: { name, language: { code: language }, components },
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`WhatsApp template send failed (${res.status}): ${body}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> }
    return { wamid: data.messages?.[0]?.id ?? null }
  }

  // ─── Template sync (Graph API) ────────────────────────────────────

  /**
   * Fetch this inbox's approved templates from the WhatsApp Business Account
   * via the Graph API. Returns the raw Meta template objects. Stubbed to a
   * small fixture set when COSMIKA_WHATSAPP_STUB=1 so the sync flow is
   * testable without a live WABA.
   */
  async fetchTemplatesFromMeta(inboxId: string): Promise<MetaTemplate[]> {
    if (process.env.COSMIKA_WHATSAPP_STUB === '1') {
      return STUB_TEMPLATES
    }
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.channelType !== 'WHATSAPP') throw new NotFoundException()
    const cfg = this.waConfig(inbox)
    if (!cfg?.accessToken || !cfg.businessAccountId) {
      throw new BadRequestException(errBody('whatsapp_credentials_missing', 'WhatsApp inbox missing credentials'))
    }
    const url = `${this.graphBase}/${cfg.businessAccountId}/message_templates?limit=200`
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
    })
    if (!res.ok) {
      const body = await res.text()
      // Operator-triggered, so it gets a code the interface can word.
      throw new BadGatewayException(
        errBody('whatsapp_sync_failed', `WhatsApp template sync failed (${res.status}): ${body}`),
      )
    }
    const data = (await res.json()) as { data?: MetaTemplate[] }
    return data.data ?? []
  }
}
