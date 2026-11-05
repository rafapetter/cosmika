import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AiAllowanceService } from './ai-allowance.service'

function makePrisma() {
  return {
    account: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ plan: 'ROCKET', aiOverageCapBrl: null }),
    },
  }
}

function makeAiUsage() {
  return {
    aiConversationsCount: vi.fn().mockResolvedValue(0),
    hasRepliedThisMonth: vi.fn().mockResolvedValue(false),
    allowanceFor: vi.fn().mockResolvedValue({
      included: 300,
      overagePriceBrl: null,
      overridden: false,
    }),
  }
}

type Prisma = ReturnType<typeof makePrisma>
type AiUsage = ReturnType<typeof makeAiUsage>

const svc = (p: Prisma, a: AiUsage) =>
  new AiAllowanceService(p as never, a as never)

afterEach(() => {
  delete process.env.COSMIKA_AI_ALLOWANCE_ENFORCE
})

describe('AiAllowanceService.enforcing', () => {
  it('is off unless explicitly switched on', () => {
    const s = svc(makePrisma(), makeAiUsage())
    expect(s.enforcing()).toBe(false)
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '0'
    expect(s.enforcing()).toBe(false)
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = 'true'
    // Only the literal "1" counts: a typo must not silence customers' bots.
    expect(s.enforcing()).toBe(false)
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    expect(s.enforcing()).toBe(true)
  })
})

describe('AiAllowanceService.check', () => {
  let p: Prisma
  let a: AiUsage

  beforeEach(() => {
    p = makePrisma()
    a = makeAiUsage()
  })

  it('allows a conversation inside the allowance', async () => {
    a.aiConversationsCount.mockResolvedValue(10)
    const out = await svc(p, a).check('acc1', 'cv1')
    expect(out).toMatchObject({ allowed: true, reason: 'included', enforced: false })
  })

  it('observes without blocking by default, and says so in the reason', async () => {
    a.aiConversationsCount.mockResolvedValue(300)
    const out = await svc(p, a).check('acc1', 'cv1')
    // This is how the feature ships: the decision is computed and logged,
    // and the AI still answers, so two weeks of logs can be compared against
    // the ledger before anyone's bot is allowed to go quiet.
    expect(out).toMatchObject({
      allowed: true,
      reason: 'allowance_reached',
      enforced: false,
    })
  })

  it('blocks when enforcement is on', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    a.aiConversationsCount.mockResolvedValue(300)
    const out = await svc(p, a).check('acc1', 'cv1')
    expect(out).toMatchObject({
      allowed: false,
      reason: 'allowance_reached',
      enforced: true,
    })
  })

  it('skips both count queries entirely on a plan with no AI counter', async () => {
    // This runs on every inbound message of every conversation, so a PARTNER
    // account must not pay for two queries to be told it is unlimited.
    a.allowanceFor.mockResolvedValue({
      included: Number.POSITIVE_INFINITY,
      overagePriceBrl: null,
      overridden: false,
    })
    const out = await svc(p, a).check('acc1', 'cv1')
    expect(out).toMatchObject({ allowed: true, reason: 'uncounted' })
    expect(a.aiConversationsCount).not.toHaveBeenCalled()
    expect(a.hasRepliedThisMonth).not.toHaveBeenCalled()
  })

  it('keeps answering a conversation the AI already took this month', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    a.aiConversationsCount.mockResolvedValue(9_999)
    a.hasRepliedThisMonth.mockResolvedValue(true)
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({
      allowed: true,
      reason: 'already_counted',
    })
  })

  it('passes the customer ceiling through to the decision', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    p.account.findUnique.mockResolvedValue({
      plan: 'SPACESHIP',
      aiOverageCapBrl: '100.00',
    })
    a.allowanceFor.mockResolvedValue({
      included: 1_000,
      overagePriceBrl: 0.5,
      overridden: false,
    })
    a.aiConversationsCount.mockResolvedValue(1_200) // 200 over = R$ 100 spent
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({
      allowed: false,
      reason: 'cap_reached',
    })
  })

  it('fails open for an account that no longer exists', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    p.account.findUnique.mockResolvedValue(null)
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({
      allowed: true,
      reason: 'uncounted',
    })
  })

  it('fails open when the meter itself is broken', async () => {
    // An outage in our bookkeeping must never look to a customer like their
    // bot broke.
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    a.aiConversationsCount.mockRejectedValue(new Error('db down'))
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({ allowed: true })
  })

  it('fails open on a non-Error throw too', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    p.account.findUnique.mockRejectedValue('a string')
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({ allowed: true })
  })

  it('handles a legacy EXPLORER account rather than erroring on it', async () => {
    process.env.COSMIKA_AI_ALLOWANCE_ENFORCE = '1'
    p.account.findUnique.mockResolvedValue({
      plan: 'EXPLORER',
      aiOverageCapBrl: null,
    })
    a.allowanceFor.mockResolvedValue({
      included: 50,
      overagePriceBrl: null,
      overridden: false,
    })
    a.aiConversationsCount.mockResolvedValue(50)
    expect(await svc(p, a).check('acc1', 'cv1')).toMatchObject({
      allowed: false,
      reason: 'allowance_reached',
    })
  })
})
