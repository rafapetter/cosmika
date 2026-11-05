import { createHmac, randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptSecretsIn } from '../../common/secret-crypto'

import {
  defaultFileName,
  externalCreatedAt,
  providerTimestamp,
  WhatsappService,
  isWaBsuid,
  waMediaKind,
} from './whatsapp.service'

// ---------- helpers ----------

function makePrisma() {
  const prisma = {
    inbox: { findUnique: vi.fn() },
    contact: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    contactInbox: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    message: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    contactNote: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  }
  // Interactive-transaction mock: run the callback against the same mocks.
  prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  )
  return prisma
}

type Prisma = ReturnType<typeof makePrisma>

function makeConversations() {
  return {
    ingestExternalInbound: vi.fn().mockResolvedValue({}),
  }
}

type Conversations = ReturnType<typeof makeConversations>

function makeRealtime() {
  return { publish: vi.fn(async () => undefined) }
}

function makeAttachments() {
  return { ingestFromChannel: vi.fn().mockResolvedValue({ id: 'att1' }) }
}

function makeService(
  prisma: Prisma,
  conversations: Conversations,
  realtime: ReturnType<typeof makeRealtime> = makeRealtime(),
  attachments: ReturnType<typeof makeAttachments> = makeAttachments(),
): WhatsappService {
  return new WhatsappService(
    prisma as never,
    conversations as never,
    realtime as never,
    attachments as never,
  )
}

/**
 * Meta serves inbound media in two hops: a lookup that returns a short-lived
 * URL, then the file itself. Every test that sends media must stub both, or
 * the suite ends up calling graph.facebook.com for real.
 */
function stubMetaMedia(opts: { mime?: string; size?: number } = {}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        url: 'https://lookaside.example/file',
        mime_type: opts.mime ?? 'image/jpeg',
        file_size: opts.size ?? 3,
      }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as Response)
}

const WA_INBOX = {
  id: 'inb1',
  accountId: 'acc1',
  channelType: 'WHATSAPP',
  channelConfig: {
    phoneNumberId: '1234567890',
    businessAccountId: '9876543210',
    appSecret: 'app-secret-from-meta-developer-console',
    accessToken: 'EAAxxxxAccessTokenxxxxxxx',
    webhookVerifyToken: 'verify-string-shared-with-meta',
  },
}

function signedPayload(body: unknown, secret: string): { raw: Buffer; sig: string } {
  const raw = Buffer.from(JSON.stringify(body))
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
  return { raw, sig }
}

// ---------- verifyChallenge ----------

describe('WhatsappService.verifyChallenge', () => {
  let prisma: Prisma
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  it('403s when mode is not "subscribe"', async () => {
    await expect(
      svc.verifyChallenge('inb1', 'unsubscribe', 'tok', 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when mode is missing', async () => {
    await expect(
      svc.verifyChallenge('inb1', undefined, 'tok', 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when token is missing', async () => {
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', undefined, 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when challenge is missing', async () => {
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'tok', undefined),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404s for unknown inbox', async () => {
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'tok', 'chal'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when inbox is not WhatsApp type', async () => {
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'WEB_WIDGET' })
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'tok', 'chal'),
    ).rejects.toThrow(NotFoundException)
  })

  it('403s when channelConfig has no webhookVerifyToken', async () => {
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, webhookVerifyToken: undefined },
    })
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'tok', 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when the supplied token does not match', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'WRONG-TOKEN', 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('returns the challenge string when everything matches', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const out = await svc.verifyChallenge(
      'inb1',
      'subscribe',
      WA_INBOX.channelConfig.webhookVerifyToken,
      'echo-me-back-please',
    )
    expect(out).toBe('echo-me-back-please')
  })

  it('403s when channelConfig is null (totally absent)', async () => {
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelConfig: null })
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'tok', 'chal'),
    ).rejects.toThrow(ForbiddenException)
  })
})

// ---------- ingestWebhook (signature verification) ----------

describe('WhatsappService.ingestWebhook — signature verification', () => {
  let prisma: Prisma
  let convs: Conversations
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    svc = makeService(prisma, convs)
  })

  it('404s for unknown inbox', async () => {
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      svc.ingestWebhook('inb1', Buffer.from('{}'), 'sha256=x', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when inbox is not WHATSAPP', async () => {
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'WEB_WIDGET' })
    await expect(
      svc.ingestWebhook('inb1', Buffer.from('{}'), 'sha256=x', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('403s (generic "Forbidden") when appSecret is missing — does NOT leak misconfig', async () => {
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, appSecret: undefined },
    })
    await expect(
      svc.ingestWebhook('inb1', Buffer.from('{}'), 'sha256=x', {} as never),
    ).rejects.toThrow(/^Forbidden$/)
  })

  it('403s when signature header is missing', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    await expect(
      svc.ingestWebhook('inb1', Buffer.from('{}'), undefined, {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when signature length differs (guards before timingSafeEqual)', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    await expect(
      svc.ingestWebhook('inb1', Buffer.from('{}'), 'sha256=short', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when signature does not match the body', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const { raw } = signedPayload({ object: 'whatsapp_business_account' }, 'WRONG_SECRET')
    // Produce a sig with the right LENGTH but wrong content
    const fakeSig =
      'sha256=' +
      'a'.repeat(64) // same length, wrong bytes
    await expect(
      svc.ingestWebhook('inb1', raw, fakeSig, {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('400s on unexpected webhook object even after sig verification', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const body = { object: 'instagram_business_account' }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    await expect(
      svc.ingestWebhook('inb1', raw, sig, body as never),
    ).rejects.toThrow(BadRequestException)
  })

  it('returns processed:0 when signature is valid but payload has no entries', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const body = { object: 'whatsapp_business_account', entry: [] }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, body as never)
    expect(out).toEqual({ processed: 0 })
  })

  it('returns processed:0 when entry has no changes', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'biz1' }],
    }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, body as never)
    expect(out).toEqual({ processed: 0 })
  })

  it('returns processed:0 when entry array is missing entirely (?? [] guard)', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const body = { object: 'whatsapp_business_account' } // no `entry` field at all
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, body as never)
    expect(out).toEqual({ processed: 0 })
  })

  it('returns processed:0 when value.messages is missing (?? [] guard)', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {},
                // messages omitted on purpose — status-only webhook
                statuses: [{ id: 'wamid.x', recipient_id: '5511', status: 'delivered', timestamp: '0' }],
              },
            },
          ],
        },
      ],
    }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, body as never)
    expect(out).toEqual({ processed: 0 })
  })
})

// ---------- ingestWebhook (message processing) ----------

describe('WhatsappService.ingestWebhook — inbound message processing', () => {
  let prisma: Prisma
  let convs: Conversations
  let realtime: ReturnType<typeof makeRealtime>
  let svc: WhatsappService

  function makePayload(messages: Array<Record<string, unknown>>, contacts: Array<Record<string, unknown>> = []) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
                contacts,
                messages,
              },
            },
          ],
        },
      ],
    }
  }

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    realtime = makeRealtime()
    svc = makeService(prisma, convs, realtime)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
  })

  it('drops payloads for a number this inbox does not own (cross-delivery guard)', async () => {
    // An app-level callback can carry payloads for another number during
    // multi-number subscriptions; they must not pollute this inbox.
    const payload = makePayload(
      [
        {
          id: 'wamid.other-number',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'oi' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Maria' } }],
    )
    payload.entry[0].changes[0].value.metadata.phone_number_id = '999999999'
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, payload as never)
    expect(out.processed).toBe(0)
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('drops the inbound message when the contact is blocked', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 'ct-blocked',
      accountId: 'acc1',
      phoneNumber: '5511999999999',
      name: 'Spammer',
      blockedAt: new Date(),
    })
    const payload = makePayload(
      [
        {
          id: 'wamid.blocked',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'spam' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Spammer' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, payload as never)
    // The webhook is acknowledged (processed counts the message) but nothing
    // is persisted: no conversation, no inbound delivery.
    expect(out.processed).toBe(1)
    expect(prisma.conversation.create).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('creates a new Contact when this wa_id is unseen', async () => {
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue({
      id: 'ct1',
      accountId: 'acc1',
      phoneNumber: '5511999999999',
      name: 'Maria',
    })
    prisma.contactInbox.findUnique.mockResolvedValue(null)
    prisma.contactInbox.create.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
      inboxId: 'inb1',
      sourceId: '5511999999999',
    })
    prisma.conversation.findFirst.mockResolvedValue(null)
    prisma.conversation.create.mockResolvedValue({
      id: 'cv1',
      createdAt: new Date('2026-08-21T12:00:00Z'),
    })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.aaa',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hello' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Maria' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(out.processed).toBe(1)
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phoneNumber: '5511999999999',
        name: 'Maria',
        identifier: 'whatsapp:5511999999999',
      }),
    })
    // A brand-new conversation must announce itself, or the console list
    // only learns about it on a manual refresh.
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ConversationCreated',
        conversationId: 'cv1',
        inboxId: 'inb1',
      }),
    )
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        conversationId: 'cv1',
        content: 'hello',
        contentType: 'TEXT',
        externalSourceId: 'wamid.aaa',
      }),
    )
  })

  it('creates a Contact with name=null when no contacts entry / profile.name', async () => {
    prisma.contact.findFirst.mockResolvedValue(null)
    let capturedData: { name: string | null } | null = null
    prisma.contact.create.mockImplementation(async ({ data }) => {
      capturedData = data
      return { id: 'ct1', accountId: 'acc1', phoneNumber: data.phoneNumber, name: data.name }
    })
    prisma.contactInbox.findUnique.mockResolvedValue(null)
    prisma.contactInbox.create.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue(null)
    prisma.conversation.create.mockResolvedValue({
      id: 'cv1',
      createdAt: new Date('2026-08-21T12:00:00Z'),
    })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.zzz',
          from: '5511777777777',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'no-profile' },
        },
      ],
      [], // empty contacts → profile name is undefined → `?? null` fires
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(capturedData!.name).toBeNull()
  })

  it('reuses an existing Contact and adopts the profile name when contact has none', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 'ct1',
      accountId: 'acc1',
      phoneNumber: '5511999999999',
      name: null,
    })
    prisma.contact.update.mockResolvedValue({
      id: 'ct1',
      name: 'Maria',
    })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.bbb',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hi' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Maria' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct1' },
      data: { name: 'Maria' },
    })
    expect(prisma.contact.create).not.toHaveBeenCalled()
  })

  it('matches migrated contacts whose phoneNumber has a leading + (wa_id is bare digits)', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 'ct-plus',
      accountId: 'acc1',
      phoneNumber: '+5511999999999',
      name: 'Migrada',
    })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.plus',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'oi' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Migrada' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    // The lookup must cover both bare-digit and +E.164 storage formats.
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: 'acc1',
        phoneNumber: { in: ['5511999999999', '+5511999999999', '551199999999', '+551199999999'] },
      },
    })
    expect(prisma.contact.create).not.toHaveBeenCalled()
  })

  it('resolves via existing (inboxId, sourceId) row instead of creating a duplicate', async () => {
    // Contact not findable by phone (e.g. number stored in a third format),
    // but the inbox already has a ContactInbox carrying this wa_id.
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contactInbox.findUnique.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (where.inboxId_sourceId) {
        return Promise.resolve({
          id: 'ci-src',
          contactId: 'ct-src',
          inboxId: 'inb1',
          sourceId: '5511999999999',
          bsuid: null,
          contact: { id: 'ct-src', accountId: 'acc1', name: 'Fonte', blockedAt: null },
        })
      }
      return Promise.resolve(null)
    })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.src',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'oi' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'Fonte' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(prisma.contactInbox.create).not.toHaveBeenCalled()
  })

  it('does NOT overwrite an existing contact name even if profile changes', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 'ct1',
      accountId: 'acc1',
      phoneNumber: '5511999999999',
      name: 'Original Name',
    })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload(
      [
        {
          id: 'wamid.ccc',
          from: '5511999999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hi' },
        },
      ],
      [{ wa_id: '5511999999999', profile: { name: 'NEW NAME FROM WA' } }],
    )
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(prisma.contact.update).not.toHaveBeenCalled()
  })

  it('skips message with no `from` (defensive)', async () => {
    prisma.contact.findFirst.mockResolvedValue(null)
    const payload = makePayload([
      {
        id: 'wamid.ddd',
        from: '', // empty falsy
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'orphan' },
      },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    const out = await svc.ingestWebhook('inb1', raw, sig, payload as never)
    expect(out.processed).toBe(1) // counted as processed, but no DB writes
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('dedupes messages by externalSourceId (wamid) — Cloud API retry safe', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue({ id: 'msg-existing' })

    const payload = makePayload([
      {
        id: 'wamid.eee',
        from: '5511',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'retry' },
      },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('opens a NEW conversation when the previous one is closed, never reopening it', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    // Nothing in progress: the only conversation this contact has is closed,
    // and the lookup filters closed ones out.
    prisma.conversation.findFirst.mockResolvedValue(null)
    prisma.conversation.create.mockResolvedValue({
      id: 'cv-new',
      createdAt: new Date('2026-10-06T12:00:00Z'),
    })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload([
      {
        id: 'wamid.fff',
        from: '5511',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi again' },
      },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    // One lookup only, restricted to conversations still in progress: there
    // is no second, status-blind lookup that could hand back the closed one.
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'RESOLVED' } }),
      }),
    )
    // The new conversation is billable from this message.
    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contactId: 'ct1',
        contactInboxId: 'ci1',
        status: 'OPEN',
        origin: 'INBOUND',
        billableAt: expect.any(Date),
      }),
    })
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ConversationCreated', conversationId: 'cv-new' }),
    )
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv-new' }),
    )
  })

  it('takes a per-contact lock so two quick messages cannot open two conversations', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.message.findFirst.mockResolvedValue(null)
    const order: string[] = []
    prisma.$executeRaw.mockImplementation(async () => {
      order.push('lock')
      return 1
    })
    prisma.conversation.findFirst.mockImplementation(async () => {
      order.push('find')
      return { id: 'cv1', status: 'OPEN' }
    })

    const payload = makePayload([
      { id: 'wamid.lock', from: '5511', timestamp: '1700000000', type: 'text', text: { body: 'oi' } },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    // The lock is taken inside the transaction, before the lookup.
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(order).toEqual(['lock', 'find'])
    // Something in progress is reused: no new conversation, no announcement.
    expect(prisma.conversation.create).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ConversationCreated' }),
    )
  })

  it('drops a redelivered message even when its conversation was closed meanwhile', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    // Already stored in this inbox, in a conversation that is closed by now.
    prisma.message.findFirst.mockResolvedValue({ id: 'msg-existing' })

    const payload = makePayload([
      { id: 'wamid.retry', from: '5511', timestamp: '1700000000', type: 'text', text: { body: 'retry' } },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    // The duplicate is recognised across the inbox, before any conversation
    // is looked up or created.
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inboxId: 'inb1', externalSourceId: 'wamid.retry' },
      }),
    )
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled()
    expect(prisma.conversation.create).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('creates a new ContactInbox row when this contact has not used this inbox before', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue(null)
    prisma.contactInbox.create.mockResolvedValue({ id: 'ci-new' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    const payload = makePayload([
      {
        id: 'wamid.ggg',
        from: '5511',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
    ])
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)

    expect(prisma.contactInbox.create).toHaveBeenCalledWith({
      data: { contactId: 'ct1', inboxId: 'inb1', sourceId: '5511' },
    })
  })
})

// ---------- normalizeContent (via ingestWebhook) ----------

describe('WhatsappService.normalizeContent (exercised through ingestWebhook)', () => {
  let prisma: Prisma
  let convs: Conversations
  let svc: WhatsappService

  function send(msg: Record<string, unknown>) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {},
                messages: [msg],
              },
            },
          ],
        },
      ],
    }
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    svc = makeService(prisma, convs)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)
    // Every media case downloads; serve both Meta hops so nothing leaves
    // the process.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('lookaside')
        ? ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) } as Response)
        : ({
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://lookaside.example/f', file_size: 3 }),
          } as Response),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('text', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'text', text: { body: 'hello' } })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hello', contentType: 'TEXT' }),
    )
  })

  it('text with no body falls back to empty string', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'text' })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '', contentType: 'TEXT' }),
    )
  })

  it('image with caption', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'image',
      image: { caption: 'lookit', mime_type: 'image/jpeg', id: 'media-1' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'lookit',
        contentType: 'IMAGE',
        contentAttributes: { mediaId: 'media-1', mimeType: 'image/jpeg' },
      }),
    )
  })

  it('image without caption falls back to "[image]"', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'image', image: {} })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[image]', contentType: 'IMAGE' }),
    )
  })

  it('audio always renders "[audio]"', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'audio', audio: { id: 'm', mime_type: 'audio/ogg' } })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[audio]', contentType: 'AUDIO' }),
    )
  })

  it('video with caption uses caption, content type VIDEO', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'video', video: { caption: 'epic', id: 'm' } })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'epic', contentType: 'VIDEO' }),
    )
  })

  it('video without caption → "[video]"', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'video', video: {} })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[video]', contentType: 'VIDEO' }),
    )
  })

  it('document with caption uses caption', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'document',
      document: { caption: 'the contract', filename: 'contract.pdf', id: 'm', mime_type: 'application/pdf' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'the contract', contentType: 'FILE' }),
    )
  })

  it('document with only filename falls back to filename', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'document',
      document: { filename: 'invoice.pdf' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'invoice.pdf', contentType: 'FILE' }),
    )
  })

  it('document with neither caption nor filename → "[document]"', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'document', document: {} })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[document]', contentType: 'FILE' }),
    )
  })

  it('location with name uses the name', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'location',
      location: { latitude: -23.55, longitude: -46.63, name: 'Av Paulista', address: 'Sao Paulo' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Av Paulista', contentType: 'LOCATION' }),
    )
  })

  it('location without name falls back to "📍 lat,lng"', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'location',
      location: { latitude: -23.55, longitude: -46.63 },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '📍 -23.55,-46.63', contentType: 'LOCATION' }),
    )
  })

  it('sticker renders "[sticker]" as FILE with sticker flag', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'sticker' })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '[sticker]',
        contentType: 'FILE',
        contentAttributes: { sticker: true },
      }),
    )
  })

  it('contacts renders "[contact card]"', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'contacts' })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ content: '[contact card]', contentType: 'CONTACT_CARD' }),
    )
  })

  it('unknown type passes through as "[<type>]" with rawType attribute', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'unsupported' })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '[unsupported]',
        contentType: 'TEXT',
        contentAttributes: { rawType: 'unsupported' },
      }),
    )
  })

  it('button (template quick-reply) carries the payload as interactiveReplyId', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'button',
      button: { text: 'Yes', payload: 'opt_yes' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Yes',
        contentType: 'TEXT',
        contentAttributes: { interactiveReplyId: 'opt_yes' },
      }),
    )
  })

  it('button with no fields falls back to empty content + null id', async () => {
    await send({ id: 'a', from: '5511', timestamp: '0', type: 'button' })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
        contentAttributes: { interactiveReplyId: null },
      }),
    )
  })

  it('interactive button_reply carries the selected id', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'edge_42', title: 'Support' },
      },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Support',
        contentType: 'TEXT',
        contentAttributes: { interactiveReplyId: 'edge_42' },
      }),
    )
  })

  it('interactive list_reply carries the selected id', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'row_7', title: 'Billing', description: 'pay' },
      },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Billing',
        contentAttributes: { interactiveReplyId: 'row_7' },
      }),
    )
  })

  it('interactive with no reply object falls back to empty + null id', async () => {
    await send({
      id: 'a',
      from: '5511',
      timestamp: '0',
      type: 'interactive',
      interactive: { type: 'button_reply' },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
        contentAttributes: { interactiveReplyId: null },
      }),
    )
  })
})

// ---------- sendOutbound ----------

describe('WhatsappService.sendOutbound', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('returns a stub wamid when COSMIKA_WHATSAPP_STUB=1', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const out = await svc.sendOutbound('inb1', '+5511', 'hello')
    expect(out.wamid).toMatch(/^stub-\d+$/)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('404s for unknown inbox', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(NotFoundException)
  })

  it('404s when inbox is not WHATSAPP', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'WEB_WIDGET' })
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(NotFoundException)
  })

  it('400s when accessToken is missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, accessToken: undefined },
    })
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(
      'missing credentials',
    )
  })

  it('400s when phoneNumberId is missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, phoneNumberId: undefined },
    })
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(
      'missing credentials',
    )
  })

  it('posts to graph.facebook.com and returns the wamid', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.outbound.1' }] }),
    } as Response)

    const out = await svc.sendOutbound('inb1', '+5511', 'hi from cosmika')
    expect(out.wamid).toBe('wamid.outbound.1')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/${WA_INBOX.channelConfig.phoneNumberId}/messages`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: `Bearer ${WA_INBOX.channelConfig.accessToken}`,
        }),
      }),
    )
    const init = fetchSpy.mock.calls[0]![1]!
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+5511',
      type: 'text',
      text: { body: 'hi from cosmika' },
    })
  })

  it('returns wamid=null when Cloud API response has no messages array', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}), // no messages key
    } as Response)
    const out = await svc.sendOutbound('inb1', '+5511', 'hi')
    expect(out.wamid).toBeNull()
  })

  it('throws when Cloud API responds with non-2xx', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid recipient"}',
    } as Response)
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(
      /WhatsApp send failed \(400\): \{"error":"invalid recipient"\}/,
    )
  })
})

describe('WhatsappService.sendTemplate', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })
  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('returns a stub wamid when stubbed', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const out = await svc.sendTemplate('inb1', '+5511', 'hello_world', 'en_US', [])
    expect(out.wamid).toMatch(/^stub-tmpl-\d+$/)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('404s for unknown / non-whatsapp inbox', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      svc.sendTemplate('inb1', '+5511', 'n', 'pt_BR', []),
    ).rejects.toThrow(NotFoundException)
  })

  it('400s when credentials are missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, accessToken: undefined },
    })
    await expect(
      svc.sendTemplate('inb1', '+5511', 'n', 'pt_BR', []),
    ).rejects.toThrow('missing credentials')
  })

  it('posts a template payload with body parameters and returns the wamid', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.tmpl.1' }] }),
    } as Response)
    const out = await svc.sendTemplate('inb1', '+5511', 'appt', 'pt_BR', ['Ana', '10h'])
    expect(out.wamid).toBe('wamid.tmpl.1')
    const init = fetchSpy.mock.calls[0]![1]!
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+5511',
      type: 'template',
      template: {
        name: 'appt',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: '10h' },
            ],
          },
        ],
      },
    })
  })

  it('omits components when there are no body parameters; null wamid on empty response', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response)
    const out = await svc.sendTemplate('inb1', '+5511', 'hello_world', 'en_US', [])
    expect(out.wamid).toBeNull()
    const init = fetchSpy.mock.calls[0]![1]!
    expect(JSON.parse(init.body as string).template.components).toEqual([])
  })

  it('throws on non-2xx', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad template',
    } as Response)
    await expect(
      svc.sendTemplate('inb1', '+5511', 'n', 'pt_BR', []),
    ).rejects.toThrow(/WhatsApp template send failed \(400\): bad template/)
  })
})

// ---------- outbound media ----------

describe('waMediaKind', () => {
  it.each([
    ['IMAGE', 'image/jpeg', 'image'],
    ['IMAGE', 'image/png', 'image'],
    ['VIDEO', 'video/mp4', 'video'],
    ['VIDEO', 'video/3gpp', 'video'],
    ['AUDIO', 'audio/ogg', 'audio'],
    ['AUDIO', 'audio/mpeg', 'audio'],
    ['FILE', 'application/pdf', 'document'],
    ['FALLBACK', 'application/zip', 'document'],
    ['LOCATION', null, 'document'],
  ])('%s + %s → %s', (fileType, mime, expected) => {
    expect(waMediaKind(fileType as never, mime)).toBe(expected)
  })

  it.each([
    ['IMAGE', 'image/svg+xml'], // Meta rejects svg as an image
    ['IMAGE', 'image/webp'], // webp is sticker-only
    ['VIDEO', 'video/quicktime'],
    ['AUDIO', 'audio/wav'],
  ])('downgrades unsupported %s mime %s to document', (fileType, mime) => {
    expect(waMediaKind(fileType as never, mime)).toBe('document')
  })

  it('ignores mime parameters and casing', () => {
    expect(waMediaKind('IMAGE' as never, 'IMAGE/PNG; charset=binary')).toBe('image')
  })

  it('treats a missing mime as a document', () => {
    expect(waMediaKind('IMAGE' as never, null)).toBe('document')
  })

  it.each([
    ['IMAGE', 'image/png', 5 * 1024 * 1024, 'image'],
    ['IMAGE', 'image/png', 5 * 1024 * 1024 + 1, 'document'],
    ['VIDEO', 'video/mp4', 16 * 1024 * 1024, 'video'],
    ['VIDEO', 'video/mp4', 16 * 1024 * 1024 + 1, 'document'],
    ['AUDIO', 'audio/ogg', 16 * 1024 * 1024 + 1, 'document'],
  ])('%s %s at %d bytes → %s', (fileType, mime, size, expected) => {
    expect(waMediaKind(fileType as never, mime, size)).toBe(expected)
  })

  it('keeps the rich type when the size is unknown', () => {
    expect(waMediaKind('IMAGE' as never, 'image/png', null)).toBe('image')
    expect(waMediaKind('IMAGE' as never, 'image/png')).toBe('image')
  })
})

describe('WhatsappService.uploadMedia', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB
  const FILE = {
    buffer: Buffer.from('png-bytes'),
    mimeType: 'image/png',
    fileName: 'photo.png',
  }

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
    process.env.COSMIKA_WHATSAPP_STUB = '0'
  })
  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('returns a stub media id when COSMIKA_WHATSAPP_STUB=1', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    expect(await svc.uploadMedia('inb1', FILE)).toMatch(/^stub-media-\d+$/)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('404s for a non-whatsapp inbox', async () => {
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'EMAIL' })
    await expect(svc.uploadMedia('inb1', FILE)).rejects.toThrow(NotFoundException)
  })

  it('400s when credentials are missing', async () => {
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, accessToken: undefined },
    })
    await expect(svc.uploadMedia('inb1', FILE)).rejects.toThrow('missing credentials')
  })

  it('posts multipart to the /media edge and returns the id', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'media-id-1' }),
    } as Response)

    expect(await svc.uploadMedia('inb1', FILE)).toBe('media-id-1')

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toContain(`/${WA_INBOX.channelConfig.phoneNumberId}/media`)
    expect(init!.method).toBe('POST')
    // No explicit content-type — fetch has to supply the multipart boundary.
    expect(init!.headers).toEqual({
      authorization: `Bearer ${WA_INBOX.channelConfig.accessToken}`,
    })
    const form = init!.body as FormData
    expect(form.get('messaging_product')).toBe('whatsapp')
    expect(form.get('type')).toBe('image/png')
    const file = form.get('file') as File
    expect(file.name).toBe('photo.png')
    expect(file.type).toBe('image/png')
    expect(await file.text()).toBe('png-bytes')
  })

  it('throws on non-2xx', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 413,
      text: async () => 'file too large',
    } as Response)
    await expect(svc.uploadMedia('inb1', FILE)).rejects.toThrow(
      /WhatsApp media upload failed \(413\): file too large/,
    )
  })

  it('throws when the upload response carries no id', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response)
    await expect(svc.uploadMedia('inb1', FILE)).rejects.toThrow(
      'WhatsApp media upload returned no media id',
    )
  })
})

describe('WhatsappService.sendMedia', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
  })
  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  function mockSendOk(id = 'wamid.media.1') {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id }] }),
    } as Response)
  }

  it('returns a stub wamid when COSMIKA_WHATSAPP_STUB=1', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const out = await svc.sendMedia('inb1', '+5511', {
      kind: 'image',
      source: { link: 'https://cdn.example.com/a.png' },
    })
    expect(out.wamid).toMatch(/^stub-media-msg-\d+$/)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('sends a link-sourced image with the caption', async () => {
    const fetchSpy = mockSendOk()
    const out = await svc.sendMedia('inb1', '+5511', {
      kind: 'image',
      source: { link: 'https://cdn.example.com/a.png' },
      caption: 'here you go',
    })
    expect(out.wamid).toBe('wamid.media.1')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toContain(`/${WA_INBOX.channelConfig.phoneNumberId}/messages`)
    expect(JSON.parse(init!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+5511',
      type: 'image',
      image: { link: 'https://cdn.example.com/a.png', caption: 'here you go' },
    })
  })

  it('uploads bytes first, then sends by media id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'media-id-9' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.media.2' }] }),
      } as Response)

    const out = await svc.sendMedia('inb1', '+5511', {
      kind: 'document',
      source: {
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
        fileName: 'invoice.pdf',
      },
      fileName: 'invoice.pdf',
    })

    expect(out.wamid).toBe('wamid.media.2')
    expect(fetchSpy.mock.calls[0]![0]).toContain('/media')
    expect(JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '+5511',
      type: 'document',
      document: { id: 'media-id-9', filename: 'invoice.pdf' },
    })
  })

  it('drops the caption on audio — the Cloud API has no field for it', async () => {
    const fetchSpy = mockSendOk()
    await svc.sendMedia('inb1', '+5511', {
      kind: 'audio',
      source: { link: 'https://cdn.example.com/a.ogg' },
      caption: 'listen',
      fileName: 'a.ogg',
    })
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).audio).toEqual({
      link: 'https://cdn.example.com/a.ogg',
    })
  })

  it('only puts filename on document sends', async () => {
    const fetchSpy = mockSendOk()
    await svc.sendMedia('inb1', '+5511', {
      kind: 'video',
      source: { link: 'https://cdn.example.com/a.mp4' },
      fileName: 'clip.mp4',
    })
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).video).toEqual({
      link: 'https://cdn.example.com/a.mp4',
    })
  })

  it('addresses a BSUID with `recipient` instead of `to`', async () => {
    const fetchSpy = mockSendOk()
    await svc.sendMedia('inb1', 'BR.13491208655302741918', {
      kind: 'image',
      source: { link: 'https://cdn.example.com/a.png' },
    })
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.recipient).toBe('BR.13491208655302741918')
    expect(body).not.toHaveProperty('to')
  })

  it('returns wamid=null when the response has no messages array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response)
    const out = await svc.sendMedia('inb1', '+5511', {
      kind: 'image',
      source: { link: 'https://cdn.example.com/a.png' },
    })
    expect(out.wamid).toBeNull()
  })

  it('throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"unsupported media"}',
    } as Response)
    await expect(
      svc.sendMedia('inb1', '+5511', {
        kind: 'image',
        source: { link: 'https://cdn.example.com/a.png' },
      }),
    ).rejects.toThrow(/WhatsApp media send failed \(400\)/)
  })

  it('404s for a non-whatsapp inbox', async () => {
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'API' })
    await expect(
      svc.sendMedia('inb1', '+5511', {
        kind: 'image',
        source: { link: 'https://cdn.example.com/a.png' },
      }),
    ).rejects.toThrow(NotFoundException)
  })
})

describe('WhatsappService.fetchTemplatesFromMeta', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })
  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('returns the stub fixture when stubbed', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const out = await svc.fetchTemplatesFromMeta('inb1')
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toHaveProperty('name')
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('404s for unknown / non-whatsapp inbox', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'API' })
    await expect(svc.fetchTemplatesFromMeta('inb1')).rejects.toThrow(NotFoundException)
  })

  it('400s when credentials are missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, businessAccountId: undefined },
    })
    await expect(svc.fetchTemplatesFromMeta('inb1')).rejects.toThrow('missing credentials')
  })

  it('fetches from the WABA edge and returns the data array', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ name: 't1', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED' }] }),
    } as Response)
    const out = await svc.fetchTemplatesFromMeta('inb1')
    expect(out).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/${WA_INBOX.channelConfig.businessAccountId}/message_templates`),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${WA_INBOX.channelConfig.accessToken}`,
        }),
      }),
    )
  })

  it('defaults to [] when the response has no data key', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) } as Response)
    expect(await svc.fetchTemplatesFromMeta('inb1')).toEqual([])
  })

  it('throws on non-2xx', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response)
    await expect(svc.fetchTemplatesFromMeta('inb1')).rejects.toThrow(
      /WhatsApp template sync failed \(401\): unauthorized/,
    )
  })
})

// ---------- sendInteractive ----------

describe('WhatsappService.sendInteractive', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })
  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  const BUTTONS = {
    kind: 'buttons' as const,
    body: 'Pick one',
    buttons: [
      { id: 'e1', label: 'Yes' },
      { id: 'e2', label: 'No' },
    ],
  }
  const LIST = {
    kind: 'list' as const,
    body: 'Choose a topic',
    buttonText: 'Open',
    sections: [
      {
        title: 'Help',
        rows: [
          { id: 'r1', title: 'Billing', description: 'pay stuff' },
          { id: 'r2', title: 'Support' },
        ],
      },
      { rows: [{ id: 'r3', title: 'Other' }] },
    ],
  }

  it('returns a stub wamid when stubbed', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const out = await svc.sendInteractive('inb1', '+5511', BUTTONS)
    expect(out.wamid).toMatch(/^stub-int-\d+$/)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })

  it('404s for unknown / non-WHATSAPP inbox', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(svc.sendInteractive('inb1', '+5511', BUTTONS)).rejects.toThrow(
      NotFoundException,
    )
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelType: 'WEB_WIDGET',
    })
    await expect(svc.sendInteractive('inb1', '+5511', BUTTONS)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('400s when accessToken is missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, accessToken: undefined },
    })
    await expect(svc.sendInteractive('inb1', '+5511', BUTTONS)).rejects.toThrow(
      'missing credentials',
    )
  })

  it('400s when phoneNumberId is missing', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue({
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, phoneNumberId: undefined },
    })
    await expect(svc.sendInteractive('inb1', '+5511', BUTTONS)).rejects.toThrow(
      'missing credentials',
    )
  })

  it('posts a reply-buttons interactive payload', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.int.1' }] }),
    } as Response)

    const out = await svc.sendInteractive('inb1', '+5511', BUTTONS)
    expect(out.wamid).toBe('wamid.int.1')
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '+5511',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Pick one' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'e1', title: 'Yes' } },
            { type: 'reply', reply: { id: 'e2', title: 'No' } },
          ],
        },
      },
    })
  })

  it('posts a list interactive payload (omits empty section title / row description)', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.int.2' }] }),
    } as Response)

    await svc.sendInteractive('inb1', '+5511', LIST)
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.interactive).toEqual({
      type: 'list',
      body: { text: 'Choose a topic' },
      action: {
        button: 'Open',
        sections: [
          {
            title: 'Help',
            rows: [
              { id: 'r1', title: 'Billing', description: 'pay stuff' },
              { id: 'r2', title: 'Support' },
            ],
          },
          { rows: [{ id: 'r3', title: 'Other' }] },
        ],
      },
    })
  })

  it('throws on a non-OK response', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad interactive',
    } as Response)
    await expect(svc.sendInteractive('inb1', '+5511', BUTTONS)).rejects.toThrow(
      /interactive send failed \(400\): bad interactive/,
    )
  })

  it('returns null wamid when the response has no messages', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response)
    const out = await svc.sendInteractive('inb1', '+5511', BUTTONS)
    expect(out.wamid).toBeNull()
  })
})

// ---------- BSUID (Meta 2026 usernames rollout) ----------

describe('isWaBsuid', () => {
  it('matches business-scoped user ids and rejects phones', () => {
    expect(isWaBsuid('BR.13491208655302741918')).toBe(true)
    expect(isWaBsuid('US.ENT.11815799212886844830')).toBe(true)
    expect(isWaBsuid('5511999999999')).toBe(false)
    expect(isWaBsuid('+5511999999999')).toBe(false)
    expect(isWaBsuid('br.lowercase')).toBe(false)
    expect(isWaBsuid(null)).toBe(false)
    expect(isWaBsuid(undefined)).toBe(false)
  })
})

describe('WhatsappService.ingestWebhook — BSUID contact resolution', () => {
  let prisma: Prisma
  let convs: Conversations
  let svc: WhatsappService
  const BSUID = 'BR.13491208655302741918'
  const PHONE = '5511999999999'

  function makePayload(
    messages: Array<Record<string, unknown>>,
    contacts: Array<Record<string, unknown>> = [],
  ) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
                contacts,
                messages,
              },
            },
          ],
        },
      ],
    }
  }

  async function ingest(payload: unknown) {
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    svc = makeService(prisma, convs)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
  })

  it('backfills the BSUID onto the existing phone-keyed ContactInbox', async () => {
    prisma.contactInbox.findFirst.mockResolvedValue(null) // no CI by bsuid yet
    prisma.contact.findFirst.mockResolvedValue({
      id: 'ct1',
      name: 'Maria',
      phoneNumber: PHONE,
    })
    prisma.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      sourceId: PHONE,
      bsuid: null,
    })
    prisma.contactInbox.update.mockResolvedValue({ id: 'ci1', sourceId: PHONE, bsuid: BSUID })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    await ingest(
      makePayload(
        [{ id: 'wamid.b1', from: PHONE, timestamp: '1', type: 'text', text: { body: 'oi' } }],
        [{ wa_id: PHONE, user_id: BSUID, profile: { name: 'Maria' } }],
      ),
    )

    expect(prisma.contactInbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inboxId: 'inb1', bsuid: BSUID } }),
    )
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ci1' },
      data: { bsuid: BSUID },
    })
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).toHaveBeenCalled()
  })

  it('creates a phone-less contact keyed by BSUID when wa_id/from are absent', async () => {
    prisma.contactInbox.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue({
      id: 'ct2',
      name: 'Sheena Nelson',
      phoneNumber: null,
      blockedAt: null,
    })
    prisma.contactInbox.findUnique.mockResolvedValue(null)
    prisma.contactInbox.create.mockResolvedValue({ id: 'ci2', sourceId: BSUID, bsuid: BSUID })
    prisma.conversation.findFirst.mockResolvedValue(null)
    prisma.conversation.create.mockResolvedValue({
      id: 'cv2',
      createdAt: new Date('2026-08-21T12:00:00Z'),
    })
    prisma.message.findFirst.mockResolvedValue(null)

    const out = await ingest(
      makePayload(
        [
          {
            id: 'wamid.b2',
            from_user_id: BSUID,
            timestamp: '1',
            type: 'text',
            text: { body: 'Does it come in another color?' },
          },
        ],
        [
          {
            user_id: BSUID,
            profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
          },
        ],
      ),
    )

    expect(out.processed).toBe(1)
    // No phone: the account-wide phone lookup must not run.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled()
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phoneNumber: null,
        name: 'Sheena Nelson',
        identifier: `whatsapp:${BSUID}`,
        additionalAttributes: { whatsappUsername: 'realsheenanelson' },
      }),
    })
    expect(prisma.contactInbox.create).toHaveBeenCalledWith({
      data: { contactId: 'ct2', inboxId: 'inb1', sourceId: BSUID, bsuid: BSUID },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv2' }),
    )
  })

  it('routes a BSUID-only webhook to the existing BSUID-keyed ContactInbox', async () => {
    prisma.contactInbox.findFirst.mockResolvedValue({
      id: 'ci1',
      sourceId: BSUID,
      bsuid: BSUID,
      contact: { id: 'ct1', name: 'Sheena', phoneNumber: null, blockedAt: null },
    })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    await ingest(
      makePayload(
        [
          {
            id: 'wamid.b3',
            from_user_id: BSUID,
            timestamp: '1',
            type: 'text',
            text: { body: 'again' },
          },
        ],
        [{ user_id: BSUID, profile: { name: 'Sheena' } }],
      ),
    )

    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(prisma.contact.findFirst).not.toHaveBeenCalled()
    expect(prisma.contactInbox.update).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv1' }),
    )
  })

  it('upgrades a BSUID-keyed ContactInbox to the phone when it reappears', async () => {
    prisma.contactInbox.findFirst.mockResolvedValue({
      id: 'ci1',
      sourceId: BSUID,
      bsuid: BSUID,
      contact: { id: 'ct1', name: 'Sheena', phoneNumber: null, blockedAt: null },
    })
    // No other contact owns this phone.
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.update.mockResolvedValue({
      id: 'ct1',
      name: 'Sheena',
      phoneNumber: PHONE,
      blockedAt: null,
    })
    prisma.contactInbox.update.mockResolvedValue({ id: 'ci1', sourceId: PHONE, bsuid: BSUID })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    await ingest(
      makePayload(
        [{ id: 'wamid.b4', from: PHONE, timestamp: '1', type: 'text', text: { body: 'back' } }],
        [{ wa_id: PHONE, user_id: BSUID, profile: { name: 'Sheena' } }],
      ),
    )

    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct1' },
      data: { phoneNumber: PHONE },
    })
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ci1' },
      data: { sourceId: PHONE },
    })
    expect(convs.ingestExternalInbound).toHaveBeenCalled()
  })

  it('merges the stray BSUID contact into the phone contact when both identifiers arrive', async () => {
    const strayContact = { id: 'ctB', name: 'Sheena', phoneNumber: null, blockedAt: null }
    const phoneContact = { id: 'ctA', name: 'Ana', phoneNumber: PHONE, blockedAt: null }
    prisma.contactInbox.findFirst.mockResolvedValue({
      id: 'ciB',
      sourceId: BSUID,
      bsuid: BSUID,
      contact: strayContact,
    })
    // The account-wide phone lookup (excluding the stray) finds the original.
    prisma.contact.findFirst.mockResolvedValue(phoneContact)
    // Inside the merge transaction: the phone contact has its own CI here.
    prisma.contactInbox.findUnique.mockResolvedValue({
      id: 'ciA',
      sourceId: PHONE,
      bsuid: null,
    })
    prisma.contactInbox.update.mockResolvedValue({ id: 'ciA', sourceId: PHONE, bsuid: BSUID })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    await ingest(
      makePayload(
        [{ id: 'wamid.b5', from: PHONE, timestamp: '1', type: 'text', text: { body: 'both' } }],
        [{ wa_id: PHONE, user_id: BSUID, profile: { name: 'Sheena' } }],
      ),
    )

    expect(prisma.$transaction).toHaveBeenCalled()
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { contactInboxId: 'ciB' },
      data: { contactInboxId: 'ciA' },
    })
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { contactId: 'ctB' },
      data: { contactId: 'ctA' },
    })
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { senderContactId: 'ctB' },
      data: { senderContactId: 'ctA' },
    })
    expect(prisma.contactInbox.delete).toHaveBeenCalledWith({ where: { id: 'ciB' } })
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ciA' },
      data: { bsuid: BSUID },
    })
    expect(prisma.contact.delete).toHaveBeenCalledWith({ where: { id: 'ctB' } })
    expect(convs.ingestExternalInbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'cv1' }),
    )
  })

  it('repoints the BSUID ContactInbox when the phone contact never used this inbox', async () => {
    const strayContact = { id: 'ctB', name: 'Sheena', phoneNumber: null, blockedAt: null }
    const phoneContact = { id: 'ctA', name: 'Ana', phoneNumber: PHONE, blockedAt: null }
    prisma.contactInbox.findFirst.mockResolvedValue({
      id: 'ciB',
      sourceId: BSUID,
      bsuid: BSUID,
      contact: strayContact,
    })
    prisma.contact.findFirst.mockResolvedValue(phoneContact)
    // Inside the merge transaction: the phone contact has NO CI in this inbox.
    prisma.contactInbox.findUnique.mockResolvedValue(null)
    prisma.contactInbox.update
      // merge: repoint ciB to the phone contact
      .mockResolvedValueOnce({ id: 'ciB', sourceId: BSUID, bsuid: BSUID, contactId: 'ctA' })
      // post-merge patch: upgrade sourceId to the phone
      .mockResolvedValueOnce({ id: 'ciB', sourceId: PHONE, bsuid: BSUID, contactId: 'ctA' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)

    await ingest(
      makePayload(
        [{ id: 'wamid.b6', from: PHONE, timestamp: '1', type: 'text', text: { body: 'hi' } }],
        [{ wa_id: PHONE, user_id: BSUID, profile: { name: 'Sheena' } }],
      ),
    )

    expect(prisma.contactInbox.delete).not.toHaveBeenCalled()
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ciB' },
      data: { contactId: 'ctA' },
    })
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ciB' },
      data: { sourceId: PHONE },
    })
    expect(prisma.contact.delete).toHaveBeenCalledWith({ where: { id: 'ctB' } })
    expect(convs.ingestExternalInbound).toHaveBeenCalled()
  })
})

describe('WhatsappService.resolveRecipient', () => {
  let prisma: Prisma
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  it('prefers the contact phone number', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      contact: { phoneNumber: '5511999999999' },
      contactInbox: { sourceId: 'BR.13491208655302741918' },
    })
    expect(await svc.resolveRecipient('cv1')).toBe('5511999999999')
  })

  it('falls back to a BSUID sourceId when the phone is unknown', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      contact: { phoneNumber: null },
      contactInbox: { sourceId: 'BR.13491208655302741918' },
    })
    expect(await svc.resolveRecipient('cv1')).toBe('BR.13491208655302741918')
  })

  it('returns null when there is no phone and sourceId is not a BSUID', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      contact: { phoneNumber: null },
      contactInbox: { sourceId: 'web-widget-token' },
    })
    expect(await svc.resolveRecipient('cv1')).toBeNull()
  })

  it('returns null for an unknown conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    expect(await svc.resolveRecipient('cv-missing')).toBeNull()
  })
})

describe('WhatsappService outbound — BSUID recipient addressing', () => {
  let prisma: Prisma
  let svc: WhatsappService
  const BSUID = 'BR.13491208655302741918'
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
  })

  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('sendOutbound uses `recipient` (not `to`) for a BSUID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.out.bsuid' }] }),
    } as Response)

    const out = await svc.sendOutbound('inb1', BSUID, 'hello')
    expect(out.wamid).toBe('wamid.out.bsuid')

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.recipient).toBe(BSUID)
    expect(body).not.toHaveProperty('to')
  })

  it('sendTemplate uses `recipient` (not `to`) for a BSUID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.tmpl.bsuid' }] }),
    } as Response)

    await svc.sendTemplate('inb1', BSUID, 'hello_world', 'en_US', [])

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.recipient).toBe(BSUID)
    expect(body).not.toHaveProperty('to')
  })

  it('sendInteractive uses `recipient` (not `to`) for a BSUID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.int.bsuid' }] }),
    } as Response)

    await svc.sendInteractive('inb1', BSUID, {
      kind: 'buttons',
      body: 'Pick one',
      buttons: [{ id: 'a', label: 'A' }],
    } as never)

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.recipient).toBe(BSUID)
    expect(body).not.toHaveProperty('to')
  })

  it('keeps `to` for plain phone numbers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.out.phone' }] }),
    } as Response)

    await svc.sendOutbound('inb1', '+5511999999999', 'hello')

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)
    expect(body.to).toBe('+5511999999999')
    expect(body).not.toHaveProperty('recipient')
  })
})

describe('WhatsappService.recipientForConversation', () => {
  let prisma: Prisma
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  const conv = (over: Record<string, unknown> = {}) => ({
    inbox: { channelType: 'WHATSAPP' },
    contact: { phoneNumber: '5511999999999' },
    contactInbox: { sourceId: 'BR.13491208655302741918' },
    ...over,
  })

  it('prefers the contact phone number', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    expect(await svc.recipientForConversation('cv1')).toBe('5511999999999')
  })

  it('falls back to a BSUID when the phone is unknown', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ contact: { phoneNumber: null } }),
    )
    expect(await svc.recipientForConversation('cv1')).toBe('BR.13491208655302741918')
  })

  it('returns null when the sourceId is not a BSUID', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ contact: { phoneNumber: null }, contactInbox: { sourceId: 'widget-token' } }),
    )
    expect(await svc.recipientForConversation('cv1')).toBeNull()
  })

  it('returns null for a non-WhatsApp inbox even when a phone is on file', async () => {
    // Widget/API inboxes are pull-based; a phone number there is not a
    // delivery address.
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ inbox: { channelType: 'WEB_WIDGET' } }),
    )
    expect(await svc.recipientForConversation('cv1')).toBeNull()
  })

  it('returns null for an unknown conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    expect(await svc.recipientForConversation('cv-missing')).toBeNull()
  })
})

describe('provider timestamp helpers', () => {
  it('converts Cloud API unix seconds to ISO', () => {
    // Cloud API sends seconds-as-string; JS Date wants milliseconds.
    expect(externalCreatedAt('1786000000')).toBe(new Date(1786000000000).toISOString())
    expect(externalCreatedAt(1786000000)).toBe(new Date(1786000000000).toISOString())
  })

  it('rejects anything unparseable rather than poisoning the record', () => {
    for (const bad of [undefined, null, '', 'abc', '0', '-5', NaN, {}]) {
      expect(externalCreatedAt(bad)).toBeNull()
    }
  })

  it('rejects a finite-but-absurd timestamp that overflows Date', () => {
    // Number.isFinite passes, but seconds * 1000 lands past Date's range.
    expect(externalCreatedAt('1e20')).toBeNull()
  })

  it('reads the stored timestamp back, and ignores junk', () => {
    const iso = '2026-08-06T12:00:00.000Z'
    expect(providerTimestamp({ external_created_at: iso })?.toISOString()).toBe(iso)
    for (const bad of [null, undefined, 'str', {}, { external_created_at: 42 },
                       { external_created_at: 'not-a-date' }]) {
      expect(providerTimestamp(bad)).toBeNull()
    }
  })
})

describe('WhatsappService.messagingWindowFor', () => {
  let prisma: Prisma
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  it('anchors on the provider timestamp, not on when the webhook arrived', () => {
    // A phone that was offline syncs late: arrival time would overestimate
    // how much window is left. This is the 131k-failure bug Nebula hit.
    const providerSent = new Date(Date.now() - 23 * 60 * 60 * 1000)
    const webhookArrived = new Date(Date.now() - 60 * 1000)
    prisma.message.findFirst.mockResolvedValue({
      createdAt: webhookArrived,
      contentAttributes: { external_created_at: providerSent.toISOString() },
    })
    return svc.messagingWindowFor('cv1').then((w) => {
      expect(w.open).toBe(true)
      expect(w.lastInboundAt).toBe(providerSent.toISOString())
      // ~1h left, not ~24h.
      const leftMs = new Date(w.expiresAt!).getTime() - Date.now()
      expect(leftMs).toBeLessThan(2 * 60 * 60 * 1000)
    })
  })

  it('reports a closed window past 24h', async () => {
    prisma.message.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      contentAttributes: {},
    })
    const w = await svc.messagingWindowFor('cv1')
    expect(w.open).toBe(false)
  })

  it('falls back to row creation time for messages ingested before we captured it', async () => {
    const created = new Date(Date.now() - 60 * 1000)
    prisma.message.findFirst.mockResolvedValue({ createdAt: created, contentAttributes: null })
    const w = await svc.messagingWindowFor('cv1')
    expect(w.open).toBe(true)
    expect(w.lastInboundAt).toBe(created.toISOString())
  })

  it('reports no window when the customer has never written', async () => {
    prisma.message.findFirst.mockResolvedValue(null)
    expect(await svc.messagingWindowFor('cv1')).toEqual({
      open: false, lastInboundAt: null, expiresAt: null,
    })
  })

  it('only looks at inbound messages', async () => {
    prisma.message.findFirst.mockResolvedValue(null)
    await svc.messagingWindowFor('cv1')
    expect(prisma.message.findFirst.mock.calls[0][0].where).toEqual({
      conversationId: 'cv1', senderType: 'CONTACT',
    })
  })
})

// ---------- delivery receipts (statuses[]) ----------
// Before 2026-08-15 these were discarded, which froze all 202k outbound
// messages at SENT and hid async failures (131047/131026) entirely.

describe('WhatsappService.ingestWebhook — delivery receipts', () => {
  let prisma: Prisma
  let realtime: ReturnType<typeof makeRealtime>
  let svc: WhatsappService

  function statusPayload(statuses: Array<Record<string, unknown>>) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
                statuses,
              },
            },
          ],
        },
      ],
    }
  }

  const OUT_MSG = {
    id: 'm1',
    accountId: 'acc1',
    conversationId: 'cv1',
    inboxId: 'inb1',
    status: 'SENT',
    contentAttributes: { wamids: ['wamid.out1'] },
  }

  async function ingest(statuses: Array<Record<string, unknown>>) {
    const payload = statusPayload(statuses)
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  beforeEach(() => {
    prisma = makePrisma()
    realtime = makeRealtime()
    svc = makeService(prisma, makeConversations(), realtime)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.message.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ ...OUT_MSG, ...args.data }),
    )
  })

  it('advances SENT→DELIVERED and publishes the change', async () => {
    prisma.message.findFirst.mockResolvedValueOnce(OUT_MSG)
    const out = await ingest([
      { id: 'wamid.out1', status: 'delivered', timestamp: '1700000100' },
    ])
    expect(out.processed).toBe(1)
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: expect.objectContaining({ status: 'DELIVERED' }),
      }),
    )
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MessageStatusChanged',
        messageId: 'm1',
        conversationId: 'cv1',
        status: 'DELIVERED',
      }),
    )
  })

  it('never downgrades READ on an out-of-order delivered receipt', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({ ...OUT_MSG, status: 'READ' })
    const out = await ingest([
      { id: 'wamid.out1', status: 'delivered', timestamp: '1700000100' },
    ])
    expect(out.processed).toBe(0)
    expect(prisma.message.update).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalled()
  })

  it('records FAILED with the provider error code', async () => {
    prisma.message.findFirst.mockResolvedValueOnce(OUT_MSG)
    await ingest([
      {
        id: 'wamid.out1',
        status: 'failed',
        timestamp: '1700000100',
        errors: [
          {
            code: 131047,
            title: 'Re-engagement message',
            message: 'More than 24 hours have passed',
          },
        ],
      },
    ])
    const data = prisma.message.update.mock.calls[0][0].data
    expect(data.status).toBe('FAILED')
    expect(data.contentAttributes.deliveryError).toEqual(
      expect.objectContaining({ code: 131047, title: 'Re-engagement message' }),
    )
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageStatusChanged', status: 'FAILED' }),
    )
  })

  it('a late sent receipt never clears a FAILED verdict', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({ ...OUT_MSG, status: 'FAILED' })
    const out = await ingest([
      { id: 'wamid.out1', status: 'sent', timestamp: '1700000100' },
    ])
    expect(out.processed).toBe(0)
    expect(prisma.message.update).not.toHaveBeenCalled()
  })

  it('DELIVERED after FAILED does advance (successful retry)', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({ ...OUT_MSG, status: 'FAILED' })
    await ingest([
      { id: 'wamid.out1', status: 'delivered', timestamp: '1700000100' },
    ])
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DELIVERED' }),
      }),
    )
  })

  it('ignores receipts that match no message (pre-stamp history)', async () => {
    prisma.message.findFirst.mockResolvedValue(null)
    const out = await ingest([
      { id: 'wamid.unknown', status: 'delivered', timestamp: '1700000100' },
    ])
    expect(out.processed).toBe(0)
    expect(prisma.message.update).not.toHaveBeenCalled()
  })

  it('falls back to the wamids array for multi-part sends', async () => {
    // First lookup (externalSourceId) misses; the JSON-array lookup hits.
    prisma.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(OUT_MSG)
    await ingest([
      { id: 'wamid.out2', status: 'read', timestamp: '1700000100' },
    ])
    const second = prisma.message.findFirst.mock.calls[1][0].where
    expect(second.contentAttributes).toEqual({
      path: ['wamids'],
      array_contains: 'wamid.out2',
    })
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'READ' }),
      }),
    )
  })
})

describe('WhatsappService.stampOutbound', () => {
  let prisma: Prisma
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeConversations())
  })

  it('stamps externalSourceId with the first wamid and keeps them all', async () => {
    prisma.message.findUnique.mockResolvedValue({
      id: 'm1',
      contentAttributes: { external_created_at: '2026-01-01T00:00:00.000Z' },
    })
    await svc.stampOutbound('m1', ['wamid.a', null, 'wamid.b'])
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        externalSourceId: 'wamid.a',
        contentAttributes: {
          external_created_at: '2026-01-01T00:00:00.000Z',
          wamids: ['wamid.a', 'wamid.b'],
        },
      },
    })
  })

  it('replaces a previous stamp so dead wamids stop matching', async () => {
    prisma.message.findUnique.mockResolvedValue({
      id: 'm1',
      contentAttributes: { wamids: ['wamid.dead'] },
    })
    await svc.stampOutbound('m1', ['wamid.retry'])
    const data = prisma.message.update.mock.calls[0][0].data
    expect(data.externalSourceId).toBe('wamid.retry')
    expect(data.contentAttributes.wamids).toEqual(['wamid.retry'])
  })

  it('is a no-op when the send returned no wamid', async () => {
    await svc.stampOutbound('m1', [null, undefined, ''])
    expect(prisma.message.findUnique).not.toHaveBeenCalled()
    expect(prisma.message.update).not.toHaveBeenCalled()
  })
})


describe('WhatsappService — delivery-receipt branch coverage', () => {
  let prisma: Prisma
  let realtime: ReturnType<typeof makeRealtime>
  let svc: WhatsappService

  function statusPayload(statuses: Array<Record<string, unknown>>) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
                statuses,
              },
            },
          ],
        },
      ],
    }
  }
  async function ingest(statuses: Array<Record<string, unknown>>) {
    const payload = statusPayload(statuses)
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  beforeEach(() => {
    prisma = makePrisma()
    realtime = makeRealtime()
    svc = makeService(prisma, makeConversations(), realtime)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.message.update.mockResolvedValue({})
  })

  it('handles a message row that carries no contentAttributes at all', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'SENT', contentAttributes: null,
    })
    await ingest([{ id: 'w1', status: 'delivered', timestamp: '1700000100' }])
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
    )
  })

  it('records a failure whose error object carries only error_data.details', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'SENT', contentAttributes: {},
    })
    await ingest([
      {
        id: 'w1', status: 'failed', timestamp: '1700000100',
        errors: [{ code: 131026, error_data: { details: 'undeliverable' } }],
      },
    ])
    const data = prisma.message.update.mock.calls[0][0].data
    expect(data.contentAttributes.deliveryError).toEqual(
      expect.objectContaining({ code: 131026, title: null, detail: 'undeliverable' }),
    )
  })

  it('records a failure with no errors array at all', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'SENT', contentAttributes: {},
    })
    await ingest([{ id: 'w1', status: 'failed', timestamp: '1700000100' }])
    const data = prisma.message.update.mock.calls[0][0].data
    expect(data.contentAttributes.deliveryError).toEqual(
      expect.objectContaining({ code: null, title: null, detail: null }),
    )
  })

  it('ignores a receipt for a status it has already passed', async () => {
    // DELIVERED arriving twice: rank comparison must short-circuit.
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'DELIVERED', contentAttributes: {},
    })
    const out = await ingest([{ id: 'w1', status: 'delivered', timestamp: '1700000100' }])
    expect(out.processed).toBe(0)
    expect(prisma.message.update).not.toHaveBeenCalled()
  })

  it('ignores a receipt status Meta did not have when this was written', async () => {
    // st.status is typed, but Meta adds statuses over time. An unrecognised
    // one ranks as 0 and must never move the message backwards.
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'DELIVERED', contentAttributes: {},
    })
    const out = await ingest([{ id: 'w1', status: 'deleted', timestamp: '1700000100' }])
    expect(out.processed).toBe(0)
    expect(prisma.message.update).not.toHaveBeenCalled()
  })

  it('handles an unknown stored status defensively', async () => {
    // A row in a status the ladder doesn't know ranks as 0, so real progress
    // still applies rather than silently dropping.
    prisma.message.findFirst.mockResolvedValueOnce({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      status: 'WEIRD', contentAttributes: {},
    })
    await ingest([{ id: 'w1', status: 'read', timestamp: '1700000100' }])
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'READ' }) }),
    )
  })
})

describe('WhatsappService.stampOutbound — remaining branches', () => {
  it('is a no-op when the message row is gone', async () => {
    const prisma = makePrisma()
    prisma.message.findUnique.mockResolvedValue(null)
    await makeService(prisma, makeConversations()).stampOutbound('missing', ['w1'])
    expect(prisma.message.update).not.toHaveBeenCalled()
  })

  it('stamps a row that has no contentAttributes yet', async () => {
    const prisma = makePrisma()
    prisma.message.findUnique.mockResolvedValue({ id: 'm1', contentAttributes: null })
    await makeService(prisma, makeConversations()).stampOutbound('m1', ['w1'])
    expect(prisma.message.update.mock.calls[0][0].data).toEqual({
      externalSourceId: 'w1',
      contentAttributes: { wamids: ['w1'] },
    })
  })
})


// ---------- inbound media is downloaded, not just referenced ----------

describe('WhatsappService — inbound media download', () => {
  let prisma: Prisma
  let convs: Conversations
  let attachments: ReturnType<typeof makeAttachments>
  let svc: WhatsappService

  function sendMedia(msg: Record<string, unknown>, inbox = WA_INBOX) {
    prisma.inbox.findUnique.mockResolvedValue(inbox)
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: { messaging_product: 'whatsapp', metadata: {}, messages: [msg] },
            },
          ],
        },
      ],
    }
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  const doc = (id = 'm-doc', filename: string | undefined = 'Formulario.docx') => ({
    id: 'wamid.1',
    from: '5511',
    timestamp: '0',
    type: 'document',
    document: {
      id,
      filename,
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  })

  const ingested = () =>
    convs.ingestExternalInbound.mock.calls[0]![0] as {
      attachmentIds?: string[]
      contentAttributes: Record<string, unknown>
    }

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    attachments = makeAttachments()
    svc = makeService(prisma, convs, makeRealtime(), attachments)
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores the file and hands the attachment to the message (the lost .docx)', async () => {
    const fetchSpy = stubMetaMedia({ mime: 'application/pdf' })
    await sendMedia(doc())
    expect(fetchSpy.mock.calls[0]![0]).toContain('/m-doc')
    expect(fetchSpy.mock.calls[1]![0]).toBe('https://lookaside.example/file')
    // Both hops carry the inbox token; Meta rejects the file URL without it.
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({
        authorization: 'Bearer EAAxxxxAccessTokenxxxxxxx',
      })
    }
    const [accountId, file, messageId] = attachments.ingestFromChannel.mock.calls[0]!
    expect(accountId).toBe('acc1')
    expect(file).toMatchObject({
      fileName: 'Formulario.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    expect((file as { buffer: Buffer }).buffer.length).toBe(3)
    expect(messageId).toBeUndefined()
    expect(ingested().attachmentIds).toEqual(['att1'])
    expect(ingested().contentAttributes.mediaDownloadError).toBeUndefined()
  })

  it("names unnamed media after Meta's mime type", async () => {
    stubMetaMedia({ mime: 'audio/ogg; codecs=opus' })
    await sendMedia({ id: 'w', from: '5511', timestamp: '0', type: 'audio', audio: { id: 'm-a' } })
    expect(attachments.ingestFromChannel.mock.calls[0]![1]).toMatchObject({
      fileName: 'whatsapp-media.ogg',
      mimeType: 'audio/ogg; codecs=opus',
    })
  })

  it('keeps the message and records why when the lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as Response)
    await sendMedia(doc())
    expect(ingested().attachmentIds).toBeUndefined()
    expect(ingested().contentAttributes.mediaDownloadError).toBe('media lookup failed (404)')
  })

  it('records a lookup with no url', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response)
    await sendMedia(doc())
    expect(ingested().contentAttributes.mediaDownloadError).toBe('media lookup returned no url')
  })

  it('refuses a file larger than the ceiling without downloading it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://lookaside.example/file', file_size: 200 * 1024 * 1024 }),
    } as Response)
    await sendMedia(doc())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(ingested().contentAttributes.mediaDownloadError).toMatch(/^media too large/)
  })

  it('records a failed file download', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://lookaside.example/file' }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
    await sendMedia(doc())
    expect(ingested().contentAttributes.mediaDownloadError).toBe('media download failed (403)')
  })

  it('survives a network error (Error and non-Error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('socket hang up'))
    await sendMedia(doc())
    expect(ingested().contentAttributes.mediaDownloadError).toBe('socket hang up')

    convs.ingestExternalInbound.mockClear()
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('aborted')
    await sendMedia({ ...doc(), id: 'wamid.2' })
    expect(ingested().contentAttributes.mediaDownloadError).toBe('aborted')
  })

  it('reports an inbox without a token instead of calling Meta', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const noToken = {
      ...WA_INBOX,
      channelConfig: { ...WA_INBOX.channelConfig, accessToken: undefined },
    }
    await sendMedia(doc(), noToken as never)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ingested().contentAttributes.mediaDownloadError).toBe('inbox has no access token')
  })

  it('does nothing for an empty media id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await sendMedia(doc(''))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(ingested().attachmentIds).toBeUndefined()
  })
})

describe('defaultFileName', () => {
  it('uses the mime subtype, dropping parameters', () => {
    expect(defaultFileName('image/jpeg')).toBe('whatsapp-media.jpeg')
    expect(defaultFileName('audio/ogg; codecs=opus')).toBe('whatsapp-media.ogg')
  })
  it('falls back to a bare name', () => {
    expect(defaultFileName(undefined)).toBe('whatsapp-media')
    expect(defaultFileName('weird')).toBe('whatsapp-media')
    expect(defaultFileName('x/ ;y')).toBe('whatsapp-media')
  })
})

describe('WhatsappService.backfillInboundMedia', () => {
  let prisma: Prisma
  let attachments: ReturnType<typeof makeAttachments>
  let svc: WhatsappService

  beforeEach(() => {
    prisma = makePrisma()
    attachments = makeAttachments()
    svc = makeService(prisma, makeConversations(), makeRealtime(), attachments)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('404s for an unknown inbox', async () => {
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(svc.backfillInboundMedia('nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('recovers what Meta still has, skips what has no id, reports the rest', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.message.findMany.mockResolvedValue([
      { id: 'msg-ok', contentAttributes: { mediaId: 'm1', filename: 'a.docx', mimeType: 'x/y' } },
      { id: 'msg-sticker', contentAttributes: { sticker: true } },
      { id: 'msg-null', contentAttributes: null },
      { id: 'msg-gone', contentAttributes: { mediaId: 'm2' } },
    ])
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://lookaside.example/file' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(3),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)

    const out = await svc.backfillInboundMedia('inb1')

    expect(out).toEqual({
      recovered: 1,
      failed: [{ messageId: 'msg-gone', error: 'media lookup failed (404)' }],
    })
    // Backfill attaches straight to the existing message.
    expect(attachments.ingestFromChannel.mock.calls[0]![2]).toBe('msg-ok')
    expect(prisma.message.findMany.mock.calls[0]![0].where).toMatchObject({
      inboxId: 'inb1',
      senderType: 'CONTACT',
      attachments: { none: {} },
    })
  })
})

// ---------- credentials encrypted at rest ----------
//
// The stored channelConfig holds v1:<iv>:<tag>:<ciphertext> for the three
// secrets. Every consumer must unwrap at the moment of use: the webhook
// verify token, the HMAC signature, the three send paths, the inbound media
// download and the template sync. If any of them read the column raw, the
// value it would send to Meta is the ciphertext.

describe('WhatsappService: encrypted channel credentials', () => {
  const KEY = randomBytes(32).toString('base64')
  let prisma: Prisma
  let convs: Conversations
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  /** WA_INBOX with the three secrets stored wrapped. */
  function encryptedInbox() {
    return {
      ...WA_INBOX,
      channelConfig: encryptSecretsIn({ ...WA_INBOX.channelConfig }, [
        'accessToken',
        'appSecret',
        'webhookVerifyToken',
      ]),
    }
  }

  beforeEach(() => {
    process.env.COSMIKA_SECRETS_KEY = KEY
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    prisma = makePrisma()
    convs = makeConversations()
    svc = makeService(prisma, convs)
  })
  afterEach(() => {
    delete process.env.COSMIKA_SECRETS_KEY
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('stores the verify token unreadably yet still answers Meta`s subscription challenge', async () => {
    const inbox = encryptedInbox()
    expect(inbox.channelConfig.webhookVerifyToken).not.toContain(
      'verify-string-shared-with-meta',
    )
    prisma.inbox.findUnique.mockResolvedValue(inbox)
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'verify-string-shared-with-meta', 'echo'),
    ).resolves.toBe('echo')
  })

  it('still rejects a wrong verify token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    await expect(
      svc.verifyChallenge('inb1', 'subscribe', 'WRONG-TOKEN', 'echo'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('accepts a webhook signed with the plaintext app secret', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const body = { object: 'whatsapp_business_account', entry: [] }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    await expect(svc.ingestWebhook('inb1', raw, sig, body as never)).resolves.toEqual({
      processed: 0,
    })
  })

  it('rejects a webhook signed with the ciphertext, which is what a raw read would expect', async () => {
    const inbox = encryptedInbox()
    prisma.inbox.findUnique.mockResolvedValue(inbox)
    const body = { object: 'whatsapp_business_account', entry: [] }
    const { raw, sig } = signedPayload(body, inbox.channelConfig.appSecret as string)
    await expect(svc.ingestWebhook('inb1', raw, sig, body as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('sends text with the plaintext bearer token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.1' }] }),
    } as Response)
    await svc.sendOutbound('inb1', '+5511', 'hi')
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(
      `Bearer ${WA_INBOX.channelConfig.accessToken}`,
    )
    expect(headers.authorization).not.toContain('v1:')
  })

  it('sends an interactive message with the plaintext bearer token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.2' }] }),
    } as Response)
    await svc.sendInteractive('inb1', '+5511', {
      kind: 'buttons',
      body: 'pick',
      buttons: [{ id: 'a', label: 'A' }],
    } as never)
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(`Bearer ${WA_INBOX.channelConfig.accessToken}`)
  })

  it('sends a template with the plaintext bearer token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.3' }] }),
    } as Response)
    await svc.sendTemplate('inb1', '+5511', 'hello_world', 'pt_BR', [])
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(`Bearer ${WA_INBOX.channelConfig.accessToken}`)
  })

  it('syncs templates with the plaintext bearer token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response)
    await svc.fetchTemplatesFromMeta('inb1')
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(`Bearer ${WA_INBOX.channelConfig.accessToken}`)
  })

  it('uploads media with the plaintext bearer token', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'media-1' }) } as Response)
    await svc.uploadMedia('inb1', {
      buffer: Buffer.from([1]),
      mimeType: 'image/png',
      fileName: 'a.png',
    })
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(`Bearer ${WA_INBOX.channelConfig.accessToken}`)
  })

  it('downloads inbound media with the plaintext bearer token, on both hops', async () => {
    prisma.inbox.findUnique.mockResolvedValue(encryptedInbox())
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'A' })
    prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.findFirst.mockResolvedValue(null)
    const fetchSpy = stubMetaMedia()
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {},
                messages: [
                  {
                    id: 'wamid.in.1',
                    from: '5511',
                    timestamp: '0',
                    type: 'image',
                    image: { id: 'media-in-1', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const { raw, sig } = signedPayload(body, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, body as never)
    expect(fetchSpy.mock.calls.length).toBe(2)
    for (const call of fetchSpy.mock.calls) {
      expect((call[1] as RequestInit).headers).toEqual({
        authorization: `Bearer ${WA_INBOX.channelConfig.accessToken}`,
      })
    }
  })

  it.each([[null], ['a string'], [[1, 2]]])(
    'treats a channelConfig of %s as no credentials at all',
    async (channelConfig) => {
      prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelConfig })
      await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(
        'missing credentials',
      )
    },
  )

  it('fails loudly when the stored value cannot be decrypted, rather than sending garbage', async () => {
    const inbox = encryptedInbox()
    process.env.COSMIKA_SECRETS_KEY = randomBytes(32).toString('base64')
    prisma.inbox.findUnique.mockResolvedValue(inbox)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(svc.sendOutbound('inb1', '+5511', 'hi')).rejects.toThrow(
      /could not be decrypted/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still reads a channel that has not been migrated yet', async () => {
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.4' }] }),
    } as Response)
    await svc.sendOutbound('inb1', '+5511', 'hi')
    const headers = (fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe(`Bearer ${WA_INBOX.channelConfig.accessToken}`)
  })
})

// Conversation 8746 (2026-10-28): a thumbs-up arrived as a "[reaction]"
// message, woke the AI (which thanked the contact for it) and said nothing
// about which message it was for.
describe('WhatsappService — reactions', () => {
  let prisma: Prisma
  let convs: Conversations
  let realtime: ReturnType<typeof makeRealtime>
  let svc: WhatsappService
  const ORIGINAL_STUB = process.env.COSMIKA_WHATSAPP_STUB

  const CONTACT = { id: 'ct1', accountId: 'acc1', phoneNumber: '5511999999999', name: 'Joana', blockedAt: null }
  const TARGET = {
    id: 'm-out',
    accountId: 'acc1',
    conversationId: 'cv1',
    inboxId: 'inb1',
    externalSourceId: 'wamid.out1',
    contentAttributes: { wamids: ['wamid.out1'] },
  }

  function reactionPayload(reaction: Record<string, unknown> | undefined) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
                contacts: [{ wa_id: '5511999999999', profile: { name: 'Joana' } }],
                messages: [
                  {
                    id: 'wamid.reaction1',
                    from: '5511999999999',
                    timestamp: '1700000000',
                    type: 'reaction',
                    ...(reaction ? { reaction } : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    return svc.ingestWebhook('inb1', raw, sig, payload as never)
  }

  beforeEach(() => {
    prisma = makePrisma()
    convs = makeConversations()
    realtime = makeRealtime()
    svc = makeService(prisma, convs, realtime)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.contact.findFirst.mockResolvedValue(CONTACT)
    prisma.message.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ ...TARGET, ...args.data }),
    )
  })

  afterEach(() => {
    process.env.COSMIKA_WHATSAPP_STUB = ORIGINAL_STUB
    vi.restoreAllMocks()
  })

  it('puts the emoji on the message it points at, and stores nothing as a message', async () => {
    prisma.message.findFirst.mockResolvedValueOnce(TARGET)
    await reactionPayload({ message_id: 'wamid.out1', emoji: '👍' })

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { inboxId: 'inb1', externalSourceId: 'wamid.out1' },
    })
    const data = prisma.message.update.mock.calls[0]![0].data
    expect(data.contentAttributes.reactions).toEqual({
      contact: { emoji: '👍', at: '2023-11-14T22:13:20.000Z' },
    })
    // Kept what was there.
    expect(data.contentAttributes.wamids).toEqual(['wamid.out1'])
    expect(realtime.publish).toHaveBeenCalledWith({
      type: 'MessageReactionChanged',
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      messageId: 'm-out',
      reactions: { contact: { emoji: '👍', at: '2023-11-14T22:13:20.000Z' } },
    })
    // Not a message: no thread row, no bot, no AI, no new conversation.
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
    expect(prisma.conversation.create).not.toHaveBeenCalled()
  })

  it('finds the second part of a multi-part send by its extra wamid', async () => {
    prisma.message.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(TARGET)
    await reactionPayload({ message_id: 'wamid.part2', emoji: '❤️' })
    expect(prisma.message.findFirst).toHaveBeenLastCalledWith({
      where: { inboxId: 'inb1', contentAttributes: { path: ['wamids'], array_contains: 'wamid.part2' } },
    })
    expect(prisma.message.update).toHaveBeenCalled()
  })

  it('takes the reaction off when the emoji comes empty, keeping ours', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({
      ...TARGET,
      contentAttributes: { reactions: { contact: { emoji: '👍' }, business: { emoji: '🙏' } } },
    })
    await reactionPayload({ message_id: 'wamid.out1', emoji: '' })
    expect(prisma.message.update.mock.calls[0]![0].data.contentAttributes.reactions).toEqual({
      business: { emoji: '🙏' },
    })
  })

  it('treats a missing emoji as a removal, and a message with no attributes as empty', async () => {
    prisma.message.findFirst.mockResolvedValueOnce({ ...TARGET, contentAttributes: null })
    await reactionPayload({ message_id: 'wamid.out1' })
    expect(prisma.message.update.mock.calls[0]![0].data.contentAttributes).toEqual({ reactions: {} })
  })

  it('drops a reaction to a message we never stored, or with no target', async () => {
    prisma.message.findFirst.mockResolvedValue(null)
    await reactionPayload({ message_id: 'wamid.unknown', emoji: '👍' })
    await reactionPayload(undefined)
    expect(prisma.message.update).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalled()
    expect(convs.ingestExternalInbound).not.toHaveBeenCalled()
  })

  it('uses the arrival time when the provider timestamp is unreadable', async () => {
    prisma.message.findFirst.mockResolvedValueOnce(TARGET)
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'biz1', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '+5511', phone_number_id: '1234567890' },
        contacts: [{ wa_id: '5511999999999' }],
        messages: [{ id: 'wamid.r2', from: '5511999999999', timestamp: 'x', type: 'reaction', reaction: { message_id: 'wamid.out1', emoji: '😂' } }],
      } }] }],
    }
    const { raw, sig } = signedPayload(payload, WA_INBOX.channelConfig.appSecret)
    await svc.ingestWebhook('inb1', raw, sig, payload as never)
    const at = prisma.message.update.mock.calls[0]![0].data.contentAttributes.reactions.contact.at
    expect(Number.isNaN(Date.parse(at))).toBe(false)
  })

  it('sendReaction posts a reaction to the Cloud API', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response)
    await svc.sendReaction('inb1', '5511999999999', 'wamid.in1', '❤️')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toMatch(/\/1234567890\/messages$/)
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999999999',
      type: 'reaction',
      reaction: { message_id: 'wamid.in1', emoji: '❤️' },
    })
  })

  it('sendReaction surfaces what Meta said when it refuses', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '0'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"code":131047}}',
    } as Response)
    await expect(svc.sendReaction('inb1', '5511', 'wamid.in1', '👍')).rejects.toThrow(
      'WhatsApp reaction failed (400): {"error":{"code":131047}}',
    )
  })

  it('sendReaction does nothing in stub mode', async () => {
    process.env.COSMIKA_WHATSAPP_STUB = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await svc.sendReaction('inb1', '5511', 'wamid.in1', '👍')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
  })
})
