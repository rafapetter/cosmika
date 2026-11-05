import { ForbiddenException, NotFoundException } from '@nestjs/common'
import {
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@cosmika/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationService } from './automation.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    automationRule: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeEngine() {
  return { dryRun: vi.fn() } as unknown as import('./automation.engine').AutomationEngine
}

function makeService(prisma: Prisma, engine = makeEngine()) {
  return { svc: new AutomationService(prisma as never, engine), engine }
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }

describe('AutomationService.list', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('returns rules sorted by createdAt desc for any active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.automationRule.findMany.mockResolvedValue([{ id: 'r1' }])
    const { svc } = makeService(prisma)
    expect(await svc.list('u1', 'acc1')).toEqual([{ id: 'r1' }])
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'desc' },
    })
  })
})

describe('AutomationService.get', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('404 unknown rule', async () => {
    prisma.automationRule.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.get('u1', 'acc1', 'r1')).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR (rule from another account)', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ id: 'r1', accountId: 'other-acc' })
    const { svc } = makeService(prisma)
    await expect(svc.get('u1', 'acc1', 'r1')).rejects.toThrow(NotFoundException)
  })

  it('returns rule when found + owned by account', async () => {
    const rule = { id: 'r1', accountId: 'acc1', name: 'Rule 1' }
    prisma.automationRule.findUnique.mockResolvedValue(rule)
    const { svc } = makeService(prisma)
    expect(await svc.get('u1', 'acc1', 'r1')).toBe(rule)
  })
})

describe('AutomationService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', {
        name: 'X',
        triggerEvent: 'CONVERSATION_CREATED',
        conditions: [],
        actions: [],
      } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('SUPERVISOR can create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    prisma.automationRule.create.mockResolvedValue({ id: 'r1' })
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      name: 'X',
      triggerEvent: 'CONVERSATION_CREATED',
      conditions: [],
      actions: [],
    } as never)
    expect(prisma.automationRule.create).toHaveBeenCalled()
  })

  it('persists with defaults (description=null, isActive=true, runOncePerConversation=true)', async () => {
    prisma.automationRule.create.mockResolvedValue({ id: 'r1' })
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      name: 'New Rule',
      triggerEvent: 'MESSAGE_CREATED',
      conditions: [],
      actions: [],
    } as never)
    expect(prisma.automationRule.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        name: 'New Rule',
        description: null,
        triggerEvent: 'MESSAGE_CREATED',
        isActive: true,
        conditions: [],
        actions: [],
        runOncePerConversation: true,
      },
    })
  })

  it('respects supplied description / isActive=false / runOncePerConversation=false', async () => {
    prisma.automationRule.create.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      name: 'X',
      description: 'auto-tag VIP',
      triggerEvent: 'CONVERSATION_CREATED',
      isActive: false,
      conditions: [{ field: 'EMAIL_DOMAIN', op: 'equals', value: 'acme.com' }],
      actions: [{ kind: 'ADD_TAG', value: 'vip' }],
      runOncePerConversation: false,
    } as never)
    const arg = prisma.automationRule.create.mock.calls[0]![0]
    expect(arg.data.description).toBe('auto-tag VIP')
    expect(arg.data.isActive).toBe(false)
    expect(arg.data.runOncePerConversation).toBe(false)
    expect(arg.data.conditions).toEqual([
      { field: 'EMAIL_DOMAIN', op: 'equals', value: 'acme.com' },
    ])
    expect(arg.data.actions).toEqual([{ kind: 'ADD_TAG', value: 'vip' }])
  })
})

describe('AutomationService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.update('u1', 'acc1', 'r1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.automationRule.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.update('u1', 'acc1', 'r1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ id: 'r1', accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(svc.update('u1', 'acc1', 'r1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('applies every field independently', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ id: 'r1', accountId: 'acc1' })
    prisma.automationRule.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'r1', {
      name: 'New name',
      description: 'New desc',
      triggerEvent: 'CONVERSATION_UPDATED',
      isActive: false,
      conditions: [{ field: 'STATUS', op: 'equals', value: 'PENDING' }],
      actions: [{ kind: 'SET_STATUS', value: 'RESOLVED' }],
      runOncePerConversation: false,
    } as never)
    const arg = prisma.automationRule.update.mock.calls[0]![0]
    expect(arg.data.name).toBe('New name')
    expect(arg.data.description).toBe('New desc')
    expect(arg.data.triggerEvent).toBe('CONVERSATION_UPDATED')
    expect(arg.data.isActive).toBe(false)
    expect(arg.data.runOncePerConversation).toBe(false)
    expect(arg.data.conditions).toEqual([{ field: 'STATUS', op: 'equals', value: 'PENDING' }])
    expect(arg.data.actions).toEqual([{ kind: 'SET_STATUS', value: 'RESOLVED' }])
  })

  it('description can be set to null (clearing)', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ id: 'r1', accountId: 'acc1' })
    prisma.automationRule.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'r1', { description: null } as never)
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { description: null },
    })
  })

  it('sends empty data when nothing to update', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ id: 'r1', accountId: 'acc1' })
    prisma.automationRule.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'r1', {} as never)
    expect(prisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: {},
    })
  })
})

describe('AutomationService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'r1')).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.automationRule.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'r1')).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'r1')).rejects.toThrow(NotFoundException)
  })

  it('deletes when authorised', async () => {
    prisma.automationRule.findUnique.mockResolvedValue({ accountId: 'acc1' })
    const { svc } = makeService(prisma)
    await svc.remove('u1', 'acc1', 'r1')
    expect(prisma.automationRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } })
  })
})

describe('AutomationService.dryRun', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('hydrates the rule via get() and delegates to engine.dryRun', async () => {
    const rule = { id: 'r1', accountId: 'acc1' }
    prisma.automationRule.findUnique.mockResolvedValue(rule)
    const engine = makeEngine()
    ;(engine.dryRun as ReturnType<typeof vi.fn>).mockResolvedValue({ matched: true })
    const svc = new AutomationService(prisma as never, engine)
    const out = await svc.dryRun('u1', 'acc1', 'r1', 'cv1')
    expect(engine.dryRun).toHaveBeenCalledWith(rule, 'cv1')
    expect(out).toEqual({ matched: true })
  })

  it('404s on unknown rule (via the get() guard)', async () => {
    prisma.automationRule.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.dryRun('u1', 'acc1', 'r1', 'cv1')).rejects.toThrow(NotFoundException)
  })
})

describe('AutomationService.toDTO', () => {
  const svc = new AutomationService(makePrisma() as never, makeEngine())

  it('maps every field + parses conditions/actions arrays', () => {
    const rule = {
      id: 'r1',
      accountId: 'acc1',
      name: 'X',
      description: 'd',
      triggerEvent: 'CONVERSATION_CREATED',
      isActive: true,
      conditions: [{ field: 'EMAIL_DOMAIN', op: 'equals', value: 'acme.com' }],
      actions: [{ kind: 'ADD_TAG', value: 'vip' }],
      runOncePerConversation: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    }
    expect(svc.toDTO(rule as never)).toEqual({
      id: 'r1',
      accountId: 'acc1',
      name: 'X',
      description: 'd',
      triggerEvent: 'CONVERSATION_CREATED',
      isActive: true,
      conditions: rule.conditions,
      actions: rule.actions,
      runOncePerConversation: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('coerces non-array conditions/actions to [] (defensive against bad JSON)', () => {
    const dto = svc.toDTO({
      id: 'r1',
      accountId: 'acc1',
      name: 'X',
      description: null,
      triggerEvent: 'MESSAGE_CREATED',
      isActive: false,
      conditions: { not: 'an array' } as never, // corrupted
      actions: 'string corruption' as never,
      runOncePerConversation: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    expect(dto.conditions).toEqual([])
    expect(dto.actions).toEqual([])
  })
})

describe('automation rule input validation (SET_STATUS)', () => {
  const base = {
    name: 'R',
    triggerEvent: 'CONVERSATION_CREATED' as const,
    conditions: [],
  }

  it.each(['OPEN', 'PENDING', 'RESOLVED'])('accepts SET_STATUS %s', (value) => {
    const r = CreateAutomationRuleInput.safeParse({
      ...base,
      actions: [{ kind: 'SET_STATUS', value }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects SET_STATUS SNOOZED: no such conversation status exists', () => {
    const r = CreateAutomationRuleInput.safeParse({
      ...base,
      actions: [{ kind: 'SET_STATUS', value: 'SNOOZED' }],
    })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]!.path).toEqual(['actions', 0, 'value'])
    expect(r.error!.issues[0]!.message).toContain('SET_STATUS accepts')
  })

  it('rejects SET_STATUS SNOOZED on update too', () => {
    const r = UpdateAutomationRuleInput.safeParse({
      actions: [{ kind: 'SET_STATUS', value: 'SNOOZED' }],
    })
    expect(r.success).toBe(false)
  })

  it('leaves other action kinds free-form', () => {
    const r = CreateAutomationRuleInput.safeParse({
      ...base,
      actions: [
        { kind: 'ADD_TAG', value: 'SNOOZED' },
        { kind: 'SEND_REPLY', value: 'anything goes here' },
      ],
    })
    expect(r.success).toBe(true)
  })
})
