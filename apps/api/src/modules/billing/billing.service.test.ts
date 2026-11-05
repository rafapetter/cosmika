import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BillingService } from './billing.service'

function makePlanSync() {
  return { mirror: vi.fn().mockResolvedValue(null) }
}

function makeService(
  overrides: Record<string, unknown> = {},
  planSync = makePlanSync(),
) {
  const config: Partial<ConfigService> = {
    get: vi.fn((key: string) => overrides[key]),
  }
  return new BillingService(config as ConfigService, planSync as never)
}

const CONFIGURED = {
  COSMIKA_BILLING_API_SECRET: 'sekret',
  COSMIKA_BILLING_API_URL: 'https://admin.example',
}

function mockFetch(impl: (url: string, init: RequestInit) => unknown) {
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => impl(url, init)),
  )
}

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('BillingService — configuration', () => {
  it('is disabled with no secret, and signup checkout is a no-op', async () => {
    const svc = makeService()
    expect(svc.enabled()).toBe(false)
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })

  it('treats an empty or whitespace secret as unconfigured', () => {
    expect(makeService({ COSMIKA_BILLING_API_SECRET: '' }).enabled()).toBe(false)
    expect(makeService({ COSMIKA_BILLING_API_SECRET: '  ' }).enabled()).toBe(false)
  })

  it('strips quote-wrapping from the secret (the deployed env files quote it)', async () => {
    const svc = makeService({ ...CONFIGURED, COSMIKA_BILLING_API_SECRET: '"sekret"' })
    let seen = ''
    mockFetch((_url, init) => {
      seen = String((init.headers as Record<string, string>).authorization)
      return jsonRes(200, { paymentLinkUrl: 'https://pay/x' })
    })
    await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })
    expect(seen).toBe('Bearer sekret')
  })

  // A self-hosted install has no billing backend of its own; it must never
  // fall back to CosmoBots' (it used to default to admin.cosmobots.io).
  it('stays off with a secret but no address, and calls nobody', async () => {
    const svc = makeService({ COSMIKA_BILLING_API_SECRET: 's', COSMIKA_BILLING_API_URL: '  ' })
    expect(svc.enabled()).toBe(false)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(makeService({ COSMIKA_BILLING_API_SECRET: 's' }).enabled()).toBe(false)
  })
})

describe('BillingService — signup checkout', () => {
  let svc: BillingService
  beforeEach(() => {
    svc = makeService(CONFIGURED)
  })

  it('returns the normalised checkout and never sends a price', async () => {
    let body: Record<string, unknown> = {}
    mockFetch((_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return jsonRes(200, {
        paymentLinkUrl: 'https://www.asaas.com/c/wbp6',
        paymentLinkId: 'wbp6',
        plan: 'Rocket',
        cycle: 'monthly',
        chargedValue: 350,
        trialExpiresAt: '2026-08-08',
      })
    })
    const out = await svc.createSignupCheckout({ accountId: 'cuid1', accountName: 'Acme' })
    expect(out).toEqual({
      paymentLinkUrl: 'https://www.asaas.com/c/wbp6',
      paymentLinkId: 'wbp6',
      plan: 'Rocket',
      cycle: 'monthly',
      chargedValue: 350,
      trialExpiresAt: '2026-08-08',
    })
    expect(body).toEqual({ accountId: 'cuid1', accountName: 'Acme' })
    expect(body).not.toHaveProperty('planPrice')
  })

  it('coerces missing optional fields rather than throwing', async () => {
    mockFetch(() => jsonRes(200, { paymentLinkUrl: 'https://pay/x' }))
    const out = await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })
    expect(out).toMatchObject({ paymentLinkId: '', chargedValue: 0, trialExpiresAt: '' })
  })

  it('returns null (never throws) when the API rejects', async () => {
    mockFetch(() => jsonRes(400, { error: 'plan not allowed' }))
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })

  it('returns null when the response carries no payment link', async () => {
    mockFetch(() => jsonRes(200, { plan: 'Rocket' }))
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })

  it('returns null when the response body is not JSON', async () => {
    mockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    }))
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })

  it('returns null when the request throws (network/timeout)', async () => {
    mockFetch(() => {
      throw new Error('ETIMEDOUT')
    })
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })

  it('survives a non-Error rejection', async () => {
    mockFetch(() => {
      throw 'string blow-up'
    })
    expect(await svc.createSignupCheckout({ accountId: 'a', accountName: 'A' })).toBeNull()
  })
})

describe('BillingService — access gate', () => {
  it('allows everything when billing is not configured', async () => {
    const svc = makeService()
    expect(await svc.access('acc1')).toEqual({
      accessAllowed: true,
      paying: false,
      found: false,
      trialExpiresAt: null,
      plan: null,
    })
  })

  it('passes through an explicit denial', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() =>
      jsonRes(200, { accessAllowed: false, paying: false, found: true, trialExpiresAt: '2026-09-20' }),
    )
    expect(await svc.access('acc1')).toEqual({
      accessAllowed: false,
      paying: false,
      found: true,
      trialExpiresAt: '2026-09-20',
      plan: null,
    })
  })

  it('allows a paying account', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => jsonRes(200, { accessAllowed: true, paying: true, found: true }))
    expect(await svc.access('acc1')).toMatchObject({ accessAllowed: true, paying: true })
  })

  it('allows accounts billing has never heard of (404 = migrated/pre-billing)', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => jsonRes(404, { found: false, accountId: 'acc1', paying: false }))
    const out = await svc.access('acc1')
    expect(out.accessAllowed).toBe(true)
    expect(out.found).toBe(false)
  })

  it('fails OPEN on a server error rather than locking customers out', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => jsonRes(500, { error: 'boom' }))
    expect(await svc.access('acc1')).toMatchObject({ accessAllowed: true })
  })

  it('fails OPEN when the request throws', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    expect(await svc.access('acc1')).toMatchObject({ accessAllowed: true })
  })

  it('fails OPEN on a non-Error rejection', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => {
      throw 'nope'
    })
    expect(await svc.access('acc1')).toMatchObject({ accessAllowed: true })
  })

  it('caches within the TTL and re-checks after it expires', async () => {
    vi.useFakeTimers()
    try {
      const svc = makeService(CONFIGURED)
      const calls = { n: 0 }
      mockFetch(() => {
        calls.n++
        return jsonRes(200, { accessAllowed: true, paying: true, found: true })
      })
      await svc.access('acc1')
      await svc.access('acc1')
      expect(calls.n).toBe(1)
      vi.advanceTimersByTime(61_000)
      await svc.access('acc1')
      expect(calls.n).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not cache a fail-open result (so an outage cannot pin access open)', async () => {
    const svc = makeService(CONFIGURED)
    const calls = { n: 0 }
    mockFetch(() => {
      calls.n++
      return jsonRes(503, {})
    })
    await svc.access('acc1')
    await svc.access('acc1')
    expect(calls.n).toBe(2)
  })

  it('invalidate() drops a cached decision', async () => {
    const svc = makeService(CONFIGURED)
    const calls = { n: 0 }
    mockFetch(() => {
      calls.n++
      return jsonRes(200, { accessAllowed: true, paying: true, found: true })
    })
    await svc.access('acc1')
    svc.invalidate('acc1')
    await svc.access('acc1')
    expect(calls.n).toBe(2)
  })

  it('url-encodes the account id', async () => {
    const svc = makeService(CONFIGURED)
    let seen = ''
    mockFetch((url) => {
      seen = url
      return jsonRes(200, { accessAllowed: true })
    })
    await svc.access('a/b c')
    expect(seen).toBe('https://admin.example/api/billing/cosmika/accounts/a%2Fb%20c')
  })
})

// ─── overage report (P10) ──────────────────────────────────────────
// The cron reports quantities here; the admin side prices them. A failure
// must never throw into the scheduler — the next run covers it, because the
// admin endpoint is idempotent per account+month.

describe('BillingService — overage report', () => {
  const payload = { month: '2026-07', dry: false, accounts: [{ accountId: 'a1' }] }

  it('posts the report to the admin endpoint and reports success', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { created: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = makeService(CONFIGURED)
    await expect(svc.postOverageReport(payload)).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://admin.example/api/billing/cosmika/overage-invoices')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(payload)
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sekret')
  })

  it('does nothing when billing is not configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(makeService().postOverageReport(payload)).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a refusal as false instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(500, { error: 'boom' })))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(makeService(CONFIGURED).postOverageReport(payload)).resolves.toBe(false)
    errSpy.mockRestore()
  })

  it('survives a transport failure — the scheduler must not crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('admin unreachable')
    }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(makeService(CONFIGURED).postOverageReport(payload)).resolves.toBe(false)
    errSpy.mockRestore()
  })

  it('survives a non-Error rejection too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'a string'
    }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(makeService(CONFIGURED).postOverageReport(payload)).resolves.toBe(false)
    errSpy.mockRestore()
  })
})

describe('BillingService — plan mirror', () => {
  it('mirrors the billed plan onto the account on a fresh fetch', async () => {
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    mockFetch(() =>
      jsonRes(200, { accessAllowed: true, paying: true, found: true, plan: 'SPACESHIP' }),
    )
    const out = await svc.access('acc1')
    expect(out.plan).toBe('SPACESHIP')
    expect(planSync.mirror).toHaveBeenCalledWith('acc1', 'SPACESHIP')
  })

  it('accepts the numeric plan code cosmo-admin also uses', async () => {
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    mockFetch(() => jsonRes(200, { accessAllowed: true, found: true, plan: 3 }))
    expect((await svc.access('acc1')).plan).toBe('3')
    expect(planSync.mirror).toHaveBeenCalledWith('acc1', '3')
  })

  it('mirrors once per cache window, not once per request', async () => {
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    mockFetch(() => jsonRes(200, { accessAllowed: true, found: true, plan: 'ROCKET' }))
    await svc.access('acc1')
    await svc.access('acc1')
    expect(planSync.mirror).toHaveBeenCalledTimes(1)
  })

  it('does not mirror for an account billing has never heard of', async () => {
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    // 404: internal accounts and everything migrated before billing existed.
    // Their local plan is the only plan there is; overwriting it with a
    // guess would move every cap on the account.
    mockFetch(() => jsonRes(404, { found: false }))
    await svc.access('acc1')
    expect(planSync.mirror).not.toHaveBeenCalled()
  })

  it('does not mirror a 200 that says the account is unknown', async () => {
    // `found: false` with a 200 is the admin API saying it has no billing row
    // for this account. Its local plan is the only plan there is.
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    mockFetch(() => jsonRes(200, { accessAllowed: true, found: false, plan: 'ROCKET' }))
    await svc.access('acc1')
    expect(planSync.mirror).not.toHaveBeenCalled()
  })

  it('does not mirror when the response carries no plan', async () => {
    const planSync = makePlanSync()
    const svc = makeService(CONFIGURED, planSync)
    mockFetch(() => jsonRes(200, { accessAllowed: true, found: true }))
    await svc.access('acc1')
    expect(planSync.mirror).not.toHaveBeenCalled()
  })
})

describe('BillingService.postAiOverageReport', () => {
  it('is a no-op when billing is not configured', async () => {
    expect(
      await makeService().postAiOverageReport({ month: '2026-09', dry: true, accounts: [] }),
    ).toBe(false)
  })

  it('posts to the AI endpoint, separate from the plan overage one', async () => {
    const svc = makeService(CONFIGURED)
    let seen = ''
    mockFetch((url) => {
      seen = url
      return jsonRes(200, { ok: true })
    })
    expect(
      await svc.postAiOverageReport({ month: '2026-09', dry: false, accounts: [{ accountId: 'a' }] }),
    ).toBe(true)
    expect(seen).toBe('https://admin.example/api/billing/cosmika/ai-overage-invoices')
  })

  it('reports a refusal as false rather than throwing', async () => {
    const svc = makeService(CONFIGURED)
    mockFetch(() => jsonRes(422, { error: 'plan-mismatch' }))
    expect(
      await svc.postAiOverageReport({ month: '2026-09', dry: false, accounts: [] }),
    ).toBe(false)
  })

  it('survives a network failure', async () => {
    const svc = makeService(CONFIGURED)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(
      await svc.postAiOverageReport({ month: '2026-09', dry: false, accounts: [] }),
    ).toBe(false)
  })

  it('survives a non-Error throw', async () => {
    const svc = makeService(CONFIGURED)
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'a string' }))
    expect(
      await svc.postAiOverageReport({ month: '2026-09', dry: false, accounts: [] }),
    ).toBe(false)
  })
})
