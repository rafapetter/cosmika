// Unit tests for ReportsService. Prisma is mocked; raw-SQL templates are
// captured by stubbing $queryRaw so we can inspect the generated query.
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReportsService } from './reports.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    conversation: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    message: { groupBy: vi.fn() },
    aiAgentSession: { aggregate: vi.fn() },
    // $queryRaw is a tagged-template function — we treat it as a vi.fn and
    // assert via call args.
    $queryRaw: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(p: Prisma) {
  return new ReportsService(p as never)
}

const ADMIN = {
  id: 'm1',
  userId: 'u1',
  accountId: 'acc1',
  role: 'ADMINISTRATOR',
  isActive: true,
}
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── auth ────────────────────────────────────────────────────────

describe('ReportsService — authorization', () => {
  it('overview: 403 when no membership', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).overview('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('overview: 403 when membership inactive', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    await expect(makeService(p).overview('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('overview: 403 when role is AGENT', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(p).overview('u1', 'acc1', {} as never)).rejects.toThrow(
      /Administrator or Supervisor/,
    )
  })

  it('overview: SUPERVISOR passes auth', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(SUPER)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValue([])
    p.conversation.findMany.mockResolvedValue([])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
    await makeService(p).overview('u1', 'acc1', {} as never)
    expect(p.conversation.count).toHaveBeenCalled()
  })
})

// ─── resolveRange (via overview) ─────────────────────────────────

describe('ReportsService — resolveRange', () => {
  function mockHappyPath(p: Prisma) {
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValue([])
    p.conversation.findMany.mockResolvedValue([])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
  }

  it('defaults to a 30-day window when from/to not supplied', async () => {
    const p = makePrisma()
    mockHappyPath(p)
    const r = await makeService(p).overview('u1', 'acc1', {} as never)
    const from = new Date(`${r.from}T00:00:00Z`)
    const to = new Date(`${r.to}T00:00:00Z`)
    const days =
      (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    expect(days).toBeGreaterThanOrEqual(28)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('accepts explicit from/to within range', async () => {
    const p = makePrisma()
    mockHappyPath(p)
    const r = await makeService(p).overview('u1', 'acc1', {
      from: '2026-01-01',
      to: '2026-01-31',
    } as never)
    expect(r.from).toBe('2026-01-01')
    expect(r.to).toBe('2026-01-31')
  })

  it('400 when from > to', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    await expect(
      makeService(p).overview('u1', 'acc1', {
        from: '2026-02-01',
        to: '2026-01-01',
      } as never),
    ).rejects.toThrow(/Invalid date range/)
  })

  it('400 when from is unparseable', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    await expect(
      makeService(p).overview('u1', 'acc1', { from: 'not-a-date' } as never),
    ).rejects.toThrow(/Invalid date range/)
  })

  it('400 when to is unparseable', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    await expect(
      makeService(p).overview('u1', 'acc1', {
        from: '2026-01-01',
        to: 'garbage',
      } as never),
    ).rejects.toThrow(/Invalid date range/)
  })

  it('allows a multi-year "all time" range under the cap', async () => {
    const p = makePrisma()
    mockHappyPath(p)
    // ~11 years — the "All time" default. Must NOT throw.
    await expect(
      makeService(p).overview('u1', 'acc1', {
        from: '2015-01-01',
        to: '2026-01-01',
      } as never),
    ).resolves.toBeDefined()
  })

  it('400 when range exceeds the max (years beyond the cap)', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    await expect(
      makeService(p).overview('u1', 'acc1', {
        from: '2005-01-01',
        to: '2026-01-01',
      } as never),
    ).rejects.toThrow(/Range too large/)
  })
})

// ─── overview ─────────────────────────────────────────────────────

describe('ReportsService.overview', () => {
  it('aggregates status, sentiment, durations, top tags, AI usage, messages', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(42)
    p.conversation.groupBy
      .mockResolvedValueOnce([
        // status groups
        { status: 'OPEN', _count: { _all: 10 } },
        { status: 'PENDING', _count: { _all: 4 } },
        { status: 'RESOLVED', _count: { _all: 25 } },
        { status: 'BOGUS', _count: { _all: 99 } }, // ignored — unknown status
      ])
      .mockResolvedValueOnce([
        // sentiment groups
        { aiSentiment: 'POSITIVE', _count: { _all: 8 } },
        { aiSentiment: 'NEUTRAL', _count: { _all: 12 } },
        { aiSentiment: 'NEGATIVE', _count: { _all: 5 } },
        { aiSentiment: null, _count: { _all: 17 } }, // unknown bucket
      ])
    p.conversation.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-04-01T00:00:00Z'),
        firstReplyAt: new Date('2026-04-01T00:00:30Z'),
        resolvedAt: new Date('2026-04-01T00:05:00Z'),
        aiTags: ['billing', 'refund'],
      },
      {
        createdAt: new Date('2026-04-02T00:00:00Z'),
        firstReplyAt: new Date('2026-04-02T00:01:00Z'),
        resolvedAt: null,
        aiTags: ['billing'],
      },
      {
        createdAt: new Date('2026-04-03T00:00:00Z'),
        firstReplyAt: null,
        resolvedAt: null,
        aiTags: null, // exercises the `?? []` nullish fallback
      },
    ])
    p.message.groupBy.mockResolvedValue([
      { senderType: 'CONTACT', _count: { _all: 100 } },
      { senderType: 'USER', _count: { _all: 50 } },
      { senderType: 'AGENT_BOT', _count: { _all: 5 } },
      { senderType: 'SYSTEM', _count: { _all: 2 } },
    ])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: {
        totalCostUsd: '12.345',
        totalTokensIn: 1000,
        totalTokensOut: 500,
      },
      _count: { _all: 7 },
    })

    const r = await makeService(p).overview('u1', 'acc1', {
      from: '2026-04-01',
      to: '2026-04-10',
    } as never)

    expect(r.totalConversations).toBe(42)
    expect(r.statusCounts).toEqual({ open: 10, pending: 4, resolved: 25 })
    expect(r.sentimentBreakdown).toEqual({
      positive: 8,
      neutral: 12,
      negative: 5,
      unknown: 17,
    })
    expect(r.avgFirstResponseSeconds).toBe(45) // (30 + 60) / 2
    expect(r.medianFirstResponseSeconds).toBe(45)
    expect(r.avgResolutionSeconds).toBe(300) // single non-null entry: 5 min
    expect(r.topTags).toEqual([
      { tag: 'billing', count: 2 },
      { tag: 'refund', count: 1 },
    ])
    expect(r.ai).toEqual({
      totalCostUsd: 12.345,
      totalTokensIn: 1000,
      totalTokensOut: 500,
      sessions: 7,
    })
    expect(r.messagesBySender).toEqual({
      CONTACT: 100,
      USER: 50,
      AGENT_BOT: 5,
      SYSTEM: 2,
    })
  })

  it('falls back to zeros when AI sums are null and tags absent', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    p.conversation.findMany.mockResolvedValue([])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
    const r = await makeService(p).overview('u1', 'acc1', {} as never)
    expect(r.ai).toEqual({
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      sessions: 0,
    })
    expect(r.avgFirstResponseSeconds).toBeNull()
    expect(r.medianFirstResponseSeconds).toBeNull()
    expect(r.avgResolutionSeconds).toBeNull()
    expect(r.topTags).toEqual([])
  })

  it('clamps negative durations to zero (clock skew)', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    p.conversation.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-04-02T00:00:00Z'),
        firstReplyAt: new Date('2026-04-01T00:00:00Z'), // before createdAt
        resolvedAt: new Date('2026-04-01T00:00:00Z'),
        aiTags: [],
      },
    ])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
    const r = await makeService(p).overview('u1', 'acc1', {} as never)
    expect(r.avgFirstResponseSeconds).toBe(0)
    expect(r.avgResolutionSeconds).toBe(0)
  })

  it('applies inboxId/teamId/assigneeId filters to where clause', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValue([])
    p.conversation.findMany.mockResolvedValue([])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
    await makeService(p).overview('u1', 'acc1', {
      inboxId: 'inb1',
      teamId: 'team1',
      assigneeId: 'usr1',
    } as never)
    const w = p.conversation.count.mock.calls[0]![0].where
    expect(w.inboxId).toBe('inb1')
    expect(w.teamId).toBe('team1')
    expect(w.assigneeId).toBe('usr1')
    const mw = p.message.groupBy.mock.calls[0]![0].where
    expect(mw.inboxId).toBe('inb1')
  })

  it('returns odd-count median correctly', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.conversation.count.mockResolvedValue(0)
    p.conversation.groupBy.mockResolvedValue([])
    p.conversation.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-04-01T00:00:00Z'),
        firstReplyAt: new Date('2026-04-01T00:00:10Z'),
        resolvedAt: null,
        aiTags: [],
      },
      {
        createdAt: new Date('2026-04-01T00:00:00Z'),
        firstReplyAt: new Date('2026-04-01T00:00:30Z'),
        resolvedAt: null,
        aiTags: [],
      },
      {
        createdAt: new Date('2026-04-01T00:00:00Z'),
        firstReplyAt: new Date('2026-04-01T00:01:00Z'),
        resolvedAt: null,
        aiTags: [],
      },
    ])
    p.message.groupBy.mockResolvedValue([])
    p.aiAgentSession.aggregate.mockResolvedValue({
      _sum: { totalCostUsd: null, totalTokensIn: null, totalTokensOut: null },
      _count: { _all: 0 },
    })
    const r = await makeService(p).overview('u1', 'acc1', {} as never)
    // Median of [10, 30, 60] = 30
    expect(r.medianFirstResponseSeconds).toBe(30)
  })
})

// ─── timeseries ──────────────────────────────────────────────────

describe('ReportsService.timeseries', () => {
  function authedPrisma() {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    return p
  }

  it('conversations metric returns mapped bucket points', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([
      { bucket: new Date('2026-04-01T00:00:00Z'), value: BigInt(7) },
      { bucket: new Date('2026-04-02T00:00:00Z'), value: BigInt(3) },
    ])
    const r = await makeService(p).timeseries('u1', 'acc1', {
      metric: 'conversations',
      bucket: 'day',
      from: '2026-04-01',
      to: '2026-04-30',
    } as never)
    expect(r.metric).toBe('conversations')
    expect(r.bucket).toBe('day')
    expect(r.points).toEqual([
      { bucket: '2026-04-01', value: 7 },
      { bucket: '2026-04-02', value: 3 },
    ])
  })

  it('conversations metric with week bucket + inbox/team/assignee filters', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([])
    await makeService(p).timeseries('u1', 'acc1', {
      metric: 'conversations',
      bucket: 'week',
      inboxId: 'inb1',
      teamId: 'team1',
      assigneeId: 'usr1',
    } as never)
    expect(p.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('messages metric returns mapped bucket points', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([
      { bucket: new Date('2026-04-01T00:00:00Z'), value: BigInt(100) },
    ])
    const r = await makeService(p).timeseries('u1', 'acc1', {
      metric: 'messages',
      bucket: 'day',
      inboxId: 'inb1',
    } as never)
    expect(r.points).toEqual([{ bucket: '2026-04-01', value: 100 }])
  })

  it('messages metric without inbox filter still works', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([])
    await makeService(p).timeseries('u1', 'acc1', {
      metric: 'messages',
      bucket: 'day',
    } as never)
    expect(p.$queryRaw).toHaveBeenCalled()
  })

  it('first_response_avg: maps non-null bucket values, treats null as 0', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([
      { bucket: new Date('2026-04-01T00:00:00Z'), value: 42.5 },
      { bucket: new Date('2026-04-02T00:00:00Z'), value: null }, // → 0
    ])
    const r = await makeService(p).timeseries('u1', 'acc1', {
      metric: 'first_response_avg',
      bucket: 'day',
    } as never)
    expect(r.points).toEqual([
      { bucket: '2026-04-01', value: 42.5 },
      { bucket: '2026-04-02', value: 0 },
    ])
  })

  it('first_response_avg with inbox/team/assignee filters runs query', async () => {
    const p = authedPrisma()
    p.$queryRaw.mockResolvedValue([])
    await makeService(p).timeseries('u1', 'acc1', {
      metric: 'first_response_avg',
      bucket: 'week',
      inboxId: 'inb1',
      teamId: 'team1',
      assigneeId: 'usr1',
    } as never)
    expect(p.$queryRaw).toHaveBeenCalled()
  })

  it('403 when non-privileged', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(p).timeseries('u1', 'acc1', {
        metric: 'conversations',
        bucket: 'day',
      } as never),
    ).rejects.toThrow(ForbiddenException)
  })
})

// ─── leaderboard ─────────────────────────────────────────────────

describe('ReportsService.leaderboard', () => {
  it('maps rows into LeaderboardEntry list', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([
      {
        userId: 'u1',
        email: 'a@e.com',
        fullName: 'Agent One',
        resolvedCount: BigInt(15),
        avgFirstResponseSeconds: 35.5,
      },
      {
        userId: 'u2',
        email: 'b@e.com',
        fullName: null,
        resolvedCount: BigInt(7),
        avgFirstResponseSeconds: null,
      },
    ])
    const r = await makeService(p).leaderboard('u1', 'acc1', {} as never)
    expect(r.entries).toEqual([
      {
        userId: 'u1',
        userEmail: 'a@e.com',
        userFullName: 'Agent One',
        resolvedCount: 15,
        avgFirstResponseSeconds: 35.5,
      },
      {
        userId: 'u2',
        userEmail: 'b@e.com',
        userFullName: null,
        resolvedCount: 7,
        avgFirstResponseSeconds: null,
      },
    ])
  })

  it('uses supplied date range', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([])
    const r = await makeService(p).leaderboard('u1', 'acc1', {
      from: '2026-04-01',
      to: '2026-04-30',
    } as never)
    expect(r.from).toBe('2026-04-01')
    expect(r.to).toBe('2026-04-30')
  })

  it('403 when non-privileged', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(p).leaderboard('u1', 'acc1', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })
})

// ─── breakdown ───────────────────────────────────────────────────

describe('ReportsService.breakdown', () => {
  const ROW = {
    id: 'inb1',
    label: 'Suporte',
    total: BigInt(10),
    open: BigInt(3),
    pending: BigInt(2),
    resolved: BigInt(5),
    avgFirstResponseSeconds: 42.5,
    avgResolutionSeconds: 3600,
  }

  it('inbox dimension: maps bigints to numbers + keeps durations', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([ROW])
    const r = await makeService(p).breakdown('u1', 'acc1', {
      dimension: 'inbox',
    } as never)
    expect(r.dimension).toBe('inbox')
    expect(r.rows).toEqual([
      {
        id: 'inb1',
        label: 'Suporte',
        total: 10,
        open: 3,
        pending: 2,
        resolved: 5,
        avgFirstResponseSeconds: 42.5,
        avgResolutionSeconds: 3600,
      },
    ])
  })

  it('team dimension: null id + null durations pass through', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(SUPER)
    p.$queryRaw.mockResolvedValue([
      {
        id: null,
        label: 'Unassigned',
        total: BigInt(4),
        open: BigInt(4),
        pending: BigInt(0),
        resolved: BigInt(0),
        avgFirstResponseSeconds: null,
        avgResolutionSeconds: null,
      },
    ])
    const r = await makeService(p).breakdown('u1', 'acc1', {
      dimension: 'team',
    } as never)
    expect(r.rows[0]).toMatchObject({
      id: null,
      label: 'Unassigned',
      avgFirstResponseSeconds: null,
      avgResolutionSeconds: null,
    })
  })

  it('agent dimension: runs the assignee-joined query', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([])
    const r = await makeService(p).breakdown('u1', 'acc1', {
      dimension: 'agent',
    } as never)
    expect(r.rows).toEqual([])
    expect(p.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('403 when non-privileged', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(p).breakdown('u1', 'acc1', { dimension: 'inbox' } as never),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('ReportsService.breakdownCsv', () => {
  it('renders header + rows, rounds durations, quotes labels with commas', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([
      {
        id: 'inb1',
        label: 'Suporte, BR',
        total: BigInt(10),
        open: BigInt(3),
        pending: BigInt(2),
        resolved: BigInt(5),
        avgFirstResponseSeconds: 42.4,
        avgResolutionSeconds: null,
      },
    ])
    const csv = await makeService(p).breakdownCsv('u1', 'acc1', {
      dimension: 'inbox',
    } as never)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(
      'inbox,total,open,pending,resolved,avg_first_response_seconds,avg_resolution_seconds',
    )
    // label quoted (has a comma); 42.4 rounded to 42; null resolution → empty.
    expect(lines[1]).toBe('"Suporte, BR",10,3,2,5,42,')
  })

  it('escapes embedded double-quotes', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.$queryRaw.mockResolvedValue([
      {
        id: 'inb1',
        label: 'A "B" C',
        total: BigInt(1),
        open: BigInt(1),
        pending: BigInt(0),
        resolved: BigInt(0),
        avgFirstResponseSeconds: null,
        avgResolutionSeconds: 10,
      },
    ])
    const csv = await makeService(p).breakdownCsv('u1', 'acc1', {
      dimension: 'inbox',
    } as never)
    expect(csv.split('\r\n')[1]).toBe('"A ""B"" C",1,1,0,0,,10')
  })
})
