import { ForbiddenException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchService } from './search.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    account: { findUnique: vi.fn().mockResolvedValue({ teamScopedVisibility: false }) },
    contact: { findMany: vi.fn().mockResolvedValue([]) },
    article: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): SearchService {
  return new SearchService(prisma as never)
}

const ACTIVE_MEMBER = { id: 'm1', userId: 'u1', accountId: 'acc1', isActive: true, role: 'AGENT' }

describe('SearchService.global — input validation + auth', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns [] for empty query without hitting the DB', async () => {
    const out = await makeService(prisma).global('u1', 'acc1', '')
    expect(out).toEqual([])
    expect(prisma.accountMember.findUnique).not.toHaveBeenCalled()
  })

  it('returns [] for 1-char query (under threshold)', async () => {
    expect(await makeService(prisma).global('u1', 'acc1', 'a')).toEqual([])
  })

  it('returns [] when whitespace-only query trims to nothing', async () => {
    expect(await makeService(prisma).global('u1', 'acc1', '   ')).toEqual([])
  })

  it('403s when actor is not a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).global('u1', 'acc1', 'query'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('403s when actor membership is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      ...ACTIVE_MEMBER,
      isActive: false,
    })
    await expect(
      makeService(prisma).global('u1', 'acc1', 'query'),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('SearchService.global — result mapping', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
  })

  it('maps contacts to SearchHit shape', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c1', name: 'Alice', email: 'a@b.com', phoneNumber: '+5511' },
      { id: 'c2', name: null, email: 'no-name@b.com', phoneNumber: null },
      { id: 'c3', name: null, email: null, phoneNumber: '+5522' },
      { id: 'c4', name: null, email: null, phoneNumber: null },
    ])
    const out = await makeService(prisma).global('u1', 'acc1', 'Al')
    expect(out).toEqual([
      { kind: 'contact', id: 'c1', title: 'Alice', subtitle: 'a@b.com' },
      { kind: 'contact', id: 'c2', title: 'no-name@b.com', subtitle: 'no-name@b.com' },
      { kind: 'contact', id: 'c3', title: '+5522', subtitle: '+5522' },
      { kind: 'contact', id: 'c4', title: '—', subtitle: null },
    ])
  })

  it('maps conversations including the first matching message snippet', async () => {
    prisma.conversation.findMany.mockResolvedValue([
      {
        id: 'cv1',
        displayId: 42,
        status: 'OPEN',
        contact: { name: 'Bob', email: 'b@c.com', phoneNumber: null },
        messages: [{ content: 'Hello world, this is a long message that should get clipped to 120 chars to keep the popover tidy and not blow out' }],
      },
      {
        id: 'cv2',
        displayId: 43,
        status: 'OPEN',
        contact: { name: null, email: 'no@name.com', phoneNumber: null },
        messages: [{ content: 'short hit' }],
      },
      {
        id: 'cv3',
        displayId: 44,
        status: 'OPEN',
        contact: null,
        messages: [{ content: 'orphan' }],
      },
      {
        id: 'cv4',
        displayId: 45,
        status: 'OPEN',
        contact: { name: 'Carol' },
        messages: [], // no matching message — snippet falls back to null
      },
      {
        id: 'cv5',
        displayId: 46,
        status: 'OPEN',
        // contact with no name and no email — falls all the way through to phoneNumber
        contact: { name: null, email: null, phoneNumber: '+5511999' },
        messages: [{ content: 'hi' }],
      },
    ])
    const out = await makeService(prisma).global('u1', 'acc1', 'qry')
    expect(out[0]).toEqual({
      kind: 'conversation',
      id: 'cv1',
      title: '#42 · Bob',
      subtitle: expect.stringMatching(/^Hello world, .{1,118}$/),
    })
    expect((out[0] as { subtitle: string }).subtitle.length).toBeLessThanOrEqual(120)
    expect(out[1]?.title).toBe('#43 · no@name.com')
    expect(out[2]?.title).toBe('#44 · no contact')
    expect(out[3]?.subtitle).toBeNull()
  })

  it('maps articles with title + 120-char content snippet', async () => {
    prisma.article.findMany.mockResolvedValue([
      {
        id: 'art1',
        slug: 'refunds',
        title: 'Refund policy',
        content: 'Long content that goes beyond 120 chars '.repeat(10),
      },
    ])
    const out = await makeService(prisma).global('u1', 'acc1', 'refund')
    expect(out[0]).toEqual({
      kind: 'article',
      id: 'art1',
      title: 'Refund policy',
      subtitle: expect.any(String),
    })
    expect((out[0] as { subtitle: string }).subtitle.length).toBe(120)
  })

  it('returns hits in order: contacts → conversations → articles', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 'c1', name: 'X', email: null, phoneNumber: null }])
    prisma.conversation.findMany.mockResolvedValue([
      { id: 'cv1', displayId: 1, status: 'OPEN', contact: { name: 'Y' }, messages: [{ content: 'h' }] },
    ])
    prisma.article.findMany.mockResolvedValue([{ id: 'art1', slug: 's', title: 'T', content: 'C' }])
    const out = await makeService(prisma).global('u1', 'acc1', 'qq')
    expect(out.map((h) => h.kind)).toEqual(['contact', 'conversation', 'article'])
  })

  it('caps each source at 5 (passes take:5 to each findMany)', async () => {
    await makeService(prisma).global('u1', 'acc1', 'query')
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    )
  })

  it('only searches PUBLISHED articles (drafts excluded)', async () => {
    await makeService(prisma).global('u1', 'acc1', 'query')
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    )
  })

  it('uses case-insensitive contains filter on all sources', async () => {
    await makeService(prisma).global('u1', 'acc1', 'MixedCase')
    const contactArgs = prisma.contact.findMany.mock.calls[0]![0]
    expect(contactArgs.where.OR[0]).toEqual({
      name: { contains: 'MixedCase', mode: 'insensitive' },
    })
  })

  it('trims the query before searching (matches the trimmed form)', async () => {
    await makeService(prisma).global('u1', 'acc1', '  spaced  ')
    const contactArgs = prisma.contact.findMany.mock.calls[0]![0]
    expect(contactArgs.where.OR[0].name.contains).toBe('spaced')
  })
})


describe('SearchService.global — conversation visibility', () => {
  it('only finds conversations the member could open', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    await makeService(prisma).global('u1', 'acc1', 'boleto')
    const where = prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.accountId).toBe('acc1')
    expect(where.OR).toContainEqual({ assigneeId: 'u1' })
    expect(where.OR).toContainEqual({ inbox: { members: { some: { userId: 'u1' } } } })
  })

  it('narrows to the member\'s teams when the account scopes by team, and lets supervisors see all', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ACTIVE_MEMBER)
    prisma.account.findUnique.mockResolvedValue({ teamScopedVisibility: true })
    await makeService(prisma).global('u1', 'acc1', 'boleto')
    expect(JSON.stringify(prisma.conversation.findMany.mock.calls[0]![0].where)).toContain('"teamId":null')

    prisma.accountMember.findUnique.mockResolvedValue({ ...ACTIVE_MEMBER, role: 'SUPERVISOR' })
    prisma.account.findUnique.mockResolvedValue(null)
    await makeService(prisma).global('u1', 'acc1', 'boleto')
    expect(prisma.conversation.findMany.mock.calls[1]![0].where).toEqual({
      accountId: 'acc1',
      messages: { some: { content: { contains: 'boleto', mode: 'insensitive' } } },
    })
  })
})
