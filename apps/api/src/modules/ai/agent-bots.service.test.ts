import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentBotsService } from './agent-bots.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    agentBot: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inbox: {
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    aiAgentSession: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
    },
    agentToolCall: { deleteMany: vi.fn() },
    account: { findUnique: vi.fn() },
    article: { count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeAiUsage() {
  return {
    costThisMonth: vi.fn().mockResolvedValue(0),
    record: vi.fn().mockResolvedValue(0),
  }
}
type AiUsage = ReturnType<typeof makeAiUsage>

function makeService(p: Prisma, aiUsage: AiUsage = makeAiUsage()) {
  p.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(p))
  return new AgentBotsService(p as never, aiUsage as never)
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }
const BOT = { id: 'b1', accountId: 'acc1', dailyBudgetUsd: 10 }

describe('AgentBotsService.list', () => {
  it('403 non-member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('403 inactive member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ ...AGENT, isActive: false })
    await expect(makeService(p).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('returns bots sorted by createdAt asc', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.agentBot.findMany.mockResolvedValue([{ id: 'b1' }])
    expect(await makeService(p).list('u1', 'acc1')).toEqual([{ id: 'b1' }])
    expect(p.agentBot.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'asc' },
    })
  })
})

describe('AgentBotsService.get', () => {
  it('404 unknown', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.agentBot.findUnique.mockResolvedValue(null)
    await expect(makeService(p).get('u1', 'acc1', 'b1')).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'other-acc' })
    await expect(makeService(p).get('u1', 'acc1', 'b1')).rejects.toThrow(NotFoundException)
  })

  it('returns bot when authorised', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    expect(await makeService(p).get('u1', 'acc1', 'b1')).toEqual({ id: 'b1', accountId: 'acc1' })
  })
})

describe('AgentBotsService.create', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(p).create('u1', 'acc1', {
        name: 'X', systemPrompt: 'You are X',
      } as never),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('SUPERVISOR can create', async () => {
    p.accountMember.findUnique.mockResolvedValue(SUPER)
    p.agentBot.create.mockResolvedValue({ id: 'b1' })
    await makeService(p).create('u1', 'acc1', {
      name: 'X', systemPrompt: 'prompt',
    } as never)
    expect(p.agentBot.create).toHaveBeenCalled()
  })

  it('applies every default when not supplied', async () => {
    p.agentBot.create.mockResolvedValue({ id: 'b1' })
    await makeService(p).create('u1', 'acc1', {
      name: 'New',
      systemPrompt: 'You are helpful.',
    } as never)
    const arg = p.agentBot.create.mock.calls[0]![0]
    expect(arg.data).toEqual({
      accountId: 'acc1',
      name: 'New',
      description: null,
      systemPrompt: 'You are helpful.',
      model: 'claude-opus-4-7',
      temperature: 0.7,
      toolsEnabled: [],
      customTools: [],
      fallbackToHuman: true,
      autoSafeConfidenceThreshold: 80,
      dailyBudgetUsd: 10,
      knowledgeTags: [],
      isActive: true,
    })
  })

  it('respects every supplied value', async () => {
    p.agentBot.create.mockResolvedValue({ id: 'b1' })
    await makeService(p).create('u1', 'acc1', {
      name: 'X',
      description: 'd',
      systemPrompt: 'prompt',
      model: 'claude-haiku-4-5',
      temperature: 0.2,
      toolsEnabled: [{ name: 'attach_tag' }],
      customTools: [{ name: 'webhook', webhook: { url: 'https://x' } }],
      fallbackToHuman: false,
      autoSafeConfidenceThreshold: 90,
      dailyBudgetUsd: 25,
      knowledgeTags: [' financeiro ', 'anuidade', 'financeiro', ''],
      isActive: false,
    } as never)
    const arg = p.agentBot.create.mock.calls[0]![0]
    expect(arg.data.knowledgeTags).toEqual(['financeiro', 'anuidade'])
    expect(arg.data.model).toBe('claude-haiku-4-5')
    expect(arg.data.temperature).toBe(0.2)
    expect(arg.data.fallbackToHuman).toBe(false)
    expect(arg.data.dailyBudgetUsd).toBe(25)
    expect(arg.data.isActive).toBe(false)
  })
})

describe('AgentBotsService.update', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(p).update('u1', 'acc1', 'b1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    p.agentBot.findUnique.mockResolvedValue(null)
    await expect(makeService(p).update('u1', 'acc1', 'b1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'other' })
    await expect(makeService(p).update('u1', 'acc1', 'b1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('applies every field independently', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    p.agentBot.update.mockResolvedValue({})
    await makeService(p).update('u1', 'acc1', 'b1', {
      name: 'N', description: 'D', systemPrompt: 'S',
      model: 'claude-sonnet-4-6', temperature: 0.5,
      toolsEnabled: [], customTools: [],
      fallbackToHuman: false,
      autoSafeConfidenceThreshold: 75,
      dailyBudgetUsd: 7.5,
      knowledgeTags: ['cadastro '],
      isActive: false,
    } as never)
    const arg = p.agentBot.update.mock.calls[0]![0]
    expect(arg.data.knowledgeTags).toEqual(['cadastro'])
    expect(arg.data.name).toBe('N')
    expect(arg.data.description).toBe('D')
    expect(arg.data.systemPrompt).toBe('S')
    expect(arg.data.model).toBe('claude-sonnet-4-6')
    expect(arg.data.temperature).toBe(0.5)
    expect(arg.data.toolsEnabled).toEqual([])
    expect(arg.data.customTools).toEqual([])
    expect(arg.data.fallbackToHuman).toBe(false)
    expect(arg.data.autoSafeConfidenceThreshold).toBe(75)
    expect(arg.data.dailyBudgetUsd).toBe(7.5)
    expect(arg.data.isActive).toBe(false)
  })

  it('description can be cleared via null', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    p.agentBot.update.mockResolvedValue({})
    await makeService(p).update('u1', 'acc1', 'b1', { description: null } as never)
    expect(p.agentBot.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { description: null },
    })
  })

  it('sends empty data when nothing to update', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    p.agentBot.update.mockResolvedValue({})
    await makeService(p).update('u1', 'acc1', 'b1', {} as never)
    expect(p.agentBot.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: {} })
  })
})

describe('AgentBotsService.remove', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(p).remove('u1', 'acc1', 'b1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    p.agentBot.findUnique.mockResolvedValue(null)
    await expect(makeService(p).remove('u1', 'acc1', 'b1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'other' })
    await expect(makeService(p).remove('u1', 'acc1', 'b1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('detaches inboxes and deletes when no sessions exist', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    p.inbox.updateMany.mockResolvedValue({ count: 3 })
    p.aiAgentSession.findMany.mockResolvedValue([])
    await makeService(p).remove('u1', 'acc1', 'b1')
    expect(p.inbox.updateMany).toHaveBeenCalledWith({
      where: { agentBotId: 'b1' },
      data: { agentBotId: null },
    })
    expect(p.agentToolCall.deleteMany).not.toHaveBeenCalled() // no sessions to clean
    expect(p.agentBot.delete).toHaveBeenCalledWith({ where: { id: 'b1' } })
  })

  it('cascades sessions + tool calls before deleting the bot', async () => {
    p.agentBot.findUnique.mockResolvedValue({ id: 'b1', accountId: 'acc1' })
    p.inbox.updateMany.mockResolvedValue({ count: 0 })
    p.aiAgentSession.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    await makeService(p).remove('u1', 'acc1', 'b1')
    expect(p.agentToolCall.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: ['s1', 's2'] } },
    })
    expect(p.aiAgentSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] } },
    })
    expect(p.agentBot.delete).toHaveBeenCalledWith({ where: { id: 'b1' } })
  })
})

// `AgentBotsService.recordAiUsage` is gone: `AiUsageService.record`
// superseded it, writing an `AiUsageEvent` ledger row AND folding the same
// call into the `AiAgentSession` aggregate the budget guards read. The
// session-upsert behaviour its tests covered (create, increment, and the
// no-bot case a flow-only inbox produces) is asserted in
// `usage/ai-usage.service.test.ts` instead.

describe('AgentBotsService.inboxCount', () => {
  it('counts inboxes by agentBotId', async () => {
    const p = makePrisma()
    p.inbox.count.mockResolvedValue(4)
    expect(await makeService(p).inboxCount('b1')).toBe(4)
    expect(p.inbox.count).toHaveBeenCalledWith({ where: { agentBotId: 'b1' } })
  })
})

describe('AgentBotsService.assertBudget', () => {
  it('passes when used < cap', async () => {
    const p = makePrisma()
    p.aiAgentSession.aggregate.mockResolvedValue({ _sum: { totalCostUsd: 5 } })
    await expect(
      makeService(p).assertBudget({ id: 'b1', dailyBudgetUsd: 10 } as never),
    ).resolves.toBeUndefined()
  })

  it('throws ConflictException when used >= cap', async () => {
    const p = makePrisma()
    p.aiAgentSession.aggregate.mockResolvedValue({ _sum: { totalCostUsd: 10 } })
    await expect(
      makeService(p).assertBudget({ id: 'b1', dailyBudgetUsd: 10 } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('throws ConflictException with the spend message when over by a lot', async () => {
    const p = makePrisma()
    p.aiAgentSession.aggregate.mockResolvedValue({ _sum: { totalCostUsd: 999.9999 } })
    await expect(
      makeService(p).assertBudget({ id: 'b1', dailyBudgetUsd: 10 } as never),
    ).rejects.toThrow(/Daily AI budget exceeded.*\$999.9999.*\$10.00/)
  })
})

describe('AgentBotsService.toDTO', () => {
  it('maps every field + computes costLast24h + inboxCount', async () => {
    const p = makePrisma()
    p.aiAgentSession.aggregate.mockResolvedValue({ _sum: { totalCostUsd: 2.5 } })
    p.inbox.count.mockResolvedValue(3)
    p.article.count.mockResolvedValue(4)
    const dto = await makeService(p).toDTO({
      id: 'b1',
      accountId: 'acc1',
      name: 'Bot',
      description: 'd',
      systemPrompt: 'You are helpful.',
      model: 'claude-opus-4-7',
      temperature: 0.7,
      toolsEnabled: [{ name: 'attach_tag' }],
      customTools: [{ name: 'wh' }],
      fallbackToHuman: true,
      autoSafeConfidenceThreshold: 80,
      dailyBudgetUsd: 10,
      knowledgeTags: ['financeiro'],
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    } as never)
    expect(dto.knowledgeTags).toEqual(['financeiro'])
    expect(dto.knowledgeArticleCount).toBe(4)
    // The base is the bot's tags, published articles of its own account only.
    expect(p.article.count).toHaveBeenCalledWith({
      where: { accountId: 'acc1', status: 'PUBLISHED', tags: { hasSome: ['financeiro'] } },
    })
    expect(dto.costLast24hUsd).toBe(2.5)
    expect(dto.inboxCount).toBe(3)
    expect(dto.toolsEnabled).toEqual([{ name: 'attach_tag' }])
    expect(dto.customTools).toEqual([{ name: 'wh' }])
    expect(dto.dailyBudgetUsd).toBe(10)
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('coerces toolsEnabled / customTools to [] when null in DB', async () => {
    const p = makePrisma()
    p.aiAgentSession.aggregate.mockResolvedValue({ _sum: { totalCostUsd: 0 } })
    p.inbox.count.mockResolvedValue(0)
    const dto = await makeService(p).toDTO({
      id: 'b1', accountId: 'acc1', name: 'B', description: null,
      systemPrompt: 's', model: 'm', temperature: 0,
      toolsEnabled: null, customTools: null,
      fallbackToHuman: false, autoSafeConfidenceThreshold: 0,
      dailyBudgetUsd: 0, knowledgeTags: [], isActive: false,
      createdAt: new Date(), updatedAt: new Date(),
    } as never)
    // No tags: the whole account base.
    expect(p.article.count).toHaveBeenCalledWith({
      where: { accountId: 'acc1', status: 'PUBLISHED' },
    })
    expect(dto.toolsEnabled).toEqual([])
    expect(dto.customTools).toEqual([])
  })
})

// ---------- monthly account budget ----------

describe('AgentBotsService monthly account budget', () => {
  const svc = (p: ReturnType<typeof makePrisma>) => makeService(p)

  it('reads the month spend from the AI ledger, not from session aggregates', async () => {
    const p = makePrisma()
    const aiUsage = makeAiUsage()
    aiUsage.costThisMonth.mockResolvedValue(4.25)
    expect(await makeService(p, aiUsage).costThisMonth('acc1')).toBe(4.25)
    expect(aiUsage.costThisMonth).toHaveBeenCalledWith('acc1')
    // The old implementation summed AiAgentSession rows active this month,
    // which counted a long-running conversation's whole lifetime cost again
    // in every later month.
    expect(p.aiAgentSession.aggregate).not.toHaveBeenCalled()
  })

  it('treats an empty ledger as zero spend', async () => {
    const p = makePrisma()
    const aiUsage = makeAiUsage()
    aiUsage.costThisMonth.mockResolvedValue(0)
    expect(await makeService(p, aiUsage).costThisMonth('acc1')).toBe(0)
  })

  it('reports the cap as exceeded once spend reaches it', async () => {
    const p = makePrisma()
    const aiUsage = makeAiUsage()
    p.account.findUnique.mockResolvedValue({ monthlyAiBudgetUsd: 15 })
    aiUsage.costThisMonth.mockResolvedValue(15)
    expect(await makeService(p, aiUsage).monthlyBudgetExceeded('acc1')).toEqual({
      exceeded: true, used: 15, cap: 15,
    })
  })

  it('lets a turn through while under the cap', async () => {
    const p = makePrisma()
    const aiUsage = makeAiUsage()
    p.account.findUnique.mockResolvedValue({ monthlyAiBudgetUsd: 15 })
    aiUsage.costThisMonth.mockResolvedValue(2.5)
    expect(await makeService(p, aiUsage).monthlyBudgetExceeded('acc1')).toEqual({
      exceeded: false, used: 2.5, cap: 15,
    })
  })

  it('reads a zero or missing cap as "no ceiling", not "spend nothing"', async () => {
    const p = makePrisma()
    const aiUsage = makeAiUsage()
    aiUsage.costThisMonth.mockResolvedValue(99)
    p.account.findUnique.mockResolvedValue({ monthlyAiBudgetUsd: 0 })
    const s = makeService(p, aiUsage)
    expect((await s.monthlyBudgetExceeded('acc1')).exceeded).toBe(false)
    // A vanished account can't be billed either — don't mute its bots on a race.
    p.account.findUnique.mockResolvedValue(null)
    expect((await s.monthlyBudgetExceeded('acc1')).exceeded).toBe(false)
  })
})
