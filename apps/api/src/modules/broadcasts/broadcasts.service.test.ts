import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BroadcastsService } from './broadcasts.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    inbox: { findUnique: vi.fn() },
    whatsappTemplate: { findUnique: vi.fn() },
    broadcast: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    contactInbox: { count: vi.fn(), findMany: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn() },
    message: { create: vi.fn() },
  }
}

function makeWhatsapp() {
  return {
    sendTemplate: vi.fn().mockResolvedValue({ wamid: 'w1' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
  }
}

function makeService(prisma = makePrisma(), wa = makeWhatsapp()) {
  const realtime = { publish: vi.fn(async () => undefined) }
  return {
    svc: new BroadcastsService(prisma as never, wa as never, realtime as never),
    prisma,
    wa,
    realtime,
  }
}

const ADMIN = { id: 'm1', userId: 'u1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { id: 'm2', userId: 'u1', role: 'AGENT', isActive: true }
const WA_INBOX = { id: 'inb1', accountId: 'acc1', channelType: 'WHATSAPP' }
const TEMPLATE = {
  id: 'tpl1',
  inboxId: 'inb1',
  name: 'appt',
  language: 'pt_BR',
  status: 'APPROVED',
  body: 'Olá {{1}}',
  variableCount: 1,
}

describe('BroadcastsService.previewAudience', () => {
  it('403 when not a member', async () => {
    const { svc, prisma } = makeService()
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      svc.previewAudience('u1', 'acc1', 'inb1', {}),
    ).rejects.toThrow(ForbiddenException)
  })

  it('counts contactInbox rows, applying the country filter', async () => {
    const { svc, prisma } = makeService()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.contactInbox.count.mockResolvedValue(42)
    const out = await svc.previewAudience('u1', 'acc1', 'inb1', { country: 'BR' })
    expect(out).toEqual({ count: 42 })
    const where = prisma.contactInbox.count.mock.calls[0]![0].where
    expect(where.inboxId).toBe('inb1')
    expect(where.contact.additionalAttributes).toEqual({
      path: ['country_code'],
      equals: 'BR',
    })
    expect(where.contact.phoneNumber).toEqual({ not: null })
  })

  it('omits the country filter when audience is empty', async () => {
    const { svc, prisma } = makeService()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.contactInbox.count.mockResolvedValue(5)
    await svc.previewAudience('u1', 'acc1', 'inb1', {})
    const where = prisma.contactInbox.count.mock.calls[0]![0].where
    expect(where.contact.additionalAttributes).toBeUndefined()
  })
})

describe('BroadcastsService.create', () => {
  let prisma: ReturnType<typeof makePrisma>
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 for AGENT (non-mutator)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: ['x'],
        audience: {},
      }),
    ).rejects.toThrow(/Administrator or Supervisor/)
  })

  it('400 when the inbox is not WhatsApp', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, channelType: 'WEB_WIDGET' })
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: ['x'],
        audience: {},
      }),
    ).rejects.toThrow(/WhatsApp inbox/)
  })

  it('404 cross-account inbox', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: ['x'],
        audience: {},
      }),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 when template not found for the inbox', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.whatsappTemplate.findUnique.mockResolvedValue({ ...TEMPLATE, inboxId: 'OTHER' })
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: ['x'],
        audience: {},
      }),
    ).rejects.toThrow(/Template not found/)
  })

  it('400 when template is not approved', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.whatsappTemplate.findUnique.mockResolvedValue({ ...TEMPLATE, status: 'PENDING' })
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: ['x'],
        audience: {},
      }),
    ).rejects.toThrow(/not approved/)
  })

  it('400 on variable-count mismatch', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'B',
        inboxId: 'inb1',
        templateId: 'tpl1',
        variables: [],
        audience: {},
      }),
    ).rejects.toThrow(/expects 1 variable/)
  })

  it('creates a DRAFT broadcast', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    prisma.broadcast.create.mockResolvedValue({ id: 'b1' })
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      name: 'B',
      inboxId: 'inb1',
      templateId: 'tpl1',
      variables: ['Ana'],
      audience: { country: 'BR' },
    })
    const data = prisma.broadcast.create.mock.calls[0]![0].data
    expect(data.status).toBe('DRAFT')
    expect(data.variables).toEqual(['Ana'])
    expect(data.createdById).toBe('u1')
  })
})

describe('BroadcastsService.send', () => {
  let prisma: ReturnType<typeof makePrisma>
  let wa: ReturnType<typeof makeWhatsapp>
  const DRAFT = {
    id: 'b1',
    accountId: 'acc1',
    inboxId: 'inb1',
    templateId: 'tpl1',
    variables: ['Ana'],
    audience: { country: 'BR' },
    status: 'DRAFT',
  }
  beforeEach(() => {
    prisma = makePrisma()
    wa = makeWhatsapp()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    prisma.broadcast.update.mockResolvedValue({ id: 'b1' })
  })

  it('404 unknown / cross-account', async () => {
    prisma.broadcast.findUnique.mockResolvedValue({ ...DRAFT, accountId: 'other' })
    const { svc } = makeService(prisma, wa)
    await expect(svc.send('u1', 'acc1', 'b1')).rejects.toThrow(NotFoundException)
  })

  it('400 when already sent', async () => {
    prisma.broadcast.findUnique.mockResolvedValue({ ...DRAFT, status: 'SENT' })
    const { svc } = makeService(prisma, wa)
    await expect(svc.send('u1', 'acc1', 'b1')).rejects.toThrow(/already been sent/)
  })

  it('delivers to each recipient: reuses or creates a conversation, sends the template, marks SENT', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(DRAFT)
    prisma.contactInbox.findMany.mockResolvedValue([
      { id: 'ci1', contactId: 'c1', contact: { id: 'c1', phoneNumber: '+551' } },
      { id: 'ci2', contactId: 'c2', contact: { id: 'c2', phoneNumber: '+552' } },
    ])
    // first recipient has an open conversation, second does not
    prisma.conversation.findFirst
      .mockResolvedValueOnce({ id: 'cv1' })
      .mockResolvedValueOnce(null)
    prisma.conversation.create.mockResolvedValue({
      id: 'cv2',
      createdAt: new Date('2026-08-21T12:00:00Z'),
    })
    prisma.message.create.mockResolvedValue({ id: 'm' })
    prisma.broadcast.update.mockResolvedValue({
      id: 'b1',
      status: 'SENT',
      sentCount: 2,
      failedCount: 0,
    })
    const { svc } = makeService(prisma, wa)
    const out = await svc.send('u1', 'acc1', 'b1')
    expect(out.status).toBe('SENT')
    expect(wa.sendTemplate).toHaveBeenCalledTimes(2)
    // rendered body passed to the message (Olá Ana)
    const msg = prisma.message.create.mock.calls[0]![0].data
    expect(msg.content).toBe('Olá Ana')
    expect(msg.contentAttributes.broadcast).toBe(true)
    // second recipient created a fresh conversation
    expect(prisma.conversation.create).toHaveBeenCalledTimes(1)
    // SENDING was set first, then the final counts
    expect(prisma.broadcast.update.mock.calls[0]![0].data.status).toBe('SENDING')
    const final = prisma.broadcast.update.mock.calls[1]![0].data
    expect(final.sentCount).toBe(2)
    expect(final.failedCount).toBe(0)
    expect(final.status).toBe('SENT')
  })

  it('counts per-recipient failures; FAILED when none succeed', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(DRAFT)
    prisma.contactInbox.findMany.mockResolvedValue([
      { id: 'ci1', contactId: 'c1', contact: { id: 'c1', phoneNumber: '+551' } },
    ])
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.create.mockResolvedValue({ id: 'm' })
    wa.sendTemplate.mockRejectedValue(new Error('wa down'))
    const { svc } = makeService(prisma, wa)
    await svc.send('u1', 'acc1', 'b1')
    const final = prisma.broadcast.update.mock.calls[1]![0].data
    expect(final.failedCount).toBe(1)
    expect(final.sentCount).toBe(0)
    expect(final.status).toBe('FAILED')
  })

  it('404 when the template no longer exists', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(DRAFT)
    prisma.whatsappTemplate.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma, wa)
    await expect(svc.send('u1', 'acc1', 'b1')).rejects.toThrow(/Template no longer/)
  })

  it('tolerates null variables (leaves placeholders unrendered)', async () => {
    prisma.broadcast.findUnique.mockResolvedValue({ ...DRAFT, variables: null })
    prisma.contactInbox.findMany.mockResolvedValue([
      { id: 'ci1', contactId: 'c1', contact: { id: 'c1', phoneNumber: '+551' } },
    ])
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.create.mockResolvedValue({ id: 'm' })
    const { svc } = makeService(prisma, wa)
    await svc.send('u1', 'acc1', 'b1')
    // {{1}} stays literal when there's no variable to fill it
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('Olá {{1}}')
  })

  it('counts a non-Error recipient rejection (String(err) branch)', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(DRAFT)
    prisma.contactInbox.findMany.mockResolvedValue([
      { id: 'ci1', contactId: 'c1', contact: { id: 'c1', phoneNumber: '+551' } },
    ])
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    prisma.message.create.mockResolvedValue({ id: 'm' })
    wa.sendTemplate.mockRejectedValue('boom') // non-Error
    const { svc } = makeService(prisma, wa)
    await svc.send('u1', 'acc1', 'b1')
    const final = prisma.broadcast.update.mock.calls[1]![0].data
    expect(final.failedCount).toBe(1)
  })
})

describe('BroadcastsService.list + toDTO', () => {
  it('lists broadcasts for the account', async () => {
    const { svc, prisma } = makeService()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.broadcast.findMany.mockResolvedValue([{ id: 'b1' }])
    expect(await svc.list('u1', 'acc1')).toEqual([{ id: 'b1' }])
  })

  it('serializes a broadcast row', () => {
    const { svc } = makeService()
    const dto = svc.toDTO({
      id: 'b1',
      accountId: 'acc1',
      inboxId: 'inb1',
      name: 'B',
      templateId: 'tpl1',
      variables: ['Ana'],
      audience: { country: 'BR' },
      status: 'SENT',
      totalRecipients: 2,
      sentCount: 2,
      failedCount: 0,
      sentAt: new Date('2026-06-25T00:00:00Z'),
      createdAt: new Date('2026-06-25T00:00:00Z'),
    } as never)
    expect(dto.audience).toEqual({ country: 'BR' })
    expect(dto.variables).toEqual(['Ana'])
    expect(dto.sentAt).toBe('2026-06-25T00:00:00.000Z')
  })

  it('toDTO null-coalesces missing variables + null sentAt', () => {
    const { svc } = makeService()
    const dto = svc.toDTO({
      id: 'b1',
      accountId: 'acc1',
      inboxId: 'inb1',
      name: 'B',
      templateId: 'tpl1',
      variables: null,
      audience: {},
      status: 'DRAFT',
      totalRecipients: 0,
      sentCount: 0,
      failedCount: 0,
      sentAt: null,
      createdAt: new Date('2026-06-25T00:00:00Z'),
    } as never)
    expect(dto.variables).toEqual([])
    expect(dto.sentAt).toBeNull()
  })
})
