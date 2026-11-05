import { describe, expect, it, vi } from 'vitest'

import {
  BILLABLE_PLANS,
  OverageService,
  monthWindow,
  previousMonth,
} from './overage.service'

function makePrisma() {
  return {
    account: { findMany: vi.fn() },
    conversation: { count: vi.fn() },
    contact: { count: vi.fn() },
  }
}
function makeBilling() {
  return {
    postOverageReport: vi.fn(async () => true),
    postAiOverageReport: vi.fn(async () => true),
  }
}
function makeAiUsage() {
  return {
    aiConversationsCount: vi.fn(async () => 0),
    costThisMonth: vi.fn(async () => 0),
    allowanceFor: vi.fn(async () => ({
      included: 1_000,
      overagePriceBrl: 0.5,
      overridden: false,
    })),
  }
}
const svc = (p = makePrisma(), b = makeBilling(), a = makeAiUsage()) =>
  new OverageService(p as never, b as never, a as never)

describe('monthWindow / previousMonth', () => {
  it('parses YYYY-MM into a São Paulo calendar window', () => {
    // The billing month is Brazilian, not UTC (decision 14): counting in UTC
    // put the first three hours of every Brazilian day in the previous month,
    // which is enough to move a conversation across an invoice boundary.
    const w = monthWindow('2026-08')!
    expect(w.start.toISOString()).toBe('2026-08-01T03:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })

  it('rejects malformed months', () => {
    expect(monthWindow('2026-13')).toBeNull()
    expect(monthWindow('26-08')).toBeNull()
    expect(monthWindow('2026-08-01')).toBeNull()
  })

  it('previousMonth crosses the year boundary', () => {
    expect(previousMonth(new Date('2026-01-15T12:00:00Z'))).toBe('2025-12')
    expect(previousMonth(new Date('2026-08-02T06:10:00Z'))).toBe('2026-07')
  })
})

describe('OverageService.computeMonth', () => {
  it('reports every account, with billablePlan saying which could owe anything', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'Ship', plan: 'SPACESHIP', createdAt: new Date('2026-01-01') },
      { id: 'a2', name: 'Rock', plan: 'ROCKET', createdAt: new Date('2026-02-01') },
      { id: 'a3', name: 'Old', plan: 'EXPLORER', createdAt: new Date('2026-07-18') },
    ])
    p.conversation.count.mockResolvedValue(0)
    p.contact.count.mockResolvedValue(0)
    const rows = await svc(p).computeMonth('2026-08')
    // Nothing is over anything, and all three are still reported: the preview
    // panel shows where every account stands, and a row that quietly
    // disappears is indistinguishable from a broken cron.
    expect(rows.map((r) => [r.accountId, r.billablePlan])).toEqual([
      ['a1', true],
      ['a2', false],
      ['a3', false],
    ])
    // No plan filter in the query at all.
    expect(p.account.findMany.mock.calls[0]![0]).not.toHaveProperty('where')
  })

  it('meters a legacy EXPLORER account against its own caps without erroring', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      { id: 'a3', name: 'Old', plan: 'EXPLORER', createdAt: new Date('2026-07-18') },
    ])
    p.conversation.count.mockResolvedValueOnce(80).mockResolvedValueOnce(0)
    p.contact.count.mockResolvedValue(0)
    const [row] = await svc(p).computeMonth('2026-08')
    // EXPLORER caps new conversations at 50 and has no overage tolerance, so
    // the absolute limit is the cap and the whole excess is "over". It is
    // reported and never invoiced, which is cosmo-admin's call, not ours.
    // `over` is what would be BILLED, and a plan with no overage tolerance
    // bills nothing however far past the cap it goes: Rocket and the legacy
    // tiers are offered an upgrade instead. `used` and `cap` are what the
    // preview panel draws the position from.
    expect(row!.meters.newConversations).toEqual({ used: 80, cap: 50, over: 0 })
    expect(row!.billablePlan).toBe(false)
  })

  it('meters PARTNER and MASTER as uncapped, with nothing over', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      { id: 'p1', name: 'P', plan: 'PARTNER', createdAt: new Date() },
      { id: 'm1', name: 'M', plan: 'MASTER', createdAt: new Date() },
    ])
    p.conversation.count.mockResolvedValue(999_999)
    p.contact.count.mockResolvedValue(999_999)
    const rows = await svc(p).computeMonth('2026-08')
    for (const r of rows) {
      expect(r.meters.newConversations.over).toBe(0)
      expect(r.meters.contacts.over).toBe(0)
    }
  })

  it('meters each plan against its own caps', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      {
        id: 'a1',
        name: 'Hot',
        plan: 'SPACESHIP',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'a2',
        name: 'Cold',
        plan: 'ENTERPRISE',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])
    // a1: 1.700 new conversations (cap 1.500) → over 200; stocks under cap.
    // a2: everything under cap → over 0, still reported.
    p.conversation.count
      .mockResolvedValueOnce(1_700) // a1 new
      .mockResolvedValueOnce(9_000) // a1 total (cap 15k)
      .mockResolvedValueOnce(100) // a2 new (cap 5k)
      .mockResolvedValueOnce(1_000) // a2 total (cap 50k)
    p.contact.count
      .mockResolvedValueOnce(2_000) // a1 (cap 15k)
      .mockResolvedValueOnce(500) // a2 (cap 50k)
    const rows = await svc(p).computeMonth('2026-08')
    // Spaceship and Enterprise are the two plans whose terms allow paid
    // overage; the constant stays as documentation of that, and the report
    // no longer filters on it.
    expect([...BILLABLE_PLANS]).toEqual(['SPACESHIP', 'ENTERPRISE'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      accountId: 'a1',
      plan: 'SPACESHIP',
      meters: {
        newConversations: { used: 1_700, cap: 1_500, over: 200 },
        totalConversations: { used: 9_000, cap: 15_000, over: 0 },
        contacts: { used: 2_000, cap: 15_000, over: 0 },
      },
    })
  })

  it('meters new conversations by billableAt, not by creation', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'X', plan: 'SPACESHIP', createdAt: new Date() },
    ])
    p.conversation.count.mockResolvedValue(0)
    p.contact.count.mockResolvedValue(0)
    await svc(p).computeMonth('2026-08')
    // `billableAt` is what the terms actually describe: an unanswered
    // broadcast, a forward and an imported history are all rows the customer
    // did not generate as new work, and counting `createdAt` billed them.
    const newArgs = p.conversation.count.mock.calls[0][0].where.billableAt
    expect(newArgs.gte.toISOString()).toBe('2026-08-01T03:00:00.000Z')
    expect(newArgs.lt.toISOString()).toBe('2026-09-01T03:00:00.000Z')
    // Stock meter counts everything created before the window's END.
    const totalArgs = p.conversation.count.mock.calls[1][0].where.createdAt
    expect(totalArgs.lt.toISOString()).toBe('2026-09-01T03:00:00.000Z')
    expect(totalArgs.gte).toBeUndefined()
  })

  it('caps Spaceship overage at 150% of the cap, and never caps Enterprise', async () => {
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'Ship', plan: 'SPACESHIP', createdAt: new Date() },
    ])
    // 4.000 new conversations on a 1.500 cap: 2.500 over, but the terms bill
    // "between 100% and 150%" and offer an upgrade above that (decision 2).
    p.conversation.count.mockResolvedValueOnce(4_000).mockResolvedValueOnce(0)
    p.contact.count.mockResolvedValue(0)
    const [row] = await svc(p).computeMonth('2026-08')
    expect(row!.meters.newConversations.over).toBe(750)

    const p2 = makePrisma()
    p2.account.findMany.mockResolvedValue([
      { id: 'a2', name: 'Ent', plan: 'ENTERPRISE', createdAt: new Date() },
    ])
    p2.conversation.count.mockResolvedValueOnce(20_000).mockResolvedValueOnce(0)
    p2.contact.count.mockResolvedValue(0)
    const [ent] = await svc(p2).computeMonth('2026-08')
    expect(ent!.meters.newConversations.over).toBe(15_000)
  })

  it('rejects an invalid month instead of metering garbage', async () => {
    await expect(svc().computeMonth('nope')).rejects.toThrow(/invalid month/)
  })
})

describe('OverageService.report', () => {
  it('posts quantities for the previous month by default', async () => {
    const p = makePrisma()
    const b = makeBilling()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'X', plan: 'SPACESHIP', createdAt: new Date('2026-06-01') },
    ])
    p.conversation.count.mockResolvedValueOnce(1_600).mockResolvedValueOnce(0)
    p.contact.count.mockResolvedValueOnce(0)
    const out = await svc(p, b).report('2026-07')
    expect(out).toMatchObject({ month: '2026-07', accounts: 1, posted: true })
    expect(b.postOverageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        month: '2026-07',
        dry: false,
        accounts: [expect.objectContaining({ accountId: 'a1' })],
      }),
    )
  })

  it('does not call the billing API when nothing is over cap', async () => {
    const p = makePrisma()
    const b = makeBilling()
    p.account.findMany.mockResolvedValue([])
    const out = await svc(p, b).report('2026-07')
    expect(out.posted).toBe(false)
    expect(b.postOverageReport).not.toHaveBeenCalled()
  })

  it('meters the previous billing month when none is given', async () => {
    vi.setSystemTime(new Date('2026-09-02T09:10:00Z'))
    const p = makePrisma()
    p.account.findMany.mockResolvedValue([])
    expect((await svc(p).report()).month).toBe('2026-08')
    vi.useRealTimers()
  })

  it('the cron meters the closed month on a normal night', async () => {
    vi.setSystemTime(new Date('2026-09-02T09:10:00Z'))
    const p = makePrisma()
    const b = makeBilling()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'X', plan: 'SPACESHIP', createdAt: new Date('2026-06-01'), aiOverageCapBrl: null },
    ])
    p.conversation.count.mockResolvedValue(0)
    p.contact.count.mockResolvedValue(0)
    await expect(svc(p, b).reportPreviousMonth()).resolves.toBeUndefined()
    expect(b.postOverageReport).toHaveBeenCalledWith(
      expect.objectContaining({ month: '2026-08' }),
    )
    vi.useRealTimers()
  })

  it('the cron swallows failures so the scheduler survives', async () => {
    const p = makePrisma()
    p.account.findMany.mockRejectedValue(new Error('db down'))
    await expect(svc(p).reportPreviousMonth()).resolves.toBeUndefined()
  })

  it('the cron swallows a non-Error failure too', async () => {
    const p = makePrisma()
    p.account.findMany.mockRejectedValue('a string')
    await expect(svc(p).reportPreviousMonth()).resolves.toBeUndefined()
  })
})

describe('OverageService.computeAiMonth', () => {
  it('reports every account on a plan with AI overage, including ones inside the allowance', async () => {
    const p = makePrisma()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'Ship', plan: 'SPACESHIP', aiOverageCapBrl: '100.00' },
      { id: 'a2', name: 'Ent', plan: 'ENTERPRISE', aiOverageCapBrl: null },
    ])
    a.aiConversationsCount.mockResolvedValueOnce(1_400).mockResolvedValueOnce(120)
    a.costThisMonth.mockResolvedValue(3.5)
    const rows = await svc(p, makeBilling(), a).computeAiMonth('2026-08')
    // An account still inside its allowance is reported at its real count, not
    // omitted: a report that silently drops accounts is indistinguishable
    // from a broken cron.
    expect(rows.map((r) => [r.accountId, r.aiConversations, r.capBrl])).toEqual([
      ['a1', 1_400, 100],
      ['a2', 120, null],
    ])
  })

  it('meters the month being billed, not today', async () => {
    const p = makePrisma()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'Ship', plan: 'SPACESHIP', aiOverageCapBrl: null },
    ])
    await svc(p, makeBilling(), a).computeAiMonth('2026-08')
    const at = a.aiConversationsCount.mock.calls[0]![1] as Date
    // One millisecond before the window closes: inside August, so an
    // allowance override that expired in September does not rewrite August.
    expect(at.toISOString()).toBe('2026-09-01T02:59:59.999Z')
  })

  it('reports a Rocket account too, flagged as never billable for AI', async () => {
    const p = makePrisma()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'R', plan: 'ROCKET', aiOverageCapBrl: null },
    ])
    a.allowanceFor.mockResolvedValue({
      included: 300,
      overagePriceBrl: null,
      overridden: false,
    })
    a.aiConversationsCount.mockResolvedValue(280)
    const [row] = await svc(p, makeBilling(), a).computeAiMonth('2026-08')
    // 280 of 300 used, and nothing to invoice. The panel needs the position
    // even though the number can never become a charge.
    expect(row).toMatchObject({
      accountId: 'a1',
      aiConversations: 280,
      aiIncluded: 300,
      billablePlan: false,
    })
  })

  it('reports a legacy EXPLORER account without erroring on it', async () => {
    const p = makePrisma()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'a3', name: 'Old', plan: 'EXPLORER', aiOverageCapBrl: null },
    ])
    a.allowanceFor.mockResolvedValue({
      included: 50,
      overagePriceBrl: null,
      overridden: false,
    })
    const [row] = await svc(p, makeBilling(), a).computeAiMonth('2026-08')
    expect(row).toMatchObject({ aiIncluded: 50, billablePlan: false })
  })

  it('reports an uncounted plan with a null allowance rather than Infinity', async () => {
    const p = makePrisma()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'p1', name: 'P', plan: 'PARTNER', aiOverageCapBrl: null },
    ])
    a.allowanceFor.mockResolvedValue({
      included: Number.POSITIVE_INFINITY,
      overagePriceBrl: null,
      overridden: false,
    })
    const [row] = await svc(p, makeBilling(), a).computeAiMonth('2026-08')
    // Infinity does not survive JSON, so the wire carries null.
    expect(row!.aiIncluded).toBeNull()
  })

  it('rejects an invalid month', async () => {
    await expect(svc().computeAiMonth('nope')).rejects.toThrow(/invalid month/)
  })
})

describe('OverageService.report — AI leg', () => {
  it('posts the AI report as a separate call from the plan report', async () => {
    const p = makePrisma()
    const b = makeBilling()
    const a = makeAiUsage()
    p.account.findMany.mockResolvedValue([
      { id: 'a1', name: 'X', plan: 'SPACESHIP', createdAt: new Date('2026-06-01'), aiOverageCapBrl: null },
    ])
    p.conversation.count.mockResolvedValue(0)
    p.contact.count.mockResolvedValue(0)
    a.aiConversationsCount.mockResolvedValue(1_200)
    const out = await svc(p, b, a).report('2026-07')
    // Two calls, two invoices: the terms give the AI allowance its own.
    expect(b.postOverageReport).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ accounts: 1, posted: true, aiAccounts: 1, aiPosted: true })
    expect(b.postAiOverageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        month: '2026-07',
        dry: false,
        accounts: [expect.objectContaining({ accountId: 'a1', aiConversations: 1_200 })],
      }),
    )
  })

  it('does not call the AI endpoint when no account is on a plan with AI overage', async () => {
    const p = makePrisma()
    const b = makeBilling()
    p.account.findMany.mockResolvedValue([])
    const out = await svc(p, b).report('2026-07')
    expect(b.postAiOverageReport).not.toHaveBeenCalled()
    expect(out.aiPosted).toBe(false)
  })
})
