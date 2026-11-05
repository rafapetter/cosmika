import { describe, expect, it, vi } from 'vitest'

import { parseReportedPlan, PlanSyncService } from './plan-sync.service'

function makePrisma() {
  return {
    account: {
      findUnique: vi.fn().mockResolvedValue({ plan: 'ROCKET' }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'al1' }) },
  }
}

type Prisma = ReturnType<typeof makePrisma>

const svc = (p: Prisma) => new PlanSyncService(p as never)

describe('parseReportedPlan', () => {
  it('accepts the numeric codes cosmo-admin and Nebula share', () => {
    expect(parseReportedPlan(2)).toBe('ROCKET')
    expect(parseReportedPlan(3)).toBe('SPACESHIP')
    expect(parseReportedPlan(4)).toBe('ENTERPRISE')
    expect(parseReportedPlan('3')).toBe('SPACESHIP')
  })

  it('accepts names, in any casing, with surrounding space', () => {
    expect(parseReportedPlan('Rocket')).toBe('ROCKET')
    expect(parseReportedPlan('  SPACESHIP ')).toBe('SPACESHIP')
    expect(parseReportedPlan('partner')).toBe('PARTNER')
    expect(parseReportedPlan('master')).toBe('MASTER')
  })

  it('accepts the legacy tiers so an old row can be echoed back unchanged', () => {
    expect(parseReportedPlan('explorer')).toBe('EXPLORER')
    expect(parseReportedPlan('jetpack')).toBe('JETPACK')
  })

  it('refuses to guess at anything else', () => {
    // A wrong guess here moves every cap and the AI allowance on the account,
    // so an unknown value is ignored rather than approximated.
    expect(parseReportedPlan('galaxy')).toBeNull()
    expect(parseReportedPlan(99)).toBeNull()
    expect(parseReportedPlan(null)).toBeNull()
    expect(parseReportedPlan(undefined)).toBeNull()
    expect(parseReportedPlan({ plan: 'ROCKET' })).toBeNull()
  })
})

describe('PlanSyncService.mirror', () => {
  it('writes the billed plan when the two disagree, and audits it', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({ plan: 'EXPLORER' })
    expect(await svc(p).mirror('acc1', 'ROCKET')).toBe('ROCKET')
    expect(p.account.update).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      data: { plan: 'ROCKET' },
    })
    // Audited because a plan change moves every cap and the AI allowance:
    // "why did my limits change on the 14th" has to have an answer.
    expect(p.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'account.plan.mirrored',
        metadata: { from: 'EXPLORER', to: 'ROCKET', source: 'cosmo-admin' },
      }),
    })
  })

  it('does nothing when they already agree', async () => {
    const p = makePrisma()
    expect(await svc(p).mirror('acc1', 'ROCKET')).toBeNull()
    expect(p.account.update).not.toHaveBeenCalled()
    expect(p.auditLog.create).not.toHaveBeenCalled()
  })

  it('does nothing for an account that is gone', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(null)
    expect(await svc(p).mirror('acc1', 'ROCKET')).toBeNull()
    expect(p.account.update).not.toHaveBeenCalled()
  })

  it('ignores an unknown plan instead of writing a guess', async () => {
    const p = makePrisma()
    expect(await svc(p).mirror('acc1', 'galaxy')).toBeNull()
    expect(p.account.findUnique).not.toHaveBeenCalled()
  })

  it('says nothing at all when no plan was reported', async () => {
    const p = makePrisma()
    expect(await svc(p).mirror('acc1', null)).toBeNull()
    expect(await svc(p).mirror('acc1', undefined)).toBeNull()
    expect(p.account.findUnique).not.toHaveBeenCalled()
  })

  it('swallows a write failure: a billing hiccup must not lock anyone out', async () => {
    // This runs off the access check on every authenticated request. A thrown
    // error here would turn a slow database into a logged-out customer.
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({ plan: 'ROCKET' })
    p.account.update.mockRejectedValue(new Error('db down'))
    expect(await svc(p).mirror('acc1', 'SPACESHIP')).toBeNull()
  })

  it('swallows a non-Error throw too', async () => {
    const p = makePrisma()
    p.account.findUnique.mockRejectedValue('a string')
    expect(await svc(p).mirror('acc1', 'SPACESHIP')).toBeNull()
  })
})
