import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutoResolveService, describeIdle } from './auto-resolve.service'

function makePrisma() {
  return {
    inbox: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma) {
  const realtime = { publish: vi.fn().mockResolvedValue(undefined) }
  const activity = { log: vi.fn().mockResolvedValue(undefined), actorName: vi.fn() }
  const svc = new AutoResolveService(prisma as never, realtime as never, activity as never)
  return { svc, realtime, activity }
}

const NOW = new Date('2026-08-06T12:00:00Z')
const INBOX = { id: 'inb1', accountId: 'acc1', autoResolveMinutes: 60 * 24 * 7 }
const CONV = { id: 'c1', inboxId: 'inb1', accountId: 'acc1' }

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.COSMIKA_AUTO_RESOLVE
})

describe('AutoResolveService', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('resolves an idle conversation, clears the assignee and notes it as system-driven', async () => {
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    prisma.conversation.findMany.mockResolvedValue([CONV])
    const { svc, realtime, activity } = makeService(prisma)

    expect(await svc.sweep(NOW)).toBe(1)

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'RESOLVED', resolvedAt: NOW, assigneeId: null },
    })
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ConversationStatusChanged', status: 'RESOLVED' }),
    )
    expect(activity.log).toHaveBeenCalledWith(
      CONV,
      expect.objectContaining({
        type: 'status',
        text: 'Conversation auto-resolved after 7 days of inactivity',
        actorName: 'Automation System',
      }),
    )
  })

  it('considers every conversation in progress with no message since the cutoff', async () => {
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    const { svc } = makeService(prisma)
    await svc.sweep(NOW)
    const where = prisma.conversation.findMany.mock.calls[0]![0].where
    // PENDING too: sparing it would leave conversations that never close.
    expect(where.status).toEqual({ in: ['OPEN', 'PENDING'] })
    // 7 days before NOW
    const cutoff = new Date('2026-07-30T12:00:00Z')
    expect(where.messages).toEqual({ none: { createdAt: { gte: cutoff } } })
    // A brand-new conversation with no messages must not be swept.
    expect(where.createdAt).toEqual({ lt: cutoff })
  })

  it('never waits longer than 7 days, whatever the inbox has stored', async () => {
    // 30 days, as an inbox configured before the ceiling existed would carry.
    prisma.inbox.findMany.mockResolvedValue([
      { id: 'inb1', accountId: 'acc1', autoResolveMinutes: 60 * 24 * 30 },
    ])
    prisma.conversation.findMany.mockResolvedValue([CONV])
    const { svc, activity } = makeService(prisma)
    await svc.sweep(NOW)
    const where = prisma.conversation.findMany.mock.calls[0]![0].where
    const sevenDaysBefore = new Date('2026-07-30T12:00:00Z')
    expect(where.createdAt).toEqual({ lt: sevenDaysBefore })
    expect(where.messages).toEqual({ none: { createdAt: { gte: sevenDaysBefore } } })
    // The transcript note states the window actually applied.
    expect(activity.log.mock.calls[0]![1].text).toBe(
      'Conversation auto-resolved after 7 days of inactivity',
    )
  })

  it('caps how many conversations one inbox can sweep per run', async () => {
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    const { svc } = makeService(prisma)
    await svc.sweep(NOW)
    expect(prisma.conversation.findMany.mock.calls[0]![0].take).toBe(200)
  })

  it('never triggers CSAT or webhooks (writes the status directly)', async () => {
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    prisma.conversation.findMany.mockResolvedValue([CONV])
    const { svc } = makeService(prisma)
    await svc.sweep(NOW)
    // The service has no csat/webhooks dependency at all — the constructor
    // takes exactly prisma, realtime and activity. This is the guard against
    // someone "fixing" it by routing through the normal resolve path, which
    // would survey thousands of long-silent customers.
    expect(AutoResolveService.length).toBe(3)
  })

  it('skips inboxes with auto-resolve disabled', async () => {
    const { svc } = makeService(prisma)
    await svc.sweep(NOW)
    expect(prisma.inbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { autoResolveMinutes: { gt: 0 } } }),
    )
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('sweeps every inbox with its own window', async () => {
    prisma.inbox.findMany.mockResolvedValue([
      INBOX,
      { id: 'inb2', accountId: 'acc1', autoResolveMinutes: 60 },
    ])
    prisma.conversation.findMany
      .mockResolvedValueOnce([CONV])
      .mockResolvedValueOnce([{ id: 'c2', inboxId: 'inb2', accountId: 'acc1' }])
    const { svc, activity } = makeService(prisma)
    expect(await svc.sweep(NOW)).toBe(2)
    expect(activity.log.mock.calls[1]![1].text).toBe(
      'Conversation auto-resolved after 1 hour of inactivity',
    )
  })

  it('the cron entrypoint honours the kill switch', async () => {
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    const { svc } = makeService(prisma)
    process.env.COSMIKA_AUTO_RESOLVE = '0'
    await svc.run()
    expect(prisma.inbox.findMany).not.toHaveBeenCalled()
    delete process.env.COSMIKA_AUTO_RESOLVE
    await svc.run()
    expect(prisma.inbox.findMany).toHaveBeenCalled()
  })

  it('the cron entrypoint swallows failures so the scheduler keeps running', async () => {
    prisma.inbox.findMany.mockRejectedValue(new Error('db down'))
    const { svc } = makeService(prisma)
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await expect(svc.run()).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    prisma.inbox.findMany.mockRejectedValue('a string')
    await expect(svc.run()).resolves.toBeUndefined()
  })

  it('logs a summary only when something was resolved', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    prisma.inbox.findMany.mockResolvedValue([INBOX])
    const { svc } = makeService(prisma)
    await svc.sweep(NOW)
    expect(log).not.toHaveBeenCalled()
    prisma.conversation.findMany.mockResolvedValue([CONV])
    await svc.sweep(NOW)
    expect(log).toHaveBeenCalledWith('auto-resolved 1 idle conversation(s)')
  })
})

describe('describeIdle', () => {
  it.each([
    [60 * 24 * 30, '30 days'],
    [60 * 24, '1 day'],
    [60 * 12, '12 hours'],
    [60, '1 hour'],
    [45, '45 minutes'],
    [1, '1 minute'],
  ])('%i minutes -> %s', (minutes, expected) => {
    expect(describeIdle(minutes)).toBe(expected)
  })
})
