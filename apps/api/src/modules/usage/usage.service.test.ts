import { HttpStatus } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import {
  estimatePlanOverageBrl,
  ImportTooLargeException,
  nextPlanUp,
  UsageService,
} from './usage.service'

function makePrisma() {
  return {
    account: { findUnique: vi.fn() },
    conversation: { count: vi.fn() },
    contact: { count: vi.fn() },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeAiUsage() {
  return {
    aiConversationsCount: vi.fn().mockResolvedValue(0),
    allowanceFor: vi.fn().mockResolvedValue({
      included: 300,
      overagePriceBrl: null,
      overridden: false,
    }),
  }
}

type AiUsage = ReturnType<typeof makeAiUsage>

function makeService(prisma: Prisma, aiUsage: AiUsage = makeAiUsage()): UsageService {
  return new UsageService(prisma as never, aiUsage as never)
}

/** The plan's own allowance, so a test does not have to restate it. */
function allowanceOf(plan: string): {
  included: number
  overagePriceBrl: number | null
} {
  switch (plan) {
    case 'SPACESHIP':
      return { included: 1_000, overagePriceBrl: 0.5 }
    case 'ENTERPRISE':
      return { included: 3_000, overagePriceBrl: 0.4 }
    case 'EXPLORER':
      return { included: 50, overagePriceBrl: null }
    case 'JETPACK':
      return { included: 100, overagePriceBrl: null }
    case 'PARTNER':
    case 'MASTER':
      return { included: Number.POSITIVE_INFINITY, overagePriceBrl: null }
    default:
      return { included: 300, overagePriceBrl: null }
  }
}

/** Wire the whole fixture for one account, in one line per test. */
function setup(opts: {
  plan: string
  newConversations?: number
  totalConversations?: number
  contacts?: number
  aiConversations?: number
  capBrl?: number | null
}) {
  const prisma = makePrisma()
  const aiUsage = makeAiUsage()
  prisma.account.findUnique.mockResolvedValue({
    plan: opts.plan,
    aiOverageCapBrl: opts.capBrl === undefined ? null : opts.capBrl,
  })
  prisma.conversation.count
    .mockResolvedValueOnce(opts.newConversations ?? 0)
    .mockResolvedValueOnce(opts.totalConversations ?? 0)
  prisma.contact.count.mockResolvedValue(opts.contacts ?? 0)
  aiUsage.aiConversationsCount.mockResolvedValue(opts.aiConversations ?? 0)
  aiUsage.allowanceFor.mockResolvedValue({
    ...allowanceOf(opts.plan),
    overridden: false,
  })
  return { svc: makeService(prisma, aiUsage), prisma, aiUsage }
}

describe('UsageService.getUsage', () => {
  it('throws PaymentRequired (402) when the account is missing', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue(null)
    try {
      await makeService(prisma).getUsage('missing')
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as { getStatus(): number }).getStatus()).toBe(
        HttpStatus.PAYMENT_REQUIRED,
      )
    }
  })

  it('returns the usage bundle for a ROCKET account', async () => {
    const { svc } = setup({
      plan: 'ROCKET',
      newConversations: 42,
      totalConversations: 3_000,
      contacts: 2_500,
      aiConversations: 120,
    })
    const out = await svc.getUsage('acc1')
    expect(out.plan).toBe('ROCKET')
    expect(out.caps.newConversationsPerMonth).toBe(500)
    expect(out.caps.totalConversations).toBe(5_000)
    expect(out.caps.contacts).toBe(5_000)
    expect(out.newConversationsThisMonth).toBe(42)
    expect(out.totalConversations).toBe(3_000)
    expect(out.contacts).toBe(2_500)
    expect(out.ai.conversations).toBe(120)
    expect(out.ai.included).toBe(300)
    // Rocket has no AI overage at all: above the allowance the AI stands
    // down, so there is no price and nothing to estimate.
    expect(out.ai.overagePriceBrl).toBeNull()
    expect(out.ai.estimatedOverageBrl).toBe(0)
  })

  it('counts new conversations by billableAt, in the São Paulo month', async () => {
    const { svc, prisma } = setup({ plan: 'SPACESHIP' })
    vi.setSystemTime(new Date('2026-08-17T13:00:00Z'))
    await svc.getUsage('acc1')
    const where = prisma.conversation.count.mock.calls[0]![0].where
    expect(where.accountId).toBe('acc1')
    // 1 August 00:00 in São Paulo is 03:00 UTC. Counting from 00:00 UTC put
    // the last three hours of July into August's invoice.
    expect((where.billableAt.gte as Date).toISOString()).toBe(
      '2026-08-01T03:00:00.000Z',
    )
    expect(where.createdAt).toBeUndefined()
    vi.useRealTimers()
  })

  it('prices Spaceship AI overage and respects the customer ceiling', async () => {
    const { svc } = setup({
      plan: 'SPACESHIP',
      aiConversations: 1_500,
      capBrl: 100,
    })
    const out = await svc.getUsage('acc1')
    expect(out.ai.overConversations).toBe(500)
    // 500 × R$ 0,50 = R$ 250, but the customer asked to be stopped at R$ 100.
    // Showing R$ 250 would be telling them something we will not charge.
    expect(out.ai.estimatedOverageBrl).toBe(100)
  })

  it('estimates the full Spaceship AI overage when no ceiling is set', async () => {
    const { svc } = setup({
      plan: 'SPACESHIP',
      aiConversations: 1_200,
      capBrl: null,
    })
    expect((await svc.getUsage('acc1')).ai.estimatedOverageBrl).toBe(100)
  })

  it('handles a legacy EXPLORER account without blowing up', async () => {
    // 34 of these exist in production, all abandoned signups. Nothing is
    // created on EXPLORER any more, but every calculation still has to answer
    // for the ones that are on it.
    const { svc } = setup({
      plan: 'EXPLORER',
      newConversations: 3,
      totalConversations: 12,
      contacts: 5,
      aiConversations: 60,
    })
    const out = await svc.getUsage('acc1')
    expect(out.caps.newConversationsPerMonth).toBe(50)
    expect(out.ai.included).toBe(50)
    expect(out.ai.overConversations).toBe(10)
    // No overage price on a legacy tier: nothing is ever billed for it.
    expect(out.ai.estimatedOverageBrl).toBe(0)
  })

  it('treats PARTNER and MASTER as uncounted rather than unlimited-and-zero', async () => {
    for (const plan of ['PARTNER', 'MASTER']) {
      const { svc } = setup({ plan, aiConversations: 99_999 })
      const out = await svc.getUsage('acc1')
      expect(out.caps.newConversationsPerMonth).toBe(Infinity)
      // `included: null` on the wire means "this account has no AI counter",
      // which the UI renders as a number with no denominator.
      expect(out.ai.included).toBeNull()
      expect(out.ai.overConversations).toBe(0)
      expect(out.ai.estimatedOverageBrl).toBe(0)
    }
  })

  it('reports the date the allowance resets', async () => {
    vi.setSystemTime(new Date('2026-08-17T13:00:00Z'))
    const { svc } = setup({ plan: 'ROCKET' })
    expect((await svc.getUsage('acc1')).ai.resetsAt).toBe('2026-09-01T03:00:00.000Z')
    vi.useRealTimers()
  })
})

describe('UsageService.evaluate', () => {
  it('is ok well below every limit', async () => {
    const { svc } = setup({
      plan: 'ROCKET',
      newConversations: 10,
      totalConversations: 100,
      contacts: 50,
      aiConversations: 5,
    })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('ok')
    expect(out.warning).toEqual([])
    expect(out.estimatedPlanOverageBrl).toBe(0)
  })

  it('warns at 90% of a plan meter, worst meter first', async () => {
    const { svc } = setup({
      plan: 'ROCKET',
      newConversations: 460, // 92%
      totalConversations: 4_800, // 96%
      contacts: 100,
    })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('warn')
    expect(out.warning).toEqual(['totalConversations', 'newConversations'])
  })

  it('offers an upgrade on ROCKET at 100%, where the cap IS the absolute limit', async () => {
    const { svc } = setup({ plan: 'ROCKET', newConversations: 500 })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('upgrade')
    // Nothing is blocked; the state only decides which banner is shown.
    expect(out.meters[0]!.billableOver).toBe(0)
  })

  it('reports Spaceship between 100% and 150% as billable overage, not an upgrade', async () => {
    const { svc } = setup({ plan: 'SPACESHIP', newConversations: 1_800 })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('overage')
    expect(out.meters[0]!.billableOver).toBe(300)
    // 300 × R$ 0,20.
    expect(out.estimatedPlanOverageBrl).toBe(60)
  })

  it('offers an upgrade once Spaceship passes 150%', async () => {
    const { svc } = setup({ plan: 'SPACESHIP', newConversations: 2_300 })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('upgrade')
    // Billing stops at 150% even though usage did not (decision 2).
    expect(out.meters[0]!.billableOver).toBe(750)
  })

  it('never reaches an absolute limit on ENTERPRISE', async () => {
    const { svc } = setup({
      plan: 'ENTERPRISE',
      newConversations: 50_000,
      aiConversations: 10,
    })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('overage')
    expect(out.meters[0]!.absoluteLimit).toBeNull()
  })

  it('warns at 80% of the AI allowance', async () => {
    const { svc } = setup({ plan: 'ROCKET', aiConversations: 240 })
    expect((await svc.evaluate('acc1')).state).toBe('warn')
  })

  it('offers an upgrade when the AI allowance runs out on a plan with no overage', async () => {
    const { svc } = setup({ plan: 'ROCKET', aiConversations: 300 })
    expect((await svc.evaluate('acc1')).state).toBe('upgrade')
  })

  it('calls an exhausted Spaceship AI allowance overage, not an upgrade', async () => {
    const { svc } = setup({ plan: 'SPACESHIP', aiConversations: 1_100 })
    expect((await svc.evaluate('acc1')).state).toBe('overage')
  })

  it('leaves an uncapped plan with no percentages to warn about', async () => {
    const { svc } = setup({ plan: 'PARTNER', newConversations: 900_000 })
    const out = await svc.evaluate('acc1')
    expect(out.state).toBe('ok')
    expect(out.meters.every((m) => m.percent === null)).toBe(true)
  })
})

describe('UsageService.assertImportWithinAbsoluteLimit', () => {
  it('allows a batch that fits', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ plan: 'ROCKET' })
    prisma.contact.count.mockResolvedValue(4_000)
    await expect(
      makeService(prisma).assertImportWithinAbsoluteLimit('acc1', 500),
    ).resolves.toBeUndefined()
  })

  it('rejects a batch that would cross the absolute limit, before writing a row', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ plan: 'ROCKET' })
    prisma.contact.count.mockResolvedValue(4_900)
    try {
      await makeService(prisma).assertImportWithinAbsoluteLimit('acc1', 500)
      expect.fail('should have thrown')
    } catch (e) {
      const err = e as ImportTooLargeException
      expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      // The response names the plan that would fit, so the message can offer
      // it instead of just refusing.
      expect(err.detail).toMatchObject({
        current: 4_900,
        incoming: 500,
        limit: 5_000,
        plan: 'ROCKET',
        suggestedPlan: 'SPACESHIP',
      })
    }
  })

  it('lets Spaceship import up to 150% of its cap', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ plan: 'SPACESHIP' })
    prisma.contact.count.mockResolvedValue(22_000)
    const svc = makeService(prisma)
    await expect(svc.assertImportWithinAbsoluteLimit('acc1', 500)).resolves
      .toBeUndefined()
    await expect(
      svc.assertImportWithinAbsoluteLimit('acc1', 1_000),
    ).rejects.toThrow(/past the 22500/)
  })

  it('never refuses an import on ENTERPRISE, and never counts to decide', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ plan: 'ENTERPRISE' })
    await expect(
      makeService(prisma).assertImportWithinAbsoluteLimit('acc1', 1_000_000),
    ).resolves.toBeUndefined()
    expect(prisma.contact.count).not.toHaveBeenCalled()
  })

  it('applies the legacy EXPLORER limit without error', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ plan: 'EXPLORER' })
    prisma.contact.count.mockResolvedValue(400)
    await expect(
      makeService(prisma).assertImportWithinAbsoluteLimit('acc1', 200),
    ).rejects.toMatchObject({ detail: { limit: 500, suggestedPlan: 'ROCKET' } })
  })

  it('throws 402 when the account is gone', async () => {
    const prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).assertImportWithinAbsoluteLimit('acc1', 1),
    ).rejects.toMatchObject({ message: 'Account not found' })
  })
})

describe('estimatePlanOverageBrl', () => {
  const meter = (
    key: 'newConversations' | 'totalConversations' | 'contacts',
    billableOver: number,
  ) => ({
    key,
    used: 0,
    cap: 0,
    absoluteLimit: null,
    percent: null,
    billableOver,
  })

  it('is zero with nothing over cap', () => {
    expect(
      estimatePlanOverageBrl([meter('newConversations', 0), meter('contacts', 0)]),
    ).toBe(0)
  })

  it('prices new conversations per unit', () => {
    expect(estimatePlanOverageBrl([meter('newConversations', 300)])).toBe(60)
  })

  it('prices the stock meters per thousand, rounding a part up', () => {
    // 1.200 stored conversations over → 2 × R$ 10; 100 contacts over → 1 × R$ 5.
    expect(
      estimatePlanOverageBrl([
        meter('totalConversations', 1_200),
        meter('contacts', 100),
      ]),
    ).toBe(25)
  })
})

describe('nextPlanUp', () => {
  it('points the legacy tiers at ROCKET, the only plan a new account gets', () => {
    expect(nextPlanUp('EXPLORER')).toBe('ROCKET')
    expect(nextPlanUp('JETPACK')).toBe('ROCKET')
  })

  it('climbs the paid ladder', () => {
    expect(nextPlanUp('ROCKET')).toBe('SPACESHIP')
    expect(nextPlanUp('SPACESHIP')).toBe('ENTERPRISE')
  })

  it('has nothing to offer above ENTERPRISE or on an internal plan', () => {
    expect(nextPlanUp('ENTERPRISE')).toBeNull()
    expect(nextPlanUp('PARTNER')).toBeNull()
    expect(nextPlanUp('MASTER')).toBeNull()
  })
})
