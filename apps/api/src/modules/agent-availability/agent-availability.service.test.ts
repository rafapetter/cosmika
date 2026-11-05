import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentAvailabilityService } from './agent-availability.service'

function makePrisma() {
  return {
    accountMember: {
      findUnique: vi.fn(),
    },
    agentAvailability: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(undefined)),
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma) {
  // Make $transaction call the callback with the same prisma so mocked
  // tx.agentAvailability.* methods are the same as prisma.agentAvailability.*.
  prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(prisma))
  return new AgentAvailabilityService(prisma as never)
}

describe('AgentAvailabilityService.list', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403s when actor is not a member of the account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1', 'm1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403s when actor membership is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      id: 'mActor',
      userId: 'u1',
      accountId: 'acc1',
      role: 'ADMINISTRATOR',
      isActive: false,
    })
    await expect(makeService(prisma).list('u1', 'acc1', 'm1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404s when the target memberId is unknown', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'ADMINISTRATOR',
        isActive: true,
      })
      .mockResolvedValueOnce(null)
    await expect(makeService(prisma).list('u1', 'acc1', 'missing')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s when the target memberId belongs to another account (IDOR guard)', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'ADMINISTRATOR',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u2',
        accountId: 'other-acc',
        role: 'AGENT',
        isActive: true,
      })
    await expect(makeService(prisma).list('u1', 'acc1', 'mTarget')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('403s when AGENT tries to view another user\'s schedule', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u2', // different user
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
    await expect(makeService(prisma).list('u1', 'acc1', 'mTarget')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('allows AGENT to view own schedule', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u1', // same user
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
    prisma.agentAvailability.findMany.mockResolvedValue([])
    await expect(
      makeService(prisma).list('u1', 'acc1', 'mTarget'),
    ).resolves.toEqual([])
  })

  it('allows ADMIN to view anyone\'s schedule', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'ADMINISTRATOR',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u2',
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
    const schedule = [
      { id: 'a1', dayOfWeek: 1 },
      { id: 'a2', dayOfWeek: 2 },
    ]
    prisma.agentAvailability.findMany.mockResolvedValue(schedule)
    await expect(
      makeService(prisma).list('u1', 'acc1', 'mTarget'),
    ).resolves.toEqual(schedule)
    expect(prisma.agentAvailability.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', memberId: 'mTarget' },
      orderBy: { dayOfWeek: 'asc' },
    })
  })
})

describe('AgentAvailabilityService.replace', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'ADMINISTRATOR',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u1',
        accountId: 'acc1',
        role: 'ADMINISTRATOR',
        isActive: true,
      })
  })

  it('deletes existing rows + inserts the new schedule in a transaction', async () => {
    prisma.agentAvailability.deleteMany.mockResolvedValue({ count: 7 })
    prisma.agentAvailability.createMany.mockResolvedValue({ count: 3 })
    prisma.agentAvailability.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])

    const schedule = [
      { dayOfWeek: 1, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
      { dayOfWeek: 2, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
      { dayOfWeek: 3, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: true },
    ]
    const out = await makeService(prisma).replace('u1', 'acc1', 'mTarget', schedule as never)
    expect(out).toHaveLength(3)
    expect(prisma.agentAvailability.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', memberId: 'mTarget' },
    })
    expect(prisma.agentAvailability.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ accountId: 'acc1', memberId: 'mTarget', dayOfWeek: 1 }),
      ]),
    })
  })

  it('short-circuits createMany when schedule is empty', async () => {
    prisma.agentAvailability.deleteMany.mockResolvedValue({ count: 7 })
    const out = await makeService(prisma).replace('u1', 'acc1', 'mTarget', [])
    expect(out).toEqual([])
    expect(prisma.agentAvailability.createMany).not.toHaveBeenCalled()
  })
})

describe('AgentAvailabilityService.replace — permission edge', () => {
  it('403s when AGENT tries to replace another user\'s schedule', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique
      .mockResolvedValueOnce({
        id: 'mActor',
        userId: 'u1',
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'mTarget',
        userId: 'u2',
        accountId: 'acc1',
        role: 'AGENT',
        isActive: true,
      })
    await expect(
      makeService(prisma).replace('u1', 'acc1', 'mTarget', []),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('AgentAvailabilityService.toDTO', () => {
  const svc = new AgentAvailabilityService(makePrisma() as never)

  it('maps every field', () => {
    const row = {
      id: 'aa1',
      memberId: 'm1',
      accountId: 'acc1',
      dayOfWeek: 3,
      openHour: 9,
      openMinute: 30,
      closeHour: 18,
      closeMinute: 0,
      closedAllDay: false,
    } as never
    expect(svc.toDTO(row)).toEqual({
      id: 'aa1',
      memberId: 'm1',
      dayOfWeek: 3,
      openHour: 9,
      openMinute: 30,
      closeHour: 18,
      closeMinute: 0,
      closedAllDay: false,
    })
  })

  it('omits accountId (internal field)', () => {
    const dto = svc.toDTO({
      id: 'aa1',
      memberId: 'm1',
      accountId: 'acc1',
      dayOfWeek: 0,
      openHour: 0,
      openMinute: 0,
      closeHour: 0,
      closeMinute: 0,
      closedAllDay: true,
    } as never)
    expect(dto).not.toHaveProperty('accountId')
  })
})
