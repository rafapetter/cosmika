import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingService } from './onboarding.service'

function makePrisma() {
  return {
    inbox: { findMany: vi.fn() },
    message: { findFirst: vi.fn() },
    accountMember: { count: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>

const HUMAN_INBOX = { agentBotId: null, aiAutoreplyMode: 'DRAFT', flowMode: 'OFF' }

/**
 * `accountMember.count` is called twice, in order: active people, then people
 * with a saved availability schedule. Answering both with one number made the
 * availability step mirror the team step.
 */
function counts(prisma: Prisma, people: number, onShift: number): void {
  prisma.accountMember.count
    .mockResolvedValueOnce(people)
    .mockResolvedValueOnce(onShift)
}

describe('OnboardingService.status', () => {
  let prisma: Prisma
  let svc: OnboardingService

  beforeEach(() => {
    prisma = makePrisma()
    svc = new OnboardingService(prisma as never)
  })

  it('reports nothing done on a brand-new account', async () => {
    prisma.inbox.findMany.mockResolvedValue([])
    prisma.message.findFirst.mockResolvedValue(null)
    counts(prisma, 1, 0)

    await expect(svc.status('acc1')).resolves.toEqual({
      steps: {
        channel: false,
        firstMessage: false,
        automation: false,
        team: false,
        availability: false,
      },
      completed: 0,
      total: 5,
    })
  })

  it('counts every step once the account is really set up', async () => {
    prisma.inbox.findMany.mockResolvedValue([
      HUMAN_INBOX,
      { agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_SAFE', flowMode: 'OFF' },
    ])
    prisma.message.findFirst.mockResolvedValue({ id: 'm1' })
    counts(prisma, 3, 2)

    await expect(svc.status('acc1')).resolves.toEqual({
      steps: {
        channel: true,
        firstMessage: true,
        automation: true,
        team: true,
        availability: true,
      },
      completed: 5,
      total: 5,
    })
  })

  it('treats a published flow mode as automation even without a bot', async () => {
    prisma.inbox.findMany.mockResolvedValue([
      { agentBotId: null, aiAutoreplyMode: 'DRAFT', flowMode: 'GUIDED' },
    ])
    prisma.message.findFirst.mockResolvedValue(null)
    counts(prisma, 1, 0)

    const res = await svc.status('acc1')
    expect(res.steps.automation).toBe(true)
    expect(res.completed).toBe(2)
  })

  it('does not count a bot that only drafts replies as automation', async () => {
    prisma.inbox.findMany.mockResolvedValue([
      { agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT', flowMode: 'OFF' },
    ])
    prisma.message.findFirst.mockResolvedValue(null)
    counts(prisma, 1, 0)

    expect((await svc.status('acc1')).steps.automation).toBe(false)
  })

  it('scopes every query to the account and ignores bot members', async () => {
    prisma.inbox.findMany.mockResolvedValue([])
    prisma.message.findFirst.mockResolvedValue(null)
    counts(prisma, 1, 0)

    await svc.status('acc9')

    expect(prisma.inbox.findMany.mock.calls[0]![0].where).toEqual({ accountId: 'acc9' })
    expect(prisma.message.findFirst.mock.calls[0]![0].where).toEqual({
      accountId: 'acc9',
      senderType: 'CONTACT',
    })
    expect(prisma.accountMember.count.mock.calls[0]![0].where).toEqual({
      accountId: 'acc9',
      isActive: true,
      role: { not: 'BOT' },
    })
    expect(prisma.accountMember.count.mock.calls[1]![0].where).toEqual({
      accountId: 'acc9',
      isActive: true,
      role: { not: 'BOT' },
      availabilities: { some: {} },
    })
  })

  // The step exists because automatic distribution only hands conversations
  // to agents whose schedule covers the moment: an account with a full team
  // and no schedules has every AI handoff land without an owner.
  it('a full team with no saved schedule leaves the availability step open', async () => {
    prisma.inbox.findMany.mockResolvedValue([HUMAN_INBOX])
    prisma.message.findFirst.mockResolvedValue({ id: 'm1' })
    counts(prisma, 5, 0)

    const res = await svc.status('acc1')
    expect(res.steps.team).toBe(true)
    expect(res.steps.availability).toBe(false)
  })

  it('one saved schedule is enough to tick it off', async () => {
    prisma.inbox.findMany.mockResolvedValue([HUMAN_INBOX])
    prisma.message.findFirst.mockResolvedValue(null)
    counts(prisma, 2, 1)

    expect((await svc.status('acc1')).steps.availability).toBe(true)
  })
})
