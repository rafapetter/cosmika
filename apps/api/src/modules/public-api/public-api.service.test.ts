import { NotFoundException } from '@nestjs/common'
import { PublicContactsQuery, PublicConversationsQuery, PublicMessagesQuery } from '@cosmika/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicApiService } from './public-api.service'

const d = (s: string) => new Date(s)

function conversationRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    displayId: 10,
    accountId: 'acc1',
    status: 'OPEN',
    priority: 'NORMAL',
    inbox: { id: 'in1', name: 'WhatsApp', channelType: 'WHATSAPP' },
    contact: { id: 'ct1', name: 'Ana', email: null, phoneNumber: '+5511999990000' },
    assignee: null,
    team: null,
    lastMessageAt: null,
    resolvedAt: null,
    createdAt: d('2026-10-10T12:00:00Z'),
    updatedAt: d('2026-10-10T12:30:00Z'),
    ...extra,
  }
}

function makePrisma() {
  return {
    conversation: { findMany: vi.fn(), findUnique: vi.fn() },
    message: { findMany: vi.fn() },
    contact: { findMany: vi.fn(), findUnique: vi.fn() },
  }
}

describe('PublicApiService', () => {
  let prisma: ReturnType<typeof makePrisma>
  let svc: PublicApiService
  beforeEach(() => {
    prisma = makePrisma()
    svc = new PublicApiService(prisma as never)
  })

  describe('listConversations', () => {
    it('scopes by account, applies status/inbox/period and paginates with limit+1', async () => {
      prisma.conversation.findMany.mockResolvedValue([conversationRow('c1'), conversationRow('c2'), conversationRow('c3')])
      const q = PublicConversationsQuery.parse({
        status: 'RESOLVED',
        inboxId: 'in1',
        from: '2026-10-01T00:00:00-03:00',
        to: '2026-11-01T00:00:00-03:00',
        limit: '2',
      })
      const out = await svc.listConversations('acc1', q)
      const args = prisma.conversation.findMany.mock.calls[0]![0]
      expect(args.where).toEqual({
        accountId: 'acc1',
        status: 'RESOLVED',
        inboxId: 'in1',
        createdAt: { gte: d('2026-10-01T03:00:00Z'), lt: d('2026-11-01T03:00:00Z') },
      })
      expect(args.take).toBe(3)
      expect(out.data.map((c) => c.id)).toEqual(['c1', 'c2'])
      expect(out.nextCursor).toBe('c2')
      expect(out.data[0]).toMatchObject({
        displayId: 10,
        inbox: { channelType: 'WHATSAPP' },
        createdAt: '2026-10-10T12:00:00.000Z',
        resolvedAt: null,
      })
    })

    it('continues from a cursor and reports the last page', async () => {
      prisma.conversation.findMany.mockResolvedValue([conversationRow('c3')])
      const out = await svc.listConversations('acc1', PublicConversationsQuery.parse({ cursor: 'c2' }))
      expect(prisma.conversation.findMany.mock.calls[0]![0]).toMatchObject({
        where: { accountId: 'acc1' },
        cursor: { id: 'c2' },
        skip: 1,
        take: 26,
      })
      expect(out.nextCursor).toBeNull()
    })
  })

  describe('listMessages', () => {
    const msg = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      conversationId: 'c1',
      senderType: 'CONTACT',
      senderUser: null,
      content: 'oi',
      contentType: 'TEXT',
      status: 'SENT',
      isPrivate: false,
      attachments: [],
      createdAt: d('2026-10-10T12:00:00Z'),
      ...extra,
    })

    it('finds the conversation by displayId, hides private notes by default and names senders', async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1', contactId: 'ct1' })
      prisma.contact.findUnique.mockResolvedValue({ id: 'ct1', name: 'Ana' })
      prisma.message.findMany.mockResolvedValue([
        msg('m1'),
        msg('m2', { senderType: 'USER', senderUser: { id: 'u1', fullName: 'Bruno' } }),
        msg('m3', { senderType: 'AGENT_BOT' }),
      ])
      const out = await svc.listMessages('acc1', '42', PublicMessagesQuery.parse({}))
      expect(prisma.conversation.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { accountId_displayId: { accountId: 'acc1', displayId: 42 } } }),
      )
      expect(prisma.message.findMany.mock.calls[0]![0].where).toEqual({ conversationId: 'c1', isPrivate: false })
      expect(out.data.map((m) => m.sender)).toEqual([
        { id: 'ct1', name: 'Ana' },
        { id: 'u1', name: 'Bruno' },
        null,
      ])
    })

    it('includes private notes on request, looking the conversation up by id', async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'cabc', accountId: 'acc1', contactId: 'ct1' })
      prisma.contact.findUnique.mockResolvedValue(null)
      prisma.message.findMany.mockResolvedValue([])
      await svc.listMessages('acc1', 'cabc', PublicMessagesQuery.parse({ includePrivate: 'true' }))
      expect(prisma.conversation.findUnique.mock.calls[0]![0].where).toEqual({ id: 'cabc' })
      expect(prisma.message.findMany.mock.calls[0]![0].where).toEqual({ conversationId: 'cabc' })
    })

    it('404s a conversation from another account', async () => {
      prisma.conversation.findUnique.mockResolvedValue({ id: 'c1', accountId: 'other', contactId: 'ct1' })
      await expect(svc.listMessages('acc1', 'c1', PublicMessagesQuery.parse({}))).rejects.toBeInstanceOf(
        NotFoundException,
      )
      expect(prisma.message.findMany).not.toHaveBeenCalled()
    })
  })

  describe('listContacts', () => {
    it('searches the identifying fields and normalises customAttributes', async () => {
      prisma.contact.findMany.mockResolvedValue([
        {
          id: 'ct1',
          name: 'Ana',
          email: 'ana@x.com',
          phoneNumber: null,
          identifier: null,
          customAttributes: ['not', 'an', 'object'],
          createdAt: d('2026-10-01T00:00:00Z'),
          updatedAt: d('2026-10-02T00:00:00Z'),
        },
      ])
      const out = await svc.listContacts('acc1', PublicContactsQuery.parse({ q: ' ana ' }))
      const where = prisma.contact.findMany.mock.calls[0]![0].where
      expect(where.accountId).toBe('acc1')
      expect(where.OR).toHaveLength(4)
      expect(where.OR[0]).toEqual({ name: { contains: 'ana', mode: 'insensitive' } })
      expect(out.data[0]!.customAttributes).toEqual({})
      expect(out.nextCursor).toBeNull()
    })
  })
})

describe('public query schemas', () => {
  it('reject an inverted period and an oversized page', () => {
    expect(
      PublicConversationsQuery.safeParse({ from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success,
    ).toBe(false)
    expect(PublicContactsQuery.safeParse({ limit: '500' }).success).toBe(false)
    expect(PublicConversationsQuery.safeParse({ status: 'CLOSED' }).success).toBe(false)
  })
})
