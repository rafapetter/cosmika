import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActivityService, SYSTEM_ACTOR } from './activity.service'

function makePrisma() {
  return {
    message: {
      create: vi.fn().mockResolvedValue({
        id: 'm1',
        content: 'Conversation resolved by Ana',
        createdAt: new Date('2026-08-06T10:00:00Z'),
      }),
    },
    user: { findUnique: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma) {
  const realtime = { publish: vi.fn().mockResolvedValue(undefined) }
  return { svc: new ActivityService(prisma as never, realtime as never), realtime }
}

const CONV = { id: 'c1', inboxId: 'inb1', accountId: 'acc1' }

afterEach(() => vi.restoreAllMocks())

describe('ActivityService.log', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('writes a public SYSTEM message carrying the structured activity', async () => {
    const { svc, realtime } = makeService(prisma)
    await svc.log(CONV, {
      type: 'status',
      text: 'Conversation resolved by Ana',
      actorName: 'Ana',
      from: 'OPEN',
      to: 'RESOLVED',
    })
    const data = prisma.message.create.mock.calls[0]![0].data
    expect(data).toMatchObject({
      conversationId: 'c1',
      inboxId: 'inb1',
      accountId: 'acc1',
      senderType: 'SYSTEM',
      contentType: 'TEXT',
      content: 'Conversation resolved by Ana',
      // Public: agents see it in the thread. It is NOT sent to the contact —
      // outbound delivery only happens on the explicit send path.
      isPrivate: false,
      status: 'SENT',
    })
    expect(data.contentAttributes).toEqual({
      activity: {
        type: 'status',
        actorName: 'Ana',
        from: 'OPEN',
        to: 'RESOLVED',
        reason: null,
      },
    })
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MessageCreated',
        senderType: 'SYSTEM',
        conversationId: 'c1',
        isPrivate: false,
      }),
    )
  })

  it('defaults the optional structured fields to null', async () => {
    const { svc } = makeService(prisma)
    await svc.log(CONV, { type: 'label', text: 'Label X added' })
    expect(prisma.message.create.mock.calls[0]![0].data.contentAttributes).toEqual({
      activity: {
        type: 'label',
        actorName: null,
        from: null,
        to: null,
        reason: null,
      },
    })
  })

  // Distribution sets this when an assignment only happened because nobody
  // was on shift, so a report is not left parsing the English text.
  it('carries a reason through to the structured facts', async () => {
    const { svc } = makeService(prisma)
    await svc.log(CONV, {
      type: 'assignee',
      text: 'Conversation assigned to Ana by Automation System (nobody on shift)',
      reason: 'no_agent_on_shift',
    })
    expect(
      prisma.message.create.mock.calls[0]![0].data.contentAttributes,
    ).toEqual({
      activity: {
        type: 'assignee',
        actorName: null,
        from: null,
        to: null,
        reason: 'no_agent_on_shift',
      },
    })
  })

  it('never throws, and never lets a realtime failure escape either', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    prisma.message.create.mockRejectedValue(new Error('db down'))
    const { svc } = makeService(prisma)
    await expect(svc.log(CONV, { type: 'status', text: 'x' })).resolves.toBeUndefined()

    prisma.message.create.mockRejectedValue('a string blow-up')
    await expect(svc.log(CONV, { type: 'status', text: 'x' })).resolves.toBeUndefined()

    const prisma2 = makePrisma()
    const svc2 = new ActivityService(prisma2 as never, {
      publish: vi.fn().mockRejectedValue(new Error('bus down')),
    } as never)
    await expect(svc2.log(CONV, { type: 'status', text: 'x' })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
  })
})

describe('ActivityService.actorName', () => {
  it('resolves a display name, or null for unknown/absent users', async () => {
    const prisma = makePrisma()
    const { svc } = makeService(prisma)
    prisma.user.findUnique.mockResolvedValue({ fullName: 'Ana Agent' })
    expect(await svc.actorName('u1')).toBe('Ana Agent')

    prisma.user.findUnique.mockResolvedValue(null)
    expect(await svc.actorName('u2')).toBeNull()

    prisma.user.findUnique.mockResolvedValue({ fullName: null })
    expect(await svc.actorName('u3')).toBeNull()

    // No user id at all (system-driven action) — no lookup at all.
    prisma.user.findUnique.mockClear()
    expect(await svc.actorName(null)).toBeNull()
    expect(await svc.actorName(undefined)).toBeNull()
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })
})

describe('ActivityService.by', () => {
  it('formats the attribution suffix', () => {
    expect(ActivityService.by('Ana')).toBe(' by Ana')
    expect(ActivityService.by(null)).toBe('')
    expect(ActivityService.by(SYSTEM_ACTOR)).toBe(' by Automation System')
  })
})
