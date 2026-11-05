import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { PlanSyncService } from './plan-sync.service'

// Client for the cosmo-admin billing API (the price + subscription authority
// for BOTH products). Cosmika never decides pricing: it asks for a checkout
// link at signup and asks whether an account may still be served.
//
// Contract notes that are easy to get wrong (see the Financeiro session's
// !54 and the !52 incident):
//  - Never send a price. The server is the authority; a client-supplied
//    price is logged and discarded.
//  - Activation happens by Asaas WEBHOOK on the admin side. Do NOT poll for
//    payment here: Asaas ignores the `paymentLink` filter on /v3/payments, so
//    a poll reads the account's newest charge, which may belong to someone
//    else entirely.
//  - Gate access on `accessAllowed` (paying OR trial still valid), never on
//    `paying`, or every trial account is locked out on day one.
//
// When the API is not configured (local dev, tests, e2e) every call degrades
// to "no billing": signup returns no checkout link and access is allowed.
// That keeps the self-hosted/dev path working without a billing backend.

export type SignupCheckout = {
  paymentLinkUrl: string
  paymentLinkId: string
  plan: string
  cycle: string
  chargedValue: number
  trialExpiresAt: string
}

export type BillingAccess = {
  accessAllowed: boolean
  paying: boolean
  found: boolean
  /** Last day of the trial, `YYYY-MM-DD`, when billing knows one. */
  trialExpiresAt: string | null
  /**
   * The plan the account is BILLED on, as cosmo-admin reports it. Null when
   * billing is not configured or has never heard of the account, in which
   * case the local plan stands. Mirrored onto `Account.plan` on every fresh
   * fetch (see `PlanSyncService`).
   */
  plan: string | null
}

const TIMEOUT_MS = 10_000
// Access is checked on authenticated traffic, so it must not add a network
// round trip per request. Trials expire by date and webhooks flip paying
// within seconds, so a short TTL is accurate enough and bounds the blast
// radius if the admin API is briefly down.
const ACCESS_TTL_MS = 60_000

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name)
  private readonly cache = new Map<string, { at: number; value: BillingAccess }>()

  constructor(
    private readonly config: ConfigService,
    private readonly planSync: PlanSyncService,
  ) {}

  private baseUrl(): string | null {
    return this.config.get<string>('COSMIKA_BILLING_API_URL')?.trim() || null
  }

  /**
   * The shared secret. Values in the deployed env files are quote-wrapped,
   * and passing the quotes verbatim yields a 401 that looks like a bad
   * secret — strip them here so a correct value can't be defeated by
   * formatting (same trap as ASAAS_API_KEY).
   */
  private secret(): string | null {
    const raw = this.config.get<string>('COSMIKA_BILLING_API_SECRET')
    if (!raw) return null
    const trimmed = raw.trim().replace(/^["']|["']$/g, '')
    return trimmed.length > 0 ? trimmed : null
  }

  /**
   * True when a billing backend is configured for this environment: both its
   * address and the shared secret. A self-hosted install sets neither and
   * runs without billing.
   */
  enabled(): boolean {
    return this.secret() !== null && this.baseUrl() !== null
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
    // Defensive: every caller checks enabled() first, so this is unreachable
    // in practice. It exists so a future caller can't leak an unauthenticated
    // request to the billing API.
    const secret = this.secret()
    const base = this.baseUrl()
    /* c8 ignore next */
    if (!secret || !base) return { ok: false, status: 0, json: null }
    const res = await fetch(`${base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    let json: Record<string, unknown> | null = null
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      /* non-JSON body (proxy error page, empty 204) — treat as no payload */
    }
    return { ok: res.ok, status: res.status, json }
  }

  /**
   * Report a closed month's overage quantities to the admin billing API,
   * which prices them and creates DRAFT invoices (idempotent per
   * account+month). Returns whether the POST was accepted; a failure is
   * logged and retried by the next run rather than thrown.
   */
  async postOverageReport(payload: {
    month: string
    dry: boolean
    accounts: unknown[]
  }): Promise<boolean> {
    if (!this.enabled()) return false
    try {
      const { ok, status } = await this.call('/api/billing/cosmika/overage-invoices', {
        method: 'POST',
        body: payload,
      })
      if (!ok) {
        this.logger.error(`overage report for ${payload.month} refused (${status})`)
      }
      return ok
    } catch (err) {
      this.logger.error(
        `overage report for ${payload.month} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * Report a closed month's AI usage to the admin billing API, which prices
   * it and creates its own DRAFT invoice, separate from the plan overage one
   * (the terms promise AI a "fatura própria"). Same shape and same guarantees
   * as `postOverageReport`: quantities only, never a price, idempotent per
   * account+month on the admin side.
   */
  async postAiOverageReport(payload: {
    month: string
    dry: boolean
    accounts: unknown[]
  }): Promise<boolean> {
    if (!this.enabled()) return false
    try {
      const { ok, status } = await this.call(
        '/api/billing/cosmika/ai-overage-invoices',
        { method: 'POST', body: payload },
      )
      if (!ok) {
        this.logger.error(
          `ai overage report for ${payload.month} refused (${status})`,
        )
      }
      return ok
    } catch (err) {
      this.logger.error(
        `ai overage report for ${payload.month} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * Create the signup checkout for a freshly created account. Returns null
   * when billing is not configured, or when the admin API refuses — signup
   * itself must never fail because billing is unavailable; the account is
   * created and the operator can issue a link later.
   */
  async createSignupCheckout(input: {
    accountId: string
    accountName: string
  }): Promise<SignupCheckout | null> {
    if (!this.enabled()) return null
    try {
      const { ok, status, json } = await this.call(
        '/api/billing/cosmika/signup-checkout',
        { method: 'POST', body: input },
      )
      if (!ok || !json) {
        this.logger.error(
          `signup checkout failed (${status}) for account ${input.accountId}`,
        )
        return null
      }
      const url = json.paymentLinkUrl
      if (typeof url !== 'string') {
        this.logger.error(`signup checkout returned no paymentLinkUrl for ${input.accountId}`)
        return null
      }
      return {
        paymentLinkUrl: url,
        paymentLinkId: String(json.paymentLinkId ?? ''),
        plan: String(json.plan ?? ''),
        cycle: String(json.cycle ?? ''),
        chargedValue: Number(json.chargedValue ?? 0),
        trialExpiresAt: String(json.trialExpiresAt ?? ''),
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`signup checkout errored for ${input.accountId}: ${m}`)
      return null
    }
  }

  /**
   * Whether an account may still be served. Fails OPEN: if the admin API is
   * unreachable we allow access rather than lock out paying customers over
   * an outage in a system that is not on Cosmika's critical path.
   */
  async access(accountId: string): Promise<BillingAccess> {
    const allow: BillingAccess = {
      accessAllowed: true,
      paying: false,
      found: false,
      trialExpiresAt: null,
      plan: null,
    }
    if (!this.enabled()) return allow
    const hit = this.cache.get(accountId)
    if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.value
    try {
      const { ok, status, json } = await this.call(
        `/api/billing/cosmika/accounts/${encodeURIComponent(accountId)}`,
        { method: 'GET' },
      )
      // 404 means the account predates billing (migrated, or created before
      // the integration). Those are served; only an explicit denial blocks.
      if (!ok && status !== 404) {
        this.logger.warn(`billing access check failed (${status}) for ${accountId}`)
        return allow
      }
      const value: BillingAccess = {
        accessAllowed: json?.accessAllowed !== false,
        paying: json?.paying === true,
        found: json?.found !== false && status !== 404,
        trialExpiresAt: typeof json?.trialExpiresAt === 'string' ? json.trialExpiresAt : null,
        plan:
          typeof json?.plan === 'string' || typeof json?.plan === 'number'
            ? String(json.plan)
            : null,
      }
      this.cache.set(accountId, { at: Date.now(), value })
      // Mirror the billed plan onto the account. Hung off the FRESH fetch,
      // not the cached one, so this is at most one write per account per
      // minute and only when the two actually disagree.
      if (value.found && value.plan !== null) {
        await this.planSync.mirror(accountId, value.plan)
      }
      return value
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.warn(`billing access check errored for ${accountId}: ${m}`)
      return allow
    }
  }

  /** Drop a cached decision (called after a payment webhook or cancel). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId)
  }
}
