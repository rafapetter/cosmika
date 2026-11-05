import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AuditLogService } from './audit-log.service'

function makePrisma() {
  return {
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): AuditLogService {
  return new AuditLogService(prisma as never)
}

describe('AuditLogService.record', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('writes a row with all fields', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'al1' })
    await makeService(prisma).record({
      accountId: 'acc1',
      actorId: 'usr1',
      action: 'webhook.create',
      target: 'wh-123',
      metadata: { foo: 'bar' },
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        actorId: 'usr1',
        action: 'webhook.create',
        target: 'wh-123',
        metadata: { foo: 'bar' },
      },
    })
  })

  it('defaults target to null when not passed', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'al1' })
    await makeService(prisma).record({
      accountId: 'acc1',
      actorId: 'usr1',
      action: 'account.update',
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ target: null }),
    })
  })

  it('passes target=null when explicitly null', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'al1' })
    await makeService(prisma).record({
      accountId: 'acc1',
      actorId: 'usr1',
      action: 'a',
      target: null,
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ target: null }),
    })
  })

  it('keeps metadata undefined when not passed (omitted from create)', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'al1' })
    await makeService(prisma).record({
      accountId: 'acc1',
      actorId: 'usr1',
      action: 'a',
    })
    const callArg = prisma.auditLog.create.mock.calls[0]![0]
    expect(callArg.data.metadata).toBeUndefined()
  })

  it('allows actorId null (system-emitted events)', async () => {
    prisma.auditLog.create.mockResolvedValue({ id: 'al1' })
    await makeService(prisma).record({
      accountId: 'acc1',
      actorId: null,
      action: 'system.cron',
    })
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null }),
    })
  })
})

describe('AuditLogService.list', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns items + nextCursor=null when result fits in one page', async () => {
    const rows = [
      { id: 'a1', createdAt: new Date() },
      { id: 'a2', createdAt: new Date() },
    ]
    prisma.auditLog.findMany.mockResolvedValue(rows)
    const out = await makeService(prisma).list('acc1', { limit: 50 })
    expect(out.items).toEqual(rows)
    expect(out.nextCursor).toBeNull()
  })

  it('returns nextCursor when there is a next page', async () => {
    // Service requests `limit+1` rows; if it gets all of them, paginate.
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `a${i}`,
      createdAt: new Date(),
    }))
    prisma.auditLog.findMany.mockResolvedValue(rows)
    const out = await makeService(prisma).list('acc1', { limit: 10 })
    expect(out.items).toHaveLength(10)
    expect(out.nextCursor).toBe('a9') // last id of returned page
  })

  it('defaults limit to 50', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', {})
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51 }), // limit+1
    )
  })

  it('caps limit at 100', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', { limit: 999 })
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    )
  })

  it('filters by action when provided', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', { action: 'webhook.create' })
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'acc1', action: 'webhook.create' },
      }),
    )
  })

  it('filters by actor and period when provided', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', {
      actorId: 'usr1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    })
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: 'acc1',
          actorId: 'usr1',
          createdAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lt: new Date('2026-10-02T00:00:00.000Z'),
          },
        },
      }),
    )
  })

  it('accepts an open-ended period (only `from`)', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', { from: '2026-10-01T00:00:00.000Z' })
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: 'acc1',
          createdAt: { gte: new Date('2026-10-01T00:00:00.000Z') },
        },
      }),
    )
  })

  it('no action filter when omitted', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', {})
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'acc1' },
      }),
    )
  })

  it('adds cursor + skip:1 when paginating', async () => {
    prisma.auditLog.findMany.mockResolvedValue([])
    await makeService(prisma).list('acc1', { cursor: 'a9' })
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: 'a9' },
        skip: 1,
      }),
    )
  })
})

describe('AuditLogService.toDTO', () => {
  const svc = new AuditLogService(makePrisma() as never)

  it('maps a row with actor + metadata + createdAt ISO string', () => {
    const row = {
      id: 'al1',
      accountId: 'acc1',
      action: 'webhook.create',
      target: 'wh-123',
      metadata: { url: 'https://example.com' },
      createdAt: new Date('2026-05-01T00:00:00Z'),
      actor: { id: 'usr1', email: 'a@b.com', fullName: 'Hana' },
    }
    expect(svc.toDTO(row as never)).toEqual({
      id: 'al1',
      accountId: 'acc1',
      actor: { id: 'usr1', email: 'a@b.com', fullName: 'Hana' },
      action: 'webhook.create',
      target: 'wh-123',
      metadata: { url: 'https://example.com' },
      createdAt: '2026-05-01T00:00:00.000Z',
    })
  })

  it('emits actor:null when row has no actor (system-emitted)', () => {
    const row = {
      id: 'al1',
      accountId: 'acc1',
      action: 'system.cron',
      target: null,
      metadata: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      actor: null,
    }
    const dto = svc.toDTO(row as never)
    expect(dto.actor).toBeNull()
    expect(dto.metadata).toBeNull()
    expect(dto.target).toBeNull()
  })

  it('emits metadata:null when row.metadata is undefined', () => {
    const row = {
      id: 'al1',
      accountId: 'acc1',
      action: 'a',
      target: null,
      createdAt: new Date(),
      actor: null,
    }
    expect(svc.toDTO(row as never).metadata).toBeNull()
  })
})
