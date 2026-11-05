import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RetentionService } from './retention.service'

function makePrisma() {
  return {
    webhookDelivery: { deleteMany: vi.fn() },
    auditLog: { deleteMany: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>
function makeService(prisma: Prisma) {
  return new RetentionService(prisma as never)
}

describe('RetentionService.pruneWebhookDeliveries', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('deletes deliveries older than 30 days and returns the count', async () => {
    let where: { createdAt: { lt: Date } } | null = null
    prisma.webhookDelivery.deleteMany.mockImplementation(async (args) => {
      where = args.where
      return { count: 42 }
    })
    const before = Date.now()
    const out = await makeService(prisma).pruneWebhookDeliveries()
    const after = Date.now()
    expect(out).toBe(42)
    // Cutoff is "now - 30 days". It should sit between the snapshots we took.
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    expect(where!.createdAt.lt.getTime()).toBeGreaterThanOrEqual(before - thirtyDaysMs - 5)
    expect(where!.createdAt.lt.getTime()).toBeLessThanOrEqual(after - thirtyDaysMs + 5)
  })
})

describe('RetentionService.pruneAuditLogs', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('deletes audit logs older than 90 days and returns the count', async () => {
    let where: { createdAt: { lt: Date } } | null = null
    prisma.auditLog.deleteMany.mockImplementation(async (args) => {
      where = args.where
      return { count: 137 }
    })
    const before = Date.now()
    const out = await makeService(prisma).pruneAuditLogs()
    const after = Date.now()
    expect(out).toBe(137)
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
    expect(where!.createdAt.lt.getTime()).toBeGreaterThanOrEqual(before - ninetyDaysMs - 5)
    expect(where!.createdAt.lt.getTime()).toBeLessThanOrEqual(after - ninetyDaysMs + 5)
  })
})

describe('RetentionService.runDaily', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('calls both prune methods and aggregates results', async () => {
    prisma.webhookDelivery.deleteMany.mockResolvedValue({ count: 10 })
    prisma.auditLog.deleteMany.mockResolvedValue({ count: 5 })
    const svc = makeService(prisma)
    await svc.runDaily()
    expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalled()
    expect(prisma.auditLog.deleteMany).toHaveBeenCalled()
  })

  it('catches errors so the cron does not crash the process', async () => {
    prisma.webhookDelivery.deleteMany.mockRejectedValue(new Error('DB down'))
    const svc = makeService(prisma)
    await expect(svc.runDaily()).resolves.toBeUndefined()
  })

  it('handles non-Error throwables in the catch block', async () => {
    prisma.webhookDelivery.deleteMany.mockRejectedValue('a string')
    const svc = makeService(prisma)
    await expect(svc.runDaily()).resolves.toBeUndefined()
  })

  it('is a no-op if a previous run is still in-flight (running guard)', async () => {
    let resolveFirst: (v: { count: number }) => void = () => undefined
    prisma.webhookDelivery.deleteMany.mockReturnValue(
      new Promise((res) => { resolveFirst = res }),
    )
    prisma.auditLog.deleteMany.mockResolvedValue({ count: 0 })
    const svc = makeService(prisma)
    const first = svc.runDaily()
    // While first is in-flight, a second invocation should bail immediately.
    await svc.runDaily()
    expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalledTimes(1)
    resolveFirst({ count: 0 })
    await first
  })
})
