import { channelsOver } from '../channels/channels.testing'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CsatService } from './csat.service'
import type { WhatsappService } from '../whatsapp/whatsapp.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    conversation: { findUnique: vi.fn() },
    csatSurvey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    message: {
      create: vi.fn(async () => ({ id: 'm1', createdAt: new Date() })),
    },
    user: { findMany: vi.fn() },
    inbox: { findMany: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeWhatsapp(sendOutbound = vi.fn().mockResolvedValue({ wamid: 'w1' })) {
  return {
    sendOutbound,
    resolveRecipient: vi.fn().mockResolvedValue(null),
    recipientForConversation: vi.fn().mockResolvedValue('+5511'),
  } as unknown as WhatsappService
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return { get: vi.fn((k: string) => overrides[k]) } as unknown as ConfigService
}

function makeEmails() {
  return { send: vi.fn(async () => true) }
}
function makeRealtime() {
  return { publish: vi.fn(async () => undefined) }
}
function makeService(
  prisma: Prisma,
  wa = makeWhatsapp(),
  config = makeConfig(),
  emails = makeEmails(),
  realtime = makeRealtime(),
) {
  return new CsatService(prisma as never, config, channelsOver(wa) as never, emails as never, realtime as never)
}

// ---------- maybeCreateForResolvedConversation ----------

describe('CsatService.maybeCreateForResolvedConversation', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('no-op when conversation not found', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    await makeService(prisma).maybeCreateForResolvedConversation('cv1')
    expect(prisma.csatSurvey.create).not.toHaveBeenCalled()
  })

  it('no-op when inbox.csatEnabled is false', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: 'u1',
      inbox: { csatEnabled: false, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    await makeService(prisma).maybeCreateForResolvedConversation('cv1')
    expect(prisma.csatSurvey.create).not.toHaveBeenCalled()
  })

  it('idempotent — no-op when survey already exists for the conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: 'u1',
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue({ id: 'existing' })
    await makeService(prisma).maybeCreateForResolvedConversation('cv1')
    expect(prisma.csatSurvey.create).not.toHaveBeenCalled()
  })

  it('creates a survey row with 30-day expiry when csatEnabled', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: 'u1',
      inbox: { csatEnabled: true, channelType: 'WEB_WIDGET' },
      account: { defaultLocale: 'en' },
      contact: null,
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({
      id: 's1',
      token: 'tok-abc',
      promptedAt: new Date(),
    })
    const before = Date.now()
    await makeService(prisma).maybeCreateForResolvedConversation('cv1')
    const arg = prisma.csatSurvey.create.mock.calls[0]![0]
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    expect(arg.data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + thirtyDaysMs - 10)
    expect(arg.data.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + thirtyDaysMs + 10)
    expect(arg.data.accountId).toBe('acc1')
    expect(arg.data.assignedAgentId).toBe('u1')
  })

  it('skips WhatsApp send when channel is not WHATSAPP', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WEB_WIDGET' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp()
    // The recipient resolver owns both the channel check and the address
    // lookup, so it is what returns null in these cases.
    wa.recipientForConversation.mockResolvedValue(null)
    await makeService(prisma, wa).maybeCreateForResolvedConversation('cv1')
    expect(wa.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips WhatsApp send when contact has no phoneNumber', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: null },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp()
    // The recipient resolver owns both the channel check and the address
    // lookup, so it is what returns null in these cases.
    wa.recipientForConversation.mockResolvedValue(null)
    await makeService(prisma, wa).maybeCreateForResolvedConversation('cv1')
    expect(wa.sendOutbound).not.toHaveBeenCalled()
  })

  it('sends WhatsApp + persists the SYSTEM message for WhatsApp + phone present', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511999999999' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'public-tok' })
    const wa = makeWhatsapp()
    wa.recipientForConversation.mockResolvedValue('+5511999999999')
    const config = makeConfig({ PUBLIC_WEB_URL: 'https://prod.example.com' })

    await makeService(prisma, wa, config).maybeCreateForResolvedConversation('cv1')

    expect(wa.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+5511999999999',
      expect.stringContaining('https://prod.example.com/csat/public-tok'),
    )
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'cv1',
        senderType: 'SYSTEM',
        content: expect.stringContaining('csat/public-tok'),
        status: 'SENT',
        isPrivate: false,
      }),
    })
  })

  it('falls back to localhost PUBLIC_WEB_URL when config missing', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok-local' })
    const wa = makeWhatsapp()
    await makeService(prisma, wa).maybeCreateForResolvedConversation('cv1')
    expect(wa.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+5511',
      expect.stringContaining('http://localhost:3100/csat/tok-local'),
    )
  })

  it('strips trailing slash from PUBLIC_WEB_URL', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp()
    const config = makeConfig({ PUBLIC_WEB_URL: 'https://app.example.com/' })
    await makeService(prisma, wa, config).maybeCreateForResolvedConversation('cv1')
    expect(wa.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+5511',
      expect.stringContaining('https://app.example.com/csat/tok'),
    )
    // Verify no double-slash
    const sent = (wa.sendOutbound as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string
    expect(sent).not.toMatch(/\/\/csat/)
  })

  it('catches + logs WhatsApp send errors (does NOT throw)', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp(vi.fn().mockRejectedValue(new Error('Meta down')))
    await expect(
      makeService(prisma, wa).maybeCreateForResolvedConversation('cv1'),
    ).resolves.toBeUndefined()
  })

  it('handles non-Error throwables when WhatsApp send fails', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'en' },
      contact: { phoneNumber: '+5511' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp(vi.fn().mockRejectedValue('string throw'))
    await expect(
      makeService(prisma, wa).maybeCreateForResolvedConversation('cv1'),
    ).resolves.toBeUndefined()
  })
})

// ---------- getByToken / submitByToken ----------

describe('CsatService.getByToken', () => {
  it('404 unknown token', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).getByToken('bad')).rejects.toThrow(NotFoundException)
  })

  it('returns the survey hydrated with account + conversation', async () => {
    const prisma = makePrisma()
    const survey = {
      id: 's1',
      token: 'tok',
      account: { name: 'Acme' },
      conversation: { displayId: 42 },
    }
    prisma.csatSurvey.findUnique.mockResolvedValue(survey)
    expect(await makeService(prisma).getByToken('tok')).toBe(survey)
  })
})

describe('CsatService.submitByToken', () => {
  it('404 unknown token', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).submitByToken('bad', { rating: 5 }),
    ).rejects.toThrow(NotFoundException)
  })

  it('400 when already submitted', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({
      id: 's1',
      respondedAt: new Date('2026-01-01'),
      expiresAt: new Date('2027-01-01'),
    })
    await expect(
      makeService(prisma).submitByToken('tok', { rating: 5 }),
    ).rejects.toThrow('already submitted')
  })

  it('400 when expired', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({
      id: 's1',
      respondedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    })
    await expect(
      makeService(prisma).submitByToken('tok', { rating: 5 }),
    ).rejects.toThrow('expired')
  })

  it('updates respondedAt + rating + comment on success', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({
      id: 's1',
      respondedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })
    prisma.csatSurvey.update.mockResolvedValue({ id: 's1' })
    await makeService(prisma).submitByToken('tok', { rating: 4, comment: 'good' })
    expect(prisma.csatSurvey.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        respondedAt: expect.any(Date),
        rating: 4,
        comment: 'good',
      },
    })
  })

  it('comment defaults to null when omitted', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({
      id: 's1',
      respondedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })
    prisma.csatSurvey.update.mockResolvedValue({})
    await makeService(prisma).submitByToken('tok', { rating: 3 })
    expect(prisma.csatSurvey.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ comment: null }) }),
    )
  })

  it('survey with null expiresAt is treated as never expired', async () => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({
      id: 's1',
      respondedAt: null,
      expiresAt: null,
    })
    prisma.csatSurvey.update.mockResolvedValue({})
    await expect(
      makeService(prisma).submitByToken('tok', { rating: 5 }),
    ).resolves.toBeDefined()
  })
})

// ---------- stats ----------

describe('CsatService.stats', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue({
      id: 'm1', userId: 'u1', accountId: 'acc1', role: 'AGENT', isActive: true,
    })
  })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).stats('u1', 'acc1', {})).rejects.toThrow(ForbiddenException)
  })

  it('returns zero stats when no surveys', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    const out = await makeService(prisma).stats('u1', 'acc1', {})
    expect(out).toEqual({
      totalPrompted: 0,
      totalResponded: 0,
      averageRating: null,
      byInbox: [],
      byAgent: [],
    })
  })

  it('aggregates ratings into per-inbox + per-agent buckets', async () => {
    prisma.csatSurvey.count.mockResolvedValue(5)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: 5, inboxId: 'inb-a', assignedAgentId: 'u-alice' },
      { rating: 4, inboxId: 'inb-a', assignedAgentId: 'u-alice' },
      { rating: 3, inboxId: 'inb-b', assignedAgentId: 'u-bob' },
      { rating: 5, inboxId: 'inb-b', assignedAgentId: null },
    ])
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-alice', fullName: 'Alice', email: 'a@b' },
      { id: 'u-bob', fullName: null, email: 'b@b' },
    ])
    prisma.inbox.findMany.mockResolvedValue([
      { id: 'inb-a', name: 'Inbox A' },
      { id: 'inb-b', name: 'Inbox B' },
    ])
    const out = await makeService(prisma).stats('u1', 'acc1', {})
    expect(out.totalPrompted).toBe(5)
    expect(out.totalResponded).toBe(4)
    expect(out.averageRating).toBeCloseTo(4.25, 2)

    const inboxA = out.byInbox.find((b) => b.key === 'inb-a')
    expect(inboxA).toEqual({ key: 'inb-a', label: 'Inbox A', responses: 2, averageRating: 4.5 })
    const inboxB = out.byInbox.find((b) => b.key === 'inb-b')
    expect(inboxB).toEqual({ key: 'inb-b', label: 'Inbox B', responses: 2, averageRating: 4 })

    const alice = out.byAgent.find((b) => b.key === 'u-alice')
    expect(alice?.label).toBe('Alice')
    expect(alice?.averageRating).toBe(4.5)
    const bob = out.byAgent.find((b) => b.key === 'u-bob')
    // bob has fullName=null so label falls back to email
    expect(bob?.label).toBe('b@b')
  })

  it('falls back to inbox id when name lookup fails', async () => {
    prisma.csatSurvey.count.mockResolvedValue(1)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: 5, inboxId: 'unknown-inb', assignedAgentId: null },
    ])
    prisma.inbox.findMany.mockResolvedValue([])
    const out = await makeService(prisma).stats('u1', 'acc1', {})
    expect(out.byInbox[0]?.label).toBe('unknown-inb')
  })

  it('falls back to agent id when user lookup fails', async () => {
    prisma.csatSurvey.count.mockResolvedValue(1)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: 5, inboxId: 'inb-a', assignedAgentId: 'orphan-agent' },
    ])
    prisma.inbox.findMany.mockResolvedValue([{ id: 'inb-a', name: 'A' }])
    prisma.user.findMany.mockResolvedValue([]) // empty — orphan-agent not found
    const out = await makeService(prisma).stats('u1', 'acc1', {})
    const bucket = out.byAgent.find((b) => b.key === 'orphan-agent')
    expect(bucket?.label).toBe('orphan-agent')
  })

  it('ignores responses without a rating', async () => {
    prisma.csatSurvey.count.mockResolvedValue(2)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: null, inboxId: 'inb-a', assignedAgentId: 'u1' },
      { rating: 5, inboxId: 'inb-a', assignedAgentId: 'u1' },
    ])
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', fullName: 'X', email: 'x@y' }])
    prisma.inbox.findMany.mockResolvedValue([{ id: 'inb-a', name: 'A' }])
    const out = await makeService(prisma).stats('u1', 'acc1', {})
    expect(out.totalResponded).toBe(2) // includes the null-rating one
    expect(out.byInbox[0]?.responses).toBe(1) // but ignores it for ratings
    expect(out.averageRating).toBe(5)
  })

  it('applies inboxId / agentId / from / to filters to the where clause', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await makeService(prisma).stats('u1', 'acc1', {
      inboxId: 'inb-x',
      agentId: 'u-x',
      from: '2026-01-01',
      to: '2026-02-01',
    })
    const arg = prisma.csatSurvey.count.mock.calls[0]![0]
    expect(arg.where.inboxId).toBe('inb-x')
    expect(arg.where.assignedAgentId).toBe('u-x')
    expect(arg.where.promptedAt.gte).toBeInstanceOf(Date)
    expect(arg.where.promptedAt.lte).toBeInstanceOf(Date)
  })

  it('omits the promptedAt clause entirely when neither from nor to is set', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await makeService(prisma).stats('u1', 'acc1', {})
    const arg = prisma.csatSurvey.count.mock.calls[0]![0]
    expect(arg.where).not.toHaveProperty('promptedAt')
  })

  it('only-from clause has gte but no lte', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await makeService(prisma).stats('u1', 'acc1', { from: '2026-01-01' })
    const arg = prisma.csatSurvey.count.mock.calls[0]![0]
    expect(arg.where.promptedAt.gte).toBeInstanceOf(Date)
    expect(arg.where.promptedAt.lte).toBeUndefined()
  })

  it('only-to clause has lte but no gte', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await makeService(prisma).stats('u1', 'acc1', { to: '2026-02-01' })
    const arg = prisma.csatSurvey.count.mock.calls[0]![0]
    expect(arg.where.promptedAt.lte).toBeInstanceOf(Date)
    expect(arg.where.promptedAt.gte).toBeUndefined()
  })
})

// ---------- toDTO ----------

describe('CsatService.toDTO', () => {
  const svc = new CsatService(makePrisma() as never, makeConfig(), makeWhatsapp())

  it('maps every field with ISO promptedAt + null-aware respondedAt', () => {
    expect(
      svc.toDTO({
        id: 's1',
        accountId: 'acc1',
        conversationId: 'cv1',
        inboxId: 'inb1',
        token: 'tok',
        assignedAgentId: 'u1',
        promptedAt: new Date('2026-01-01T00:00:00Z'),
        respondedAt: new Date('2026-01-02T00:00:00Z'),
        rating: 5,
        comment: 'great',
      } as never),
    ).toEqual({
      id: 's1',
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      token: 'tok',
      assignedAgentId: 'u1',
      promptedAt: '2026-01-01T00:00:00.000Z',
      respondedAt: '2026-01-02T00:00:00.000Z',
      rating: 5,
      comment: 'great',
    })
  })

  it('emits respondedAt=null when unresponded', () => {
    const dto = svc.toDTO({
      id: 's1',
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      token: 'tok',
      assignedAgentId: null,
      promptedAt: new Date(),
      respondedAt: null,
      rating: null,
      comment: null,
    } as never)
    expect(dto.respondedAt).toBeNull()
  })
})

describe('CsatService prompt language', () => {
  // This is the only string this service sends to a customer, and it lands on
  // a real phone. The Suporte line is Brazilian; English here is not a
  // cosmetic bug, it is the first thing the customer reads after their
  // conversation ends.
  const send = async (defaultLocale: string) => {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale },
      contact: { phoneNumber: '+5511999999999' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    const wa = makeWhatsapp()
    wa.recipientForConversation.mockResolvedValue('+5511999999999')
    const config = makeConfig({ PUBLIC_WEB_URL: 'https://app.cosmobots.io' })
    await makeService(prisma, wa, config).maybeCreateForResolvedConversation('cv1')
    return { text: wa.sendOutbound.mock.calls[0][2] as string, prisma }
  }

  it('asks in Portuguese on a pt-BR account', async () => {
    const { text } = await send('pt-BR')
    expect(text).toContain('Como foi o atendimento?')
    expect(text).not.toContain('How did we do')
  })

  it('asks in Spanish on an es account', async () => {
    const { text } = await send('es')
    expect(text).toContain('¿Cómo estuvo la atención?')
  })

  it('falls back to English for any other locale', async () => {
    expect((await send('en')).text).toContain('How did we do?')
    expect((await send('fr-CA')).text).toContain('How did we do?')
  })

  it('always carries the survey link, whatever the language', async () => {
    for (const locale of ['pt-BR', 'es', 'en']) {
      const { text } = await send(locale)
      expect(text).toContain('https://app.cosmobots.io/csat/tok')
    }
  })

  it('records the transcript message in the same language it sent', async () => {
    // Agents read this back in the conversation; an English line under a
    // Portuguese thread would look like a different system spoke.
    const { text, prisma } = await send('pt-BR')
    expect(prisma.message.create.mock.calls[0][0].data.content).toBe(text)
  })
})

describe('CsatService hourly send cap', () => {
  // Three code paths set a conversation to RESOLVED and only one sends a
  // survey. That asymmetry invites a well-meaning "fix" — and auto-resolve
  // sweeps stale conversations in batches. The cap is what makes a flood
  // impossible regardless of which path calls this.
  const resolve = async (
    { sentLastHour, cap }: { sentLastHour: number; cap?: string },
  ) => {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: null,
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale: 'pt-BR' },
      contact: { phoneNumber: '+5511999999999' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok' })
    prisma.csatSurvey.count.mockResolvedValue(sentLastHour)
    const wa = makeWhatsapp()
    wa.recipientForConversation.mockResolvedValue('+5511999999999')
    const config = makeConfig({
      PUBLIC_WEB_URL: 'https://app.cosmobots.io',
      ...(cap ? { CSAT_HOURLY_SEND_CAP: cap } : {}),
    })
    await makeService(prisma, wa, config).maybeCreateForResolvedConversation('cv1')
    return { wa, prisma }
  }

  it('sends normally at ordinary volume', async () => {
    const { wa } = await resolve({ sentLastHour: 3 })
    expect(wa.sendOutbound).toHaveBeenCalled()
  })

  it('stops sending once the account is over the cap', async () => {
    const { wa } = await resolve({ sentLastHour: 500 })
    expect(wa.sendOutbound).not.toHaveBeenCalled()
  })

  it('still records the survey when the send is capped', async () => {
    // The row is the record and costs nobody anything; only the message is
    // capped. The survey stays reachable by URL.
    const { prisma } = await resolve({ sentLastHour: 500 })
    expect(prisma.csatSurvey.create).toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('counts only this account, and only the last hour', async () => {
    const { prisma } = await resolve({ sentLastHour: 1 })
    const where = prisma.csatSurvey.count.mock.calls[0][0].where
    expect(where.accountId).toBe('acc1')
    const since = where.promptedAt.gte as Date
    expect(Math.round((Date.now() - since.getTime()) / 60000)).toBe(60)
  })

  it('honours a configured cap', async () => {
    const under = await resolve({ sentLastHour: 4, cap: '5' })
    expect(under.wa.sendOutbound).toHaveBeenCalled()
    const over = await resolve({ sentLastHour: 6, cap: '5' })
    expect(over.wa.sendOutbound).not.toHaveBeenCalled()
  })

  it('sends at exactly the cap, and stops above it', async () => {
    const at = await resolve({ sentLastHour: 60 })
    expect(at.wa.sendOutbound).toHaveBeenCalled()
    const above = await resolve({ sentLastHour: 61 })
    expect(above.wa.sendOutbound).not.toHaveBeenCalled()
  })
})


describe('CsatService — non-WhatsApp delivery (F9)', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok-abc' })
  })

  const conv = (channel: string, contact: unknown) => ({
    id: 'cv1',
    accountId: 'acc1',
    inboxId: 'inb1',
    assigneeId: 'u1',
    inbox: { csatEnabled: true, channelType: channel },
    account: { defaultLocale: 'pt-BR' },
    contact,
  })

  it('EMAIL channel: sends the survey by email and mirrors the prompt', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('EMAIL', { email: 'x@y.com' }))
    const emails = makeEmails()
    const realtime = makeRealtime()
    await makeService(prisma, makeWhatsapp(), makeConfig(), emails, realtime)
      .maybeCreateForResolvedConversation('cv1')
    expect(emails.send).toHaveBeenCalledWith(
      'x@y.com',
      'Como foi o atendimento?',
      expect.stringContaining('/csat/tok-abc'),
    )
    expect(prisma.message.create).toHaveBeenCalled()
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageCreated', conversationId: 'cv1' }),
    )
  })

  it('EMAIL channel without a contact email: survey row exists, nothing sent', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('EMAIL', { email: null }))
    const emails = makeEmails()
    await makeService(prisma, makeWhatsapp(), makeConfig(), emails)
      .maybeCreateForResolvedConversation('cv1')
    expect(prisma.csatSurvey.create).toHaveBeenCalled()
    expect(emails.send).not.toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('WEB_WIDGET: the in-thread message IS the delivery, with a realtime event', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('WEB_WIDGET', null))
    const wa = makeWhatsapp()
    const emails = makeEmails()
    const realtime = makeRealtime()
    await makeService(prisma, wa, makeConfig(), emails, realtime)
      .maybeCreateForResolvedConversation('cv1')
    expect(wa.sendOutbound).not.toHaveBeenCalled()
    expect(emails.send).not.toHaveBeenCalled()
    const msg = prisma.message.create.mock.calls[0][0].data
    expect(msg.senderType).toBe('SYSTEM')
    expect(msg.content).toContain('/csat/tok-abc')
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageCreated', messageId: 'm1' }),
    )
  })

  it('a failed email send does not mirror a prompt that never went out', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('EMAIL', { email: 'x@y.com' }))
    const emails = makeEmails()
    emails.send.mockResolvedValue(false)
    await makeService(prisma, makeWhatsapp(), makeConfig(), emails)
      .maybeCreateForResolvedConversation('cv1')
    expect(prisma.message.create).not.toHaveBeenCalled()
  })
})


describe('CsatService — F9 delivery edge paths', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok-abc' })
  })

  const conv = (channel: string, contact: unknown, locale = 'pt-BR') => ({
    id: 'cv1',
    accountId: 'acc1',
    inboxId: 'inb1',
    assigneeId: 'u1',
    inbox: { csatEnabled: true, channelType: channel },
    account: { defaultLocale: locale },
    contact,
  })

  it('subjects the email in the account locale', async () => {
    for (const [locale, subject] of [
      ['es', '¿Cómo estuvo la atención?'],
      ['en', 'How did we do?'],
    ] as const) {
      prisma = makePrisma()
      prisma.csatSurvey.findUnique.mockResolvedValue(null)
      prisma.csatSurvey.count.mockResolvedValue(0)
      prisma.csatSurvey.create.mockResolvedValue({ id: 's1', token: 'tok-abc' })
      prisma.conversation.findUnique.mockResolvedValue(
        conv('EMAIL', { email: 'x@y.com' }, locale),
      )
      const emails = makeEmails()
      await makeService(prisma, makeWhatsapp(), makeConfig(), emails)
        .maybeCreateForResolvedConversation('cv1')
      expect(emails.send).toHaveBeenCalledWith('x@y.com', subject, expect.any(String))
    }
  })

  it('a throwing email provider leaves the survey reachable by URL', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('EMAIL', { email: 'x@y.com' }))
    const emails = makeEmails()
    emails.send.mockRejectedValue(new Error('resend down'))
    await expect(
      makeService(prisma, makeWhatsapp(), makeConfig(), emails)
        .maybeCreateForResolvedConversation('cv1'),
    ).resolves.toBeUndefined()
    // Row created, nothing mirrored — the prompt never went out.
    expect(prisma.csatSurvey.create).toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('a non-Error rejection from the provider is handled the same way', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv('EMAIL', { email: 'x@y.com' }))
    const emails = makeEmails()
    emails.send.mockRejectedValue('boom')
    await expect(
      makeService(prisma, makeWhatsapp(), makeConfig(), emails)
        .maybeCreateForResolvedConversation('cv1'),
    ).resolves.toBeUndefined()
    expect(prisma.message.create).not.toHaveBeenCalled()
  })
})

describe('CsatService NPS surveys (PoC item 14)', () => {
  const resolveOn = async (surveyType: 'CSAT' | 'NPS', defaultLocale = 'pt-BR') => {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue({
      id: 'cv1',
      accountId: 'acc1',
      inboxId: 'inb1',
      assigneeId: 'u1',
      teamId: 't1',
      inbox: { csatEnabled: true, channelType: 'WHATSAPP' },
      account: { defaultLocale, surveyType },
      contact: { phoneNumber: '+5511999999999' },
    })
    prisma.csatSurvey.findUnique.mockResolvedValue(null)
    prisma.csatSurvey.create.mockImplementation(async ({ data }: { data: { type: string } }) => ({
      id: 's1',
      token: 'tok',
      type: data.type,
    }))
    const wa = makeWhatsapp()
    await makeService(prisma, wa).maybeCreateForResolvedConversation('cv1')
    return { prisma, text: (wa.sendOutbound as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string }
  }

  it('snapshots the account survey type and the conversation team on the row', async () => {
    const { prisma } = await resolveOn('NPS')
    expect(prisma.csatSurvey.create.mock.calls[0]![0].data).toMatchObject({
      type: 'NPS',
      teamId: 't1',
      assignedAgentId: 'u1',
    })
  })

  it('asks the 0 to 10 recommendation question for NPS, in the account language', async () => {
    expect((await resolveOn('NPS')).text).toContain('De 0 a 10, quanto você recomendaria')
    expect((await resolveOn('NPS', 'es')).text).toContain('Del 0 al 10')
    expect((await resolveOn('NPS', 'en')).text).toContain('From 0 to 10')
    expect((await resolveOn('CSAT')).text).toContain('Como foi o atendimento?')
  })

  const submit = async (type: 'CSAT' | 'NPS', rating: number) => {
    const prisma = makePrisma()
    prisma.csatSurvey.findUnique.mockResolvedValue({ id: 's1', type, respondedAt: null, expiresAt: null })
    prisma.csatSurvey.update.mockResolvedValue({ id: 's1' })
    return makeService(prisma).submitByToken('tok', { rating })
  }

  it('accepts 0 and 10 on an NPS survey', async () => {
    await expect(submit('NPS', 0)).resolves.toBeDefined()
    await expect(submit('NPS', 10)).resolves.toBeDefined()
  })

  it('keeps CSAT at 1 to 5', async () => {
    await expect(submit('CSAT', 0)).rejects.toBeInstanceOf(BadRequestException)
    await expect(submit('CSAT', 6)).rejects.toBeInstanceOf(BadRequestException)
    await expect(submit('CSAT', 5)).resolves.toBeDefined()
  })

  it('keeps NPS rows out of the CSAT averages', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue({ isActive: true, role: 'AGENT' })
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await makeService(prisma).stats('u1', 'acc1', {})
    expect(prisma.csatSurvey.count.mock.calls[0]![0].where).toMatchObject({ accountId: 'acc1', type: 'CSAT' })
  })
})
