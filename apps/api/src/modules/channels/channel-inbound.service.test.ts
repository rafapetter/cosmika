import { describe, expect, it, vi } from 'vitest'

import { ChannelInboundService } from './channel-inbound.service'

const INBOX = { id: 'inb1', accountId: 'acc1', channelType: 'TELEGRAM', agentBotId: null, defaultFlowId: null } as never

function makePrisma() {
  const prisma = {
    contactInbox: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ci-new', contactId: 'ct1', inboxId: 'inb1', sourceId: '777' }),
    },
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ct1', name: 'Ana', blockedAt: null }),
      update: vi.fn().mockImplementation(async ({ data }) => ({ id: 'ct1', blockedAt: null, ...data })),
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'cv-new', createdAt: new Date('2026-10-16T12:00:00Z') }),
    },
    message: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  }
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma))
  return prisma
}

function make() {
  const prisma = makePrisma()
  const realtime = { publish: vi.fn().mockResolvedValue(undefined) }
  const conversations = { ingestExternalInbound: vi.fn().mockResolvedValue({ id: 'm1' }) }
  const svc = new ChannelInboundService(prisma as never, realtime as never, conversations as never)
  return { svc, prisma, realtime, conversations }
}

const SENDER = { sourceId: '777', identifier: 'telegram:555', name: 'Ana' }

describe('ChannelInboundService.resolve', () => {
  it('creates contact, contact inbox and a billable conversation for a first message', async () => {
    const { svc, prisma, realtime } = make()
    const out = await svc.resolve(INBOX, { ...SENDER, additionalAttributes: { telegramUsername: 'anas' } })
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        name: 'Ana',
        identifier: 'telegram:555',
        additionalAttributes: { telegramUsername: 'anas' },
      },
    })
    expect(prisma.contactInbox.create).toHaveBeenCalledWith({
      data: { contactId: 'ct1', inboxId: 'inb1', sourceId: '777' },
    })
    expect(prisma.$executeRaw).toHaveBeenCalled()
    expect(prisma.conversation.create.mock.calls[0]![0].data).toMatchObject({
      accountId: 'acc1',
      inboxId: 'inb1',
      contactId: 'ct1',
      contactInboxId: 'ci-new',
      status: 'OPEN',
      origin: 'INBOUND',
    })
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'ConversationCreated', conversationId: 'cv-new' }))
    expect(out).toMatchObject({ kind: 'ok', conversation: { id: 'cv-new' } })
  })

  it('reuses the known sender and the conversation in progress, without announcing it', async () => {
    const { svc, prisma, realtime } = make()
    prisma.contactInbox.findUnique.mockResolvedValueOnce({
      id: 'ci1',
      contactId: 'ct1',
      contact: { id: 'ct1', name: 'Ana', blockedAt: null },
    })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    const out = await svc.resolve(INBOX, SENDER)
    expect(prisma.contact.create).not.toHaveBeenCalled()
    expect(prisma.contactInbox.create).not.toHaveBeenCalled()
    expect(prisma.conversation.findFirst.mock.calls[0]![0].where.status).toEqual({ not: 'RESOLVED' })
    expect(prisma.conversation.create).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalled()
    expect(out).toMatchObject({ kind: 'ok', conversation: { id: 'cv1' } })
  })

  it('finds the contact by identifier and links the existing contact inbox', async () => {
    const { svc, prisma } = make()
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: null, blockedAt: null })
    prisma.contactInbox.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ci-old', contactId: 'ct1' })
    const out = await svc.resolve(INBOX, SENDER)
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'ct1' }, data: { name: 'Ana' } })
    expect(prisma.contactInbox.create).not.toHaveBeenCalled()
    expect(out).toMatchObject({ kind: 'ok', contactInbox: { id: 'ci-old' } })
  })

  it('leaves a named contact alone and creates without optional fields', async () => {
    const { svc, prisma } = make()
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'Já tem', blockedAt: null })
    await svc.resolve(INBOX, { sourceId: '1', identifier: 'telegram:1' })
    expect(prisma.contact.update).not.toHaveBeenCalled()
    prisma.contact.findFirst.mockResolvedValue(null)
    await svc.resolve(INBOX, { sourceId: '1', identifier: 'telegram:1' })
    expect(prisma.contact.create.mock.calls[0]![0].data).toEqual({ accountId: 'acc1', name: null, identifier: 'telegram:1' })
  })

  it('asks for the name only when the contact has none', async () => {
    const { svc, prisma } = make()
    const lookup = vi.fn().mockResolvedValue('Ana Meta')
    prisma.contactInbox.findUnique.mockResolvedValueOnce({
      id: 'ci1', contactId: 'ct1', contact: { id: 'ct1', name: 'Já tem', blockedAt: null },
    })
    prisma.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    await svc.resolve(INBOX, { sourceId: '1', identifier: 'messenger:1', name: lookup })
    expect(lookup).not.toHaveBeenCalled()

    prisma.contactInbox.findUnique.mockResolvedValueOnce({
      id: 'ci1', contactId: 'ct1', contact: { id: 'ct1', name: null, blockedAt: null },
    })
    await svc.resolve(INBOX, { sourceId: '1', identifier: 'messenger:1', name: lookup })
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: 'ct1' }, data: { name: 'Ana Meta' } })

    lookup.mockResolvedValueOnce(null)
    prisma.contactInbox.findUnique.mockResolvedValueOnce({
      id: 'ci1', contactId: 'ct1', contact: { id: 'ct1', name: null, blockedAt: null },
    })
    await svc.resolve(INBOX, { sourceId: '1', identifier: 'messenger:1', name: lookup })
    expect(prisma.contact.update).toHaveBeenCalledTimes(1)

    await svc.resolve(INBOX, { sourceId: '2', identifier: 'messenger:2', name: lookup })
    expect(prisma.contact.create.mock.calls[0]![0].data.name).toBe('Ana Meta')
  })

  it('drops a blocked contact before anything else is created', async () => {
    const { svc, prisma } = make()
    prisma.contact.findFirst.mockResolvedValue({ id: 'ct1', name: 'X', blockedAt: new Date() })
    await expect(svc.resolve(INBOX, SENDER)).resolves.toEqual({ kind: 'blocked' })
    expect(prisma.contactInbox.create).not.toHaveBeenCalled()
    expect(prisma.conversation.create).not.toHaveBeenCalled()
  })
})

describe('ChannelInboundService helpers', () => {
  it('alreadyIngested looks the provider id up across the inbox', async () => {
    const { svc, prisma } = make()
    await expect(svc.alreadyIngested('inb1', 'tg:1:2')).resolves.toBe(false)
    prisma.message.findFirst.mockResolvedValue({ id: 'm1' })
    await expect(svc.alreadyIngested('inb1', 'tg:1:2')).resolves.toBe(true)
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { inboxId: 'inb1', externalSourceId: 'tg:1:2' },
      select: { id: true },
    })
  })

  it('ingest hands off to the shared conversation chain', async () => {
    const { svc, conversations } = make()
    const args = { accountId: 'acc1', conversationId: 'cv1', content: 'oi' }
    await svc.ingest(args)
    expect(conversations.ingestExternalInbound).toHaveBeenCalledWith(args)
  })

  it('stampOutbound records the provider ids, keeping other attributes', async () => {
    const { svc, prisma } = make()
    await svc.stampOutbound('m1', [null, undefined, ''])
    expect(prisma.message.findUnique).not.toHaveBeenCalled()
    prisma.message.findUnique.mockResolvedValueOnce(null)
    await svc.stampOutbound('m1', ['a'])
    expect(prisma.message.update).not.toHaveBeenCalled()
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'm1', contentAttributes: { ai: true } })
    await svc.stampOutbound('m1', ['777:1', '777:2'])
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { externalSourceId: '777:1', contentAttributes: { ai: true, externalIds: ['777:1', '777:2'] } },
    })
    prisma.message.findUnique.mockResolvedValueOnce({ id: 'm1', contentAttributes: null })
    await svc.stampOutbound('m1', ['x'])
    expect(prisma.message.update.mock.calls[1]![0].data.contentAttributes).toEqual({ externalIds: ['x'] })
  })
})
