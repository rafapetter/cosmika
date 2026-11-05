import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AiUsageService, providerFor } from './ai-usage.service'

function makePrisma() {
  return {
    aiUsageEvent: {
      create: vi.fn().mockResolvedValue({ id: 'ev1' }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsd: null } }),
    },
    aiAgentSession: { upsert: vi.fn().mockResolvedValue({}) },
    account: { findUnique: vi.fn().mockResolvedValue(null) },
  }
}

type Prisma = ReturnType<typeof makePrisma>

const svc = (p: Prisma) => new AiUsageService(p as never)

const USAGE = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: 100,
}

describe('providerFor', () => {
  it('names the provider that will actually bill us', () => {
    expect(providerFor('claude-sonnet-5')).toBe('anthropic')
    expect(providerFor('gpt-5.6-luna')).toBe('openai')
    expect(providerFor('deepseek/deepseek-v4.1-flash')).toBe('openrouter')
  })
})

describe('AiUsageService.record', () => {
  let p: Prisma

  beforeEach(() => {
    p = makePrisma()
  })

  it('writes one ledger row with the cost at the model price of the day', async () => {
    const cost = await svc(p).record({
      accountId: 'acc1',
      conversationId: 'cv1',
      agentBotId: 'bot1',
      source: 'AGENT_BOT',
      model: 'claude-sonnet-5',
      usage: USAGE,
      replied: true,
    })
    // Sonnet 5: $2/M in, $10/M out, $0.20/M cache read, $2.50/M cache write.
    expect(cost).toBeCloseTo(0.00729, 6)
    expect(p.aiUsageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'acc1',
        conversationId: 'cv1',
        agentBotId: 'bot1',
        source: 'AGENT_BOT',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        replied: true,
        ownKey: false,
      }),
    })
  })

  it('folds the same call into the conversation session aggregate', async () => {
    await svc(p).record({
      accountId: 'acc1',
      conversationId: 'cv1',
      source: 'FLOW_BLOCK',
      model: 'claude-haiku-4-5',
      usage: USAGE,
      replied: true,
    })
    const args = p.aiAgentSession.upsert.mock.calls[0]![0]
    expect(args.where).toEqual({ conversationId: 'cv1' })
    // Cache tokens are input tokens as far as the session counter goes.
    expect(args.create.totalTokensIn).toBe(1_300)
    expect(args.create.totalTokensOut).toBe(500)
    // A flow block has no bot behind it; the row still carries the account,
    // which is what the monthly guard reads.
    expect(args.create.agentBotId).toBeNull()
    expect(args.update.totalTokensIn).toEqual({ increment: 1_300 })
  })

  it('does not touch a session when the call belongs to no conversation', async () => {
    await svc(p).record({
      accountId: 'acc1',
      source: 'ADMIN_AGENT',
      model: 'claude-sonnet-5',
      usage: USAGE,
      replied: false,
    })
    expect(p.aiAgentSession.upsert).not.toHaveBeenCalled()
    expect(p.aiUsageEvent.create.mock.calls[0]![0].data.conversationId).toBeNull()
  })

  it('carries metadata when given, and omits the column when not', async () => {
    await svc(p).record({
      accountId: 'acc1',
      source: 'FLOW_DEVIATION',
      model: 'claude-haiku-4-5',
      usage: USAGE,
      replied: true,
      metadata: { wouldBlock: true },
    })
    expect(p.aiUsageEvent.create.mock.calls[0]![0].data.metadata).toEqual({
      wouldBlock: true,
    })
    await svc(p).record({
      accountId: 'acc1',
      source: 'FLOW_DEVIATION',
      model: 'claude-haiku-4-5',
      usage: USAGE,
      replied: true,
    })
    expect(p.aiUsageEvent.create.mock.calls[1]![0].data).not.toHaveProperty('metadata')
  })

  it('records an own-key call as such, so the allowance never counts it', async () => {
    await svc(p).record({
      accountId: 'acc1',
      conversationId: 'cv1',
      source: 'AGENT_BOT',
      model: 'claude-sonnet-5',
      usage: USAGE,
      replied: true,
      ownKey: true,
    })
    expect(p.aiUsageEvent.create.mock.calls[0]![0].data.ownKey).toBe(true)
  })

  it('never throws: a failed ledger write must not cost the customer an answer', async () => {
    p.aiUsageEvent.create.mockRejectedValue(new Error('db down'))
    await expect(
      svc(p).record({
        accountId: 'acc1',
        conversationId: 'cv1',
        source: 'AGENT_BOT',
        model: 'claude-sonnet-5',
        usage: USAGE,
        replied: true,
      }),
    ).resolves.toBeGreaterThan(0)
    // The cost is still returned, so a caller that wanted the number gets it.
  })

  it('swallows a non-Error throw too', async () => {
    p.aiUsageEvent.create.mockRejectedValue('a string')
    await expect(
      svc(p).record({
        accountId: 'acc1',
        source: 'ADMIN_AGENT',
        model: 'claude-sonnet-5',
        usage: USAGE,
        replied: false,
      }),
    ).resolves.toBeGreaterThan(0)
  })
})

describe('AiUsageService.aiConversationsCount', () => {
  it('counts distinct conversations the AI replied in, inside the São Paulo month', async () => {
    const p = makePrisma()
    p.aiUsageEvent.findMany.mockResolvedValue([
      { conversationId: 'cv1' },
      { conversationId: 'cv2' },
    ])
    const n = await svc(p).aiConversationsCount(
      'acc1',
      new Date('2026-08-17T13:00:00Z'),
    )
    expect(n).toBe(2)
    const args = p.aiUsageEvent.findMany.mock.calls[0]![0]
    expect(args.distinct).toEqual(['conversationId'])
    expect(args.where).toMatchObject({
      accountId: 'acc1',
      replied: true,
      ownKey: false,
      conversationId: { not: null },
    })
    expect((args.where.createdAt.gte as Date).toISOString()).toBe(
      '2026-08-01T03:00:00.000Z',
    )
    expect((args.where.createdAt.lt as Date).toISOString()).toBe(
      '2026-09-01T03:00:00.000Z',
    )
  })

  it('is zero for an account that has never used the AI', async () => {
    const p = makePrisma()
    expect(await svc(p).aiConversationsCount('acc1')).toBe(0)
  })
})

describe('AiUsageService.hasRepliedThisMonth', () => {
  it('is true once the AI answered that conversation this month', async () => {
    const p = makePrisma()
    p.aiUsageEvent.findFirst.mockResolvedValue({ id: 'ev1' })
    expect(await svc(p).hasRepliedThisMonth('acc1', 'cv1')).toBe(true)
  })

  it('is false when it has not', async () => {
    const p = makePrisma()
    expect(await svc(p).hasRepliedThisMonth('acc1', 'cv1')).toBe(false)
    expect(p.aiUsageEvent.findFirst.mock.calls[0]![0].where).toMatchObject({
      conversationId: 'cv1',
      replied: true,
      ownKey: false,
    })
  })
})

describe('AiUsageService.costThisMonth', () => {
  it('sums the ledger over the billing month', async () => {
    const p = makePrisma()
    p.aiUsageEvent.aggregate.mockResolvedValue({ _sum: { costUsd: '4.25' } })
    const out = await svc(p).costThisMonth('acc1', new Date('2026-08-17T13:00:00Z'))
    expect(out).toBe(4.25)
    const where = p.aiUsageEvent.aggregate.mock.calls[0]![0].where
    expect((where.createdAt.gte as Date).toISOString()).toBe('2026-08-01T03:00:00.000Z')
  })

  it('is zero on an empty ledger', async () => {
    const p = makePrisma()
    expect(await svc(p).costThisMonth('acc1')).toBe(0)
  })
})

describe('AiUsageService.botCostLast24h', () => {
  it("sums one agent's ledger rows over the last 24 hours", async () => {
    const p = makePrisma()
    p.aiUsageEvent.aggregate.mockResolvedValue({ _sum: { costUsd: '0.42' } })
    const at = new Date('2026-10-17T12:00:00Z')
    expect(await svc(p).botCostLast24h('bot-fin', at)).toBe(0.42)
    expect(p.aiUsageEvent.aggregate.mock.calls[0]![0].where).toEqual({
      agentBotId: 'bot-fin',
      createdAt: { gte: new Date('2026-10-16T12:00:00Z') },
    })
  })

  it('is zero when the agent spent nothing', async () => {
    const p = makePrisma()
    expect(await svc(p).botCostLast24h('bot-fin')).toBe(0)
  })
})

describe('AiUsageService.allowanceFor', () => {
  it("uses the plan's allowance when there is no override", async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: null,
      aiAllowanceOverrideUntil: null,
    })
    expect(await svc(p).allowanceFor('acc1', 'SPACESHIP')).toEqual({
      included: 1_000,
      overagePriceBrl: 0.5,
      overridden: false,
    })
  })

  it('applies a live override', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: 5_000,
      aiAllowanceOverrideUntil: new Date('2026-12-31T00:00:00Z'),
    })
    expect(
      await svc(p).allowanceFor('acc1', 'ROCKET', new Date('2026-09-17T00:00:00Z')),
    ).toEqual({ included: 5_000, overagePriceBrl: null, overridden: true })
  })

  it('reads -1 as unlimited', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: -1,
      aiAllowanceOverrideUntil: new Date('2026-12-31T00:00:00Z'),
    })
    const out = await svc(p).allowanceFor(
      'acc1',
      'ROCKET',
      new Date('2026-09-17T00:00:00Z'),
    )
    expect(out.included).toBe(Number.POSITIVE_INFINITY)
    expect(out.overridden).toBe(true)
  })

  it('lets an expired override lapse back to the plan', async () => {
    // Nebula's lesson from account 4451: a pilot nobody remembered to close
    // stayed unlimited forever. An override with a past date is over.
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: -1,
      aiAllowanceOverrideUntil: new Date('2026-08-31T00:00:00Z'),
    })
    expect(
      await svc(p).allowanceFor('acc1', 'ROCKET', new Date('2026-09-17T00:00:00Z')),
    ).toMatchObject({ included: 300, overridden: false })
  })

  it('ignores an override with no end date at all', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: 9_999,
      aiAllowanceOverrideUntil: null,
    })
    expect(await svc(p).allowanceFor('acc1', 'ROCKET')).toMatchObject({
      included: 300,
      overridden: false,
    })
  })

  it('ignores an unparseable end date', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      aiAllowanceOverride: 9_999,
      aiAllowanceOverrideUntil: new Date('not a date'),
    })
    expect(await svc(p).allowanceFor('acc1', 'ROCKET')).toMatchObject({
      overridden: false,
    })
  })

  it('falls back to the plan for a vanished account', async () => {
    const p = makePrisma()
    expect(await svc(p).allowanceFor('acc1', 'ENTERPRISE')).toEqual({
      included: 3_000,
      overagePriceBrl: 0.4,
      overridden: false,
    })
  })

  it('answers for the legacy and internal plans too', async () => {
    const p = makePrisma()
    expect((await svc(p).allowanceFor('acc1', 'EXPLORER')).included).toBe(50)
    expect((await svc(p).allowanceFor('acc1', 'JETPACK')).included).toBe(100)
    expect((await svc(p).allowanceFor('acc1', 'PARTNER')).included).toBe(Infinity)
    expect((await svc(p).allowanceFor('acc1', 'MASTER')).included).toBe(Infinity)
  })
})
