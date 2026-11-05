import { describe, expect, it, vi } from 'vitest'

import { BillingStatusController } from './billing-status.controller'

function make(access: Record<string, unknown>, account: { billingCheckoutUrl: string | null } | null) {
  const billing = { access: vi.fn().mockResolvedValue(access) }
  const prisma = { account: { findUnique: vi.fn().mockResolvedValue(account) } }
  const ctrl = new BillingStatusController(billing as never, prisma as never)
  const auth = { membership: { accountId: 'acc1' } } as never
  return { ctrl, auth, billing, prisma }
}

describe('BillingStatusController.status', () => {
  it('offers the stored checkout link to a locked-out account', async () => {
    const { ctrl, auth, billing, prisma } = make(
      { accessAllowed: false, paying: false, found: true, trialExpiresAt: '2026-09-20' },
      { billingCheckoutUrl: 'https://www.asaas.com/c/abc123' },
    )
    expect(await ctrl.status(auth)).toEqual({
      accessAllowed: false,
      paying: false,
      trialExpiresAt: '2026-09-20',
      checkoutUrl: 'https://www.asaas.com/c/abc123',
    })
    expect(billing.access).toHaveBeenCalledWith('acc1')
    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      select: { billingCheckoutUrl: true },
    })
  })

  it('hides the link from a paying account', async () => {
    const { ctrl, auth } = make(
      { accessAllowed: true, paying: true, found: true, trialExpiresAt: null },
      { billingCheckoutUrl: 'https://www.asaas.com/c/abc123' },
    )
    expect((await ctrl.status(auth)).checkoutUrl).toBeNull()
  })

  it('returns no link when none was stored or the account is gone', async () => {
    const none = make({ accessAllowed: false, paying: false, found: true, trialExpiresAt: null }, { billingCheckoutUrl: null })
    expect((await none.ctrl.status(none.auth)).checkoutUrl).toBeNull()
    const gone = make({ accessAllowed: true, paying: false, found: false, trialExpiresAt: null }, null)
    expect((await gone.ctrl.status(gone.auth)).checkoutUrl).toBeNull()
  })
})
