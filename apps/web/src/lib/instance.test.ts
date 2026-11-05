import { afterEach, describe, expect, it, vi } from 'vitest'

import { financeEmail, supportEmail } from './instance'

describe('instance contacts', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('leaves the contacts out when the install set none', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '')
    vi.stubEnv('NEXT_PUBLIC_FINANCE_EMAIL', '  ')
    expect(supportEmail()).toBeNull()
    expect(financeEmail()).toBeNull()
  })

  it('uses what the install configured, and support for billing when finance is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', ' help@acme.example ')
    vi.stubEnv('NEXT_PUBLIC_FINANCE_EMAIL', '')
    expect(supportEmail()).toBe('help@acme.example')
    expect(financeEmail()).toBe('help@acme.example')
    vi.stubEnv('NEXT_PUBLIC_FINANCE_EMAIL', 'billing@acme.example')
    expect(financeEmail()).toBe('billing@acme.example')
  })
})
