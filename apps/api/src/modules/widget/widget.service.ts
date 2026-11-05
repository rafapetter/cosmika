import { randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Inbox, Message, Prisma } from '@cosmika/db'
import { InteractiveContent } from '@cosmika/shared'
import type { WidgetPreChatField, WidgetPublicConfig } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { OrchestratorService } from '../ai/orchestrator.service'
import { RealtimeService } from '../realtime/realtime.service'
import { initialControlMode } from '../conversations/conversations.service'
import { FlowRunnerService } from '../flows/flow-runner.service'
import { AssignmentService } from '../assignment/assignment.service'

import { normalizePhone, phoneLookupVariants } from '../../common/phone'

import { buildEmbedScript } from './widget-embed'
import {
  VisitorJwtPayload,
  signVisitorJwt,
  verifyVisitorJwt,
} from './widget-jwt'

/**
 * What the visitor's chat box renders. Only public fields: a menu's options
 * and a flow bubble's media link, never the rest of contentAttributes (which
 * carries delivery ids, AI markers and other internals).
 */
export type WidgetMessage = {
  id: string
  senderType: string
  content: string | null
  createdAt: string
  contentType: string
  interactive?: InteractiveContent
  media?: { type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'; url: string }
}

const MEDIA_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'FILE'])

/** Pre-chat keys taken as a phone number even when the field isn't typed 'phone'. */
const PHONE_KEYS = /^(phone|telefone|celular|whatsapp|fone)$/i

export function toWidgetMessage(m: Message): WidgetMessage {
  const out: WidgetMessage = {
    id: m.id,
    senderType: m.senderType,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    contentType: m.contentType,
  }
  if (m.contentType === 'QUICK_REPLIES') {
    const parsed = InteractiveContent.safeParse(m.contentAttributes)
    if (parsed.success) out.interactive = parsed.data
  } else if (MEDIA_TYPES.has(m.contentType)) {
    const url = (m.contentAttributes as Record<string, unknown> | null)?.url
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      out.media = { type: m.contentType as NonNullable<WidgetMessage['media']>['type'], url }
    }
  }
  return out
}

export type WidgetSessionResult = {
  visitorToken: string
  conversationId: string
  contactId: string
  expiresAt: string
}

@Injectable()
export class WidgetService {
  private readonly logger = new Logger(WidgetService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orchestrator: OrchestratorService,
    private readonly realtime: RealtimeService,
    private readonly flowRunner: FlowRunnerService,
    private readonly assignment: AssignmentService,
  ) {}

  private jwtSecret(): string {
    const s = this.config.get<string>('WIDGET_JWT_SECRET')
    if (!s || s.length < 16) {
      throw new Error(
        'WIDGET_JWT_SECRET is unset or too short (need ≥ 16 chars)',
      )
    }
    return s
  }

  /** Resolve a public widget hash to its inbox, or 404. */
  async resolveInbox(hash: string): Promise<Inbox> {
    if (!hash || hash.length < 16) throw new NotFoundException()
    // Channel config is a JSON blob; Prisma supports a path-based filter.
    const inbox = await this.prisma.inbox.findFirst({
      where: {
        channelType: 'WEB_WIDGET',
        channelConfig: { path: ['widgetHash'], equals: hash },
      },
    })
    if (!inbox) throw new NotFoundException()
    return inbox
  }

  /**
   * Public, secret-free widget config for the embed/host page: appearance +
   * the pre-chat field definitions. Never exposes the hash, websiteUrl, or any
   * other internal config.
   */
  async publicConfig(hash: string): Promise<WidgetPublicConfig> {
    const inbox = await this.resolveInbox(hash)
    const c = (inbox.channelConfig ?? {}) as Record<string, unknown>
    const str = (v: unknown): string | null =>
      typeof v === 'string' ? v : null
    return {
      title: str(c.websiteName) ?? inbox.name,
      primaryColor: str(c.primaryColor),
      welcomeMessage: str(c.welcomeMessage),
      launcherText: str(c.launcherText),
      preChatFields: Array.isArray(c.preChatFields)
        ? (c.preChatFields as WidgetPreChatField[])
        : [],
    }
  }

  /**
   * Create or reuse a visitor session. Visitor identity is keyed by
   * `visitorId` (a client-generated UUID kept in the visitor's localStorage)
   * stored as ContactInbox.sourceId.
   */
  async createSession(input: {
    hash: string
    visitorId?: string
    name?: string
    email?: string
    origin?: string
    preChat?: Record<string, string>
  }): Promise<WidgetSessionResult> {
    const inbox = await this.resolveInbox(input.hash)

    // Optional CORS gate: if the inbox has a configured websiteUrl, refuse
    // requests from other origins.
    this.assertOriginAllowed(inbox, input.origin)

    // Pre-chat answers: `name`/`email` map to contact columns; any other key
    // is stored on the contact's customAttributes. Explicit name/email params
    // (legacy) win over preChat values.
    const pre = input.preChat ?? {}
    const name = input.name ?? (typeof pre.name === 'string' ? pre.name : undefined)
    const email =
      input.email ?? (typeof pre.email === 'string' ? pre.email : undefined)
    const extraAttrs: Record<string, string> = {}
    for (const [k, v] of Object.entries(pre)) {
      if (k !== 'name' && k !== 'email') extraAttrs[k] = v
    }
    const hasExtra = Object.keys(extraAttrs).length > 0
    // A phone answer becomes the contact's phone: a field typed 'phone', or
    // one whose key says so. That is what joins this visitor to the same
    // person's WhatsApp contact (and protocol).
    const fields = Array.isArray((inbox.channelConfig as Record<string, unknown> | null)?.preChatFields)
      ? ((inbox.channelConfig as Record<string, unknown>).preChatFields as WidgetPreChatField[])
      : []
    const phoneKey =
      fields.find((f) => f.type === 'phone' && typeof pre[f.key] === 'string')?.key ??
      Object.keys(pre).find((k) => PHONE_KEYS.test(k))
    const phone = phoneKey ? normalizePhone(pre[phoneKey]) : null

    const visitorId =
      input.visitorId && input.visitorId.length >= 8
        ? input.visitorId.slice(0, 64)
        : randomBytes(12).toString('hex')

    const { contactId, conversationId } = await this.prisma.$transaction(
      async (tx) => {
        // Try to find an existing ContactInbox by (inboxId, sourceId).
        let contactInbox = await tx.contactInbox.findUnique({
          where: { inboxId_sourceId: { inboxId: inbox.id, sourceId: visitorId } },
        })

        let cid: string
        if (contactInbox) {
          cid = contactInbox.contactId
          // Blocked contact — refuse to open a widget session.
          const existing = await tx.contact.findUnique({
            where: { id: cid },
            select: { blockedAt: true, customAttributes: true },
          })
          if (existing?.blockedAt) throw new ForbiddenException('Contact is blocked')
          if (name || email || hasExtra || phone) {
            await tx.contact.update({
              where: { id: cid },
              data: {
                ...(name && { name }),
                ...(email && { email }),
                ...(phone && { phoneNumber: phone }),
                ...(hasExtra && {
                  customAttributes: {
                    ...((existing?.customAttributes as Record<string, unknown>) ??
                      {}),
                    ...extraAttrs,
                  } as Prisma.InputJsonValue,
                }),
              },
            })
          }
        } else {
          // Someone the account already knows by this phone (from WhatsApp,
          // say) is the same person: open the chat on that contact instead of
          // a new anonymous one.
          const known = phone
            ? await tx.contact.findFirst({
                where: {
                  accountId: inbox.accountId,
                  phoneNumber: { in: phoneLookupVariants(phone) },
                },
                orderBy: { createdAt: 'asc' },
              })
            : null
          if (known?.blockedAt) throw new ForbiddenException('Contact is blocked')
          const contact =
            known ??
            (await tx.contact.create({
              data: {
                accountId: inbox.accountId,
                name: name ?? null,
                email: email ?? null,
                ...(phone && { phoneNumber: phone }),
                identifier: visitorId,
                ...(hasExtra && {
                  customAttributes: extraAttrs as Prisma.InputJsonValue,
                }),
              },
            }))
          cid = contact.id
          // A known contact may already have a row for this widget (another
          // browser); one per contact and inbox, so reuse it.
          contactInbox =
            (known &&
              (await tx.contactInbox.findUnique({
                where: { contactId_inboxId: { contactId: cid, inboxId: inbox.id } },
              }))) ||
            (await tx.contactInbox.create({
              data: {
                contactId: cid,
                inboxId: inbox.id,
                sourceId: visitorId,
              },
            }))
        }

        // Reuse the latest OPEN conversation if any, otherwise create one.
        const openConv = await tx.conversation.findFirst({
          where: {
            contactId: cid,
            inboxId: inbox.id,
            status: { in: ['OPEN', 'PENDING'] },
          },
          orderBy: { createdAt: 'desc' },
        })
        let convId: string
        if (openConv) {
          convId = openConv.id
        } else {
          const conv = await tx.conversation.create({
            data: {
              accountId: inbox.accountId,
              inboxId: inbox.id,
              contactId: cid,
              contactInboxId: contactInbox.id,
              status: 'OPEN',
              controlMode: initialControlMode(inbox),
              // A visitor started this: billable from the first word.
              origin: 'INBOUND',
              billableAt: new Date(),
            },
          })
          convId = conv.id
        }

        return { contactId: cid, conversationId: convId }
      },
    )

    const ttl = 24 * 60 * 60
    const token = signVisitorJwt(
      { conversationId, contactId, inboxId: inbox.id },
      this.jwtSecret(),
      ttl,
    )
    return {
      visitorToken: token,
      conversationId,
      contactId,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    }
  }

  /** Validate a visitor token + match it to the hash's inbox. */
  decodeToken(hash: string, token: string): VisitorJwtPayload {
    const payload = verifyVisitorJwt(token, this.jwtSecret())
    if (!payload) throw new BadRequestException('Invalid visitor token')
    return payload
  }

  async postMessage(input: {
    hash: string
    token: string
    content: string
    interactiveReplyId?: string | null
    origin?: string
  }): Promise<{ id: string; createdAt: string }> {
    const inbox = await this.resolveInbox(input.hash)
    this.assertOriginAllowed(inbox, input.origin)
    const payload = this.decodeToken(input.hash, input.token)
    if (payload.inboxId !== inbox.id) {
      throw new BadRequestException('Token does not match this widget')
    }
    const trimmed = input.content?.trim() ?? ''
    if (!trimmed) throw new BadRequestException('Empty message')
    if (trimmed.length > 4000) {
      throw new BadRequestException('Message too long')
    }
    const message = await this.prisma.message.create({
      data: {
        conversationId: payload.conversationId,
        inboxId: inbox.id,
        accountId: inbox.accountId,
        senderType: 'CONTACT',
        senderContactId: payload.contactId,
        content: trimmed,
        contentType: 'TEXT',
        status: 'DELIVERED',
        ...(input.interactiveReplyId && {
          contentAttributes: { interactiveReplyId: input.interactiveReplyId },
        }),
      },
    })
    await this.prisma.conversation.update({
      where: { id: payload.conversationId },
      data: { contactLastSeenAt: new Date() },
    })
    await this.prisma.contact.update({
      where: { id: payload.contactId },
      data: { lastActivityAt: new Date() },
    })
    await this.realtime.publish({
      type: 'MessageCreated',
      accountId: inbox.accountId,
      conversationId: payload.conversationId,
      inboxId: inbox.id,
      messageId: message.id,
      senderType: message.senderType,
      content: message.content,
      isPrivate: message.isPrivate,
      createdAt: message.createdAt.toISOString(),
    })
    // Arbiter: a deterministic flow gets first refusal; the AI agent only runs
    // if no flow handled the turn. Guarded so a misconfig doesn't break
    // ingestion. The visitor polls (or gets a realtime push) for any reply.
    const flowHandled = await this.flowRunner
      .handleInbound({
        accountId: inbox.accountId,
        conversationId: payload.conversationId,
        content: trimmed,
        interactiveReplyId: input.interactiveReplyId ?? null,
      })
      .catch(() => false)
    if (!flowHandled) {
      void this.orchestrator
        .handleInbound({
          accountId: inbox.accountId,
          conversationId: payload.conversationId,
          inboundMessageContent: trimmed,
        })
        .catch(() => undefined)
    }
    // The visitor's first message is when the conversation becomes real work:
    // distribute it to an available agent. Skipped while the bot drives it.
    const contactMessages = await this.prisma.message.count({
      where: { conversationId: payload.conversationId, senderType: 'CONTACT' },
    })
    if (contactMessages === 1) {
      await this.assignment.route(payload.conversationId, 'conversation_created')
    }
    return {
      id: message.id,
      createdAt: message.createdAt.toISOString(),
    }
  }

  async listMessages(input: {
    hash: string
    token: string
    origin?: string
  }): Promise<WidgetMessage[]> {
    const inbox = await this.resolveInbox(input.hash)
    this.assertOriginAllowed(inbox, input.origin)
    const payload = this.decodeToken(input.hash, input.token)
    if (payload.inboxId !== inbox.id) {
      throw new BadRequestException('Token does not match this widget')
    }
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: payload.conversationId,
        isPrivate: false,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    return messages.map(toWidgetMessage)
  }

  embedScript(hash: string, apiBase: string): string {
    return buildEmbedScript(hash, apiBase)
  }

  private assertOriginAllowed(inbox: Inbox, origin?: string): void {
    const config = (inbox.channelConfig ?? {}) as Record<string, unknown> &
      Prisma.JsonObject
    const websiteUrl = typeof config.websiteUrl === 'string' ? config.websiteUrl : null
    if (!websiteUrl || !origin) return
    let allowed: string
    try {
      allowed = new URL(websiteUrl).origin
    } catch {
      // Mis-formatted websiteUrl: fail closed. Inbox-edit validation rejects
      // malformed URLs at save-time, so this branch usually means the column
      // was tampered with. Log + refuse.
      this.logger.warn(
        `widget inbox ${inbox.id} has malformed websiteUrl=${websiteUrl} — refusing session`,
      )
      throw new BadRequestException('Widget misconfigured; contact your administrator')
    }
    if (allowed !== origin) {
      throw new BadRequestException('Origin not allowed for this widget')
    }
  }
}
