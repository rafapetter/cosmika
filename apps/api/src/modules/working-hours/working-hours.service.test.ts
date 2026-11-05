import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkingHoursService } from './working-hours.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    inbox: { findUnique: vi.fn() },
    workingHour: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    holiday: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): WorkingHoursService {
  prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(prisma))
  return new WorkingHoursService(prisma as never)
}

const ADMIN = { id: 'mA', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { id: 'mS', userId: 'u1', accountId: 'acc1', role: 'SUPERVISOR', isActive: true }
const AGENT = { id: 'mAg', userId: 'u1', accountId: 'acc1', role: 'AGENT', isActive: true }
const INBOX = { id: 'inb1', accountId: 'acc1' }

// ---------- listForInbox ----------

describe('WorkingHoursService.listForInbox', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403s when actor not a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).listForInbox('u1', 'acc1', 'inb1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403s when member is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, isActive: false })
    await expect(makeService(prisma).listForInbox('u1', 'acc1', 'inb1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404s when inbox is unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).listForInbox('u1', 'acc1', 'inb1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s when inbox belongs to another account (IDOR)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'other-acc' })
    await expect(makeService(prisma).listForInbox('u1', 'acc1', 'inb1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns the rows for an authorised actor', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(INBOX)
    const rows = [{ dayOfWeek: 1 }, { dayOfWeek: 2 }]
    prisma.workingHour.findMany.mockResolvedValue(rows)
    expect(await makeService(prisma).listForInbox('u1', 'acc1', 'inb1')).toEqual(rows)
  })
})

// ---------- setForInbox ----------

describe('WorkingHoursService.setForInbox', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(INBOX)
    prisma.workingHour.deleteMany.mockResolvedValue({ count: 7 })
    prisma.workingHour.createMany.mockResolvedValue({ count: 0 })
    prisma.workingHour.findMany.mockResolvedValue([])
  })

  it('403s when AGENT tries to mutate', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).setForInbox('u1', 'acc1', 'inb1', { hours: [] } as never),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('allows SUPERVISOR to mutate', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    await expect(
      makeService(prisma).setForInbox('u1', 'acc1', 'inb1', { hours: [] } as never),
    ).resolves.toEqual([])
  })

  it('writes the hours after wiping existing ones', async () => {
    prisma.workingHour.findMany.mockResolvedValue([{ dayOfWeek: 1 }])
    const input = {
      hours: [
        { dayOfWeek: 1, closedAllDay: false, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 },
      ],
    } as never
    await makeService(prisma).setForInbox('u1', 'acc1', 'inb1', input)
    expect(prisma.workingHour.deleteMany).toHaveBeenCalledWith({ where: { inboxId: 'inb1' } })
    expect(prisma.workingHour.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ dayOfWeek: 1, accountId: 'acc1', inboxId: 'inb1' }),
      ],
    })
  })

  it('dedupes by dayOfWeek (last write wins)', async () => {
    const input = {
      hours: [
        { dayOfWeek: 1, closedAllDay: false, openHour: 9, openMinute: 0, closeHour: 12, closeMinute: 0 },
        { dayOfWeek: 1, closedAllDay: false, openHour: 13, openMinute: 0, closeHour: 18, closeMinute: 0 },
      ],
    } as never
    await makeService(prisma).setForInbox('u1', 'acc1', 'inb1', input)
    const createArg = prisma.workingHour.createMany.mock.calls[0]![0]
    expect(createArg.data).toHaveLength(1)
    expect(createArg.data[0].openHour).toBe(13) // second wins
  })

  it('returns empty array (skips createMany) when input is empty', async () => {
    await makeService(prisma).setForInbox('u1', 'acc1', 'inb1', { hours: [] } as never)
    expect(prisma.workingHour.createMany).not.toHaveBeenCalled()
  })
})

// ---------- holidays ----------

describe('WorkingHoursService.listHolidays', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('returns holidays for a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.holiday.findMany.mockResolvedValue([{ name: 'Carnaval' }])
    expect(await makeService(prisma).listHolidays('u1', 'acc1')).toEqual([{ name: 'Carnaval' }])
  })

  it('403s for non-members', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).listHolidays('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe('WorkingHoursService.createHoliday', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403s when AGENT tries to create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).createHoliday('u1', 'acc1', { name: 'X', date: '2026-09-07' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('parses date as UTC midnight and persists', async () => {
    let captured: { date: Date } | null = null
    prisma.holiday.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'h1', ...data, createdAt: new Date() }
    })
    await makeService(prisma).createHoliday('u1', 'acc1', { name: 'Independência', date: '2026-09-07' })
    expect(captured!.date.toISOString()).toBe('2026-09-07T00:00:00.000Z')
  })

  it('throws on an invalid date string', async () => {
    await expect(
      makeService(prisma).createHoliday('u1', 'acc1', { name: 'X', date: 'not-a-date' }),
    ).rejects.toThrow('Invalid date')
  })
})

describe('WorkingHoursService.deleteHoliday', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403s when AGENT tries to delete', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).deleteHoliday('u1', 'acc1', 'h1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404s on missing holiday', async () => {
    prisma.holiday.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).deleteHoliday('u1', 'acc1', 'h1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s on holiday from another account', async () => {
    prisma.holiday.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    await expect(makeService(prisma).deleteHoliday('u1', 'acc1', 'h1')).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.holiday.delete).not.toHaveBeenCalled()
  })

  it('deletes the holiday when authorised', async () => {
    prisma.holiday.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.holiday.delete.mockResolvedValue({})
    await makeService(prisma).deleteHoliday('u1', 'acc1', 'h1')
    expect(prisma.holiday.delete).toHaveBeenCalledWith({ where: { id: 'h1' } })
  })
})

// ---------- isInboxOpenNow ----------

describe('WorkingHoursService.isInboxOpenNow', () => {
  let prisma: Prisma
  // Pick a fixed UTC instant: Mon 2026-05-04T14:30:00Z (Monday, 14:30 UTC).
  const NOW = new Date('2026-05-04T14:30:00.000Z')

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns false if today is a holiday (regardless of working hours)', async () => {
    prisma.holiday.findFirst.mockResolvedValue({ id: 'h1' })
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(false)
    // workingHour lookup should not have happened
    expect(prisma.workingHour.findUnique).not.toHaveBeenCalled()
  })

  it('returns false when there is no working-hours row for today', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue(null)
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(false)
  })

  it('returns false when closedAllDay=true', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue({ closedAllDay: true })
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(false)
  })

  it('returns true when current time is inside the open window', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue({
      closedAllDay: false,
      openHour: 9,
      openMinute: 0,
      closeHour: 18,
      closeMinute: 0,
    })
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(true)
  })

  it('returns false when current time is before open', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue({
      closedAllDay: false,
      openHour: 15,
      openMinute: 0,
      closeHour: 18,
      closeMinute: 0,
    })
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(false)
  })

  it('returns false when current time equals the close minute (close is exclusive)', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue({
      closedAllDay: false,
      openHour: 9,
      openMinute: 0,
      closeHour: 14,
      closeMinute: 30,
    })
    expect(
      await makeService(prisma).isInboxOpenNow('acc1', 'inb1', NOW),
    ).toBe(false)
  })

  it('uses Date.now() default when no `now` provided', async () => {
    prisma.holiday.findFirst.mockResolvedValue(null)
    prisma.workingHour.findUnique.mockResolvedValue({ closedAllDay: true })
    // Just confirm it doesn't throw and reaches the worker path.
    expect(await makeService(prisma).isInboxOpenNow('acc1', 'inb1')).toBe(false)
  })
})

// ---------- DTOs ----------

describe('WorkingHoursService DTOs', () => {
  const svc = new WorkingHoursService(makePrisma() as never)

  it('toWorkingHourDTO maps every field', () => {
    expect(
      svc.toWorkingHourDTO({
        id: 'w1',
        inboxId: 'inb1',
        accountId: 'acc1',
        dayOfWeek: 1,
        closedAllDay: false,
        openHour: 9,
        openMinute: 0,
        closeHour: 18,
        closeMinute: 0,
      } as never),
    ).toEqual({
      id: 'w1',
      inboxId: 'inb1',
      dayOfWeek: 1,
      closedAllDay: false,
      openHour: 9,
      openMinute: 0,
      closeHour: 18,
      closeMinute: 0,
    })
  })

  it('toHolidayDTO formats date as YYYY-MM-DD + createdAt ISO', () => {
    expect(
      svc.toHolidayDTO({
        id: 'h1',
        accountId: 'acc1',
        name: 'Carnaval',
        date: new Date('2026-02-17T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never),
    ).toEqual({
      id: 'h1',
      accountId: 'acc1',
      name: 'Carnaval',
      date: '2026-02-17',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })
})
