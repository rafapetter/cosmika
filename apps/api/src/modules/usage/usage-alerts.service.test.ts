import { beforeEach, describe, expect, it, vi } from 'vitest'

import { alertEmail, alertFor, UsageAlertsService } from './usage-alerts.service'
import type { UsageEvaluation } from './usage.service'

/** A usage evaluation with nothing wrong, to be spread over in each test. */
function evaluation(overrides: Partial<UsageEvaluation> = {}): UsageEvaluation {
  return {
    plan: 'ROCKET',
    caps: {
      newConversationsPerMonth: 500,
      totalConversations: 5_000,
      contacts: 5_000,
      overageFraction: 0,
    },
    newConversationsThisMonth: 10,
    totalConversations: 100,
    contacts: 50,
    ai: {
      conversations: 0,
      included: 300,
      overagePriceBrl: null,
      capBrl: null,
      overConversations: 0,
      estimatedOverageBrl: 0,
      resetsAt: '2026-10-01T03:00:00.000Z',
    },
    state: 'ok',
    meters: [
      {
        key: 'newConversations',
        used: 10,
        cap: 500,
        absoluteLimit: 500,
        percent: 2,
        billableOver: 0,
      },
    ],
    warning: [],
    estimatedPlanOverageBrl: 0,
    ...overrides,
  }
}

describe('alertFor', () => {
  it('is silent when nothing is near a limit', () => {
    expect(alertFor(evaluation())).toBeNull()
  })

  it('warns at 90% of a plan meter', () => {
    expect(alertFor(evaluation({ warning: ['newConversations'] }))).toBe('plan_90')
  })

  it('reports a plan meter at its absolute limit', () => {
    expect(
      alertFor(
        evaluation({
          warning: ['newConversations'],
          meters: [
            {
              key: 'newConversations',
              used: 500,
              cap: 500,
              absoluteLimit: 500,
              percent: 100,
              billableOver: 0,
            },
          ],
        }),
      ),
    ).toBe('plan_100')
  })

  it('warns at 80% of the AI allowance', () => {
    expect(
      alertFor(evaluation({ ai: { ...evaluation().ai, conversations: 240 } })),
    ).toBe('ai_80')
  })

  it('reports an exhausted AI allowance', () => {
    expect(
      alertFor(evaluation({ ai: { ...evaluation().ai, conversations: 300 } })),
    ).toBe('ai_100')
  })

  it("puts the customer's own ceiling above everything else", () => {
    // They asked to be stopped at this number, so it is the thing that
    // actually changed for them, whatever else is also true.
    const kind = alertFor(
      evaluation({
        warning: ['contacts'],
        ai: {
          ...evaluation().ai,
          conversations: 1_200,
          included: 1_000,
          overagePriceBrl: 0.5,
          capBrl: 100,
          overConversations: 200,
        },
      }),
    )
    expect(kind).toBe('ai_cap')
  })

  it('never fires an AI alert on a plan with no AI counter', () => {
    expect(
      alertFor(
        evaluation({ ai: { ...evaluation().ai, included: null, conversations: 9_999 } }),
      ),
    ).toBeNull()
  })

  it('sends exactly one alert, the highest that applies', () => {
    // 90% of a meter AND 80% of the allowance AND the allowance spent: the
    // customer gets one email about the allowance, not three about
    // everything.
    expect(
      alertFor(
        evaluation({
          warning: ['contacts'],
          ai: { ...evaluation().ai, conversations: 300 },
        }),
      ),
    ).toBe('ai_100')
  })
})

describe('alertEmail', () => {
  it('writes every alert in Portuguese, Spanish and English', () => {
    const kinds = ['plan_90', 'plan_100', 'ai_80', 'ai_100', 'ai_cap'] as const
    for (const kind of kinds) {
      for (const locale of ['pt-BR', 'es', 'en']) {
        const { subject, body } = alertEmail(kind, 'Acme', evaluation(), locale)
        expect(subject.length).toBeGreaterThan(0)
        expect(body.length).toBeGreaterThan(0)
        // Never an em dash in customer-facing text, and never an internal id.
        expect(body).not.toContain('—')
        expect(body).not.toContain('acc1')
      }
    }
  })

  it('never tells the customer a conversation is blocked, because none is', () => {
    const pt = alertEmail('plan_100', 'Acme', evaluation(), 'pt-BR')
    expect(pt.body).toContain('Nenhuma conversa é bloqueada')
    const en = alertEmail('plan_90', 'Acme', evaluation(), 'en')
    expect(en.body).toContain('No conversation is blocked')
  })

  it('tells a Rocket customer the conversations go to their team', () => {
    // No overage on Rocket: above the allowance the AI stands down, and the
    // email has to say that rather than imply a bill.
    const { body } = alertEmail('ai_100', 'Acme', evaluation(), 'pt-BR')
    expect(body).toContain('passam direto para a sua')
  })

  it('tells a Spaceship customer the extra conversations are billed', () => {
    const usage = evaluation({
      ai: {
        ...evaluation().ai,
        included: 1_000,
        conversations: 1_000,
        overagePriceBrl: 0.5,
      },
    })
    expect(alertEmail('ai_100', 'Acme', usage, 'pt-BR').body).toContain('excedente')
    expect(alertEmail('ai_100', 'Acme', usage, 'es').body).toContain('excedente')
    expect(alertEmail('ai_100', 'Acme', usage, 'en').body).toContain('overage')
  })

  it('names the ceiling in the ai_cap email', () => {
    const usage = evaluation({ ai: { ...evaluation().ai, capBrl: 100 } })
    expect(alertEmail('ai_cap', 'Acme', usage, 'pt-BR').body).toContain('R$ 100.00')
    expect(alertEmail('ai_cap', 'Acme', usage, 'es').body).toContain('R$ 100.00')
    expect(alertEmail('ai_cap', 'Acme', usage, 'en').body).toContain('R$ 100.00')
  })

  it('falls back to a zero ceiling rather than printing undefined', () => {
    expect(alertEmail('ai_cap', 'Acme', evaluation(), 'en').body).toContain('R$ 0.00')
  })

  it('prints a zero allowance rather than undefined on an uncounted plan', () => {
    // alertFor never picks an AI alert for a plan with no counter, so this is
    // only reachable by a caller passing one in. Print a number anyway: an
    // email that says "0 of undefined" is a bug report, not a warning.
    const usage = evaluation({ ai: { ...evaluation().ai, included: null } })
    expect(alertEmail('ai_80', 'Acme', usage, 'en').body).toContain('the 0 conversations')
  })

  it('quotes the estimated overage in the plan_100 email', () => {
    const usage = evaluation({ estimatedPlanOverageBrl: 60 })
    expect(alertEmail('plan_100', 'Acme', usage, 'pt-BR').body).toContain('R$ 60.00')
    expect(alertEmail('plan_100', 'Acme', usage, 'es').body).toContain('R$ 60.00')
    expect(alertEmail('plan_100', 'Acme', usage, 'en').body).toContain('R$ 60.00')
  })
})

function makePrisma() {
  return {
    account: { findMany: vi.fn().mockResolvedValue([]) },
    accountMember: { findMany: vi.fn().mockResolvedValue([]) },
    usageAlert: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'ua1' }),
    },
  }
}

function makeUsage() {
  return { evaluate: vi.fn().mockResolvedValue(evaluation()) }
}

function makeEmail() {
  return { send: vi.fn().mockResolvedValue(true) }
}

type Prisma = ReturnType<typeof makePrisma>
type Usage = ReturnType<typeof makeUsage>
type Email = ReturnType<typeof makeEmail>

const svc = (p: Prisma, u: Usage, e: Email) =>
  new UsageAlertsService(p as never, u as never, e as never)

const ACCOUNT = { id: 'acc1', name: 'Acme', defaultLocale: 'pt-BR' }

describe('UsageAlertsService.sweep', () => {
  let p: Prisma
  let u: Usage
  let e: Email

  beforeEach(() => {
    p = makePrisma()
    u = makeUsage()
    e = makeEmail()
  })

  it('sends nothing when no account is near a limit', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    expect(await svc(p, u, e).sweep()).toEqual([])
    expect(e.send).not.toHaveBeenCalled()
    expect(p.usageAlert.create).not.toHaveBeenCalled()
  })

  it('emails every administrator once, and records what it sent', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    p.accountMember.findMany.mockResolvedValue([
      { user: { email: 'a@acme.com' } },
      { user: { email: 'b@acme.com' } },
    ])
    u.evaluate.mockResolvedValue(evaluation({ warning: ['contacts'] }))

    const sent = await svc(p, u, e).sweep(new Date('2026-09-17T12:00:00Z'))
    expect(sent).toEqual([{ accountId: 'acc1', kind: 'plan_90' }])
    expect(e.send).toHaveBeenCalledTimes(2)
    expect(p.usageAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: 'acc1',
        month: '2026-09',
        kind: 'plan_90',
      }),
    })
  })

  it('never repeats an alert already sent this month', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    p.usageAlert.findUnique.mockResolvedValue({ id: 'ua1' })
    u.evaluate.mockResolvedValue(evaluation({ warning: ['contacts'] }))
    expect(await svc(p, u, e).sweep()).toEqual([])
    expect(e.send).not.toHaveBeenCalled()
  })

  it('records the alert before sending it, so a crash costs one warning and not a mailbox', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    p.accountMember.findMany.mockResolvedValue([{ user: { email: 'a@acme.com' } }])
    u.evaluate.mockResolvedValue(evaluation({ warning: ['contacts'] }))
    const order: string[] = []
    p.usageAlert.create.mockImplementation(async () => {
      order.push('record')
      return { id: 'ua1' }
    })
    e.send.mockImplementation(async () => {
      order.push('send')
      return true
    })
    await svc(p, u, e).sweep()
    expect(order).toEqual(['record', 'send'])
  })

  it('logs and carries on when an account has nobody to tell', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    u.evaluate.mockResolvedValue(evaluation({ warning: ['contacts'] }))
    p.accountMember.findMany.mockResolvedValue([])
    expect(await svc(p, u, e).sweep()).toEqual([{ accountId: 'acc1', kind: 'plan_90' }])
    expect(e.send).not.toHaveBeenCalled()
  })

  it('one broken account does not stop the others', async () => {
    p.account.findMany.mockResolvedValue([
      { id: 'bad', name: 'Bad', defaultLocale: 'pt-BR' },
      ACCOUNT,
    ])
    p.accountMember.findMany.mockResolvedValue([{ user: { email: 'a@acme.com' } }])
    u.evaluate
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(evaluation({ warning: ['contacts'] }))
    expect(await svc(p, u, e).sweep()).toEqual([{ accountId: 'acc1', kind: 'plan_90' }])
  })

  it('survives a non-Error throw', async () => {
    p.account.findMany.mockResolvedValue([ACCOUNT])
    u.evaluate.mockRejectedValue('a string')
    expect(await svc(p, u, e).sweep()).toEqual([])
  })

  it('only looks at ACTIVE accounts', async () => {
    await svc(p, u, e).sweep()
    expect(p.account.findMany.mock.calls[0]![0].where).toEqual({ status: 'ACTIVE' })
  })
})

describe('UsageAlertsService.hourly', () => {
  it('logs what it sent', async () => {
    const p = makePrisma()
    const u = makeUsage()
    const e = makeEmail()
    p.account.findMany.mockResolvedValue([ACCOUNT])
    p.accountMember.findMany.mockResolvedValue([{ user: { email: 'a@acme.com' } }])
    u.evaluate.mockResolvedValue(evaluation({ warning: ['contacts'] }))
    await expect(svc(p, u, e).hourly()).resolves.toBeUndefined()
  })

  it('swallows a failure so the scheduler survives', async () => {
    const p = makePrisma()
    p.account.findMany.mockRejectedValue(new Error('db down'))
    await expect(svc(p, makeUsage(), makeEmail()).hourly()).resolves.toBeUndefined()
  })

  it('swallows a non-Error failure too', async () => {
    const p = makePrisma()
    p.account.findMany.mockRejectedValue('a string')
    await expect(svc(p, makeUsage(), makeEmail()).hourly()).resolves.toBeUndefined()
  })
})
