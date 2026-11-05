import { createHash } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as argon2 from 'argon2'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AuthService,
  toAccountDTO,
  toMembershipDTO,
  toUserDTO,
  maskEmail,
} from './auth.service'
import { generateTotpSecret, verifyTotp } from './totp'

// ---------- shared helpers ----------

function makePrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    accountMember: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    session: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // $transaction(fn) — runs the callback with a tx scope that's just the
    // same mocked prisma object. Tests asserting transaction-scoped behaviour
    // can override per-test.
    $transaction: vi.fn(),
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma, configOverrides: Record<string, unknown> = {}) {
  const config: Partial<ConfigService> = {
    get: vi.fn((key: string) => configOverrides[key]),
  }
  const email = { send: vi.fn().mockResolvedValue(true) }
  // Billing degrades to "not configured" by default: signup works with no
  // billing backend, exactly as in local dev and e2e.
  const billing = {
    createSignupCheckout: vi.fn().mockResolvedValue(null),
    access: vi.fn().mockResolvedValue({ accessAllowed: true, paying: false, found: false }),
  }
  const svc = new AuthService(
    prisma as never,
    config as ConfigService,
    email as never,
    billing as never,
  )
  return { svc, config, email, billing }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ---------- signUp ----------

describe('AuthService.signUp', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
    prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => {
      // run the callback against the same mock prisma (no actual tx semantics)
      return fn(prisma)
    })
  })

  it('rejects if email is already registered', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing-user' })
    const { svc } = makeService(prisma)
    await expect(
      svc.signUp({
        email: 'A@B.COM',
        password: 'pw1234567890',
        fullName: 'New Person',
        accountName: 'Acme Inc',
      }),
    ).rejects.toThrow(ConflictException)
  })

  it('lowercases email on existence check', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' })
    const { svc } = makeService(prisma)
    await svc
      .signUp({
        email: 'MIXED@Case.COM',
        password: 'pw',
        fullName: 'x',
        accountName: 'y',
      })
      .catch(() => undefined)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'mixed@case.com' },
      select: { id: true },
    })
  })

  it('creates account + user + membership + session on success', async () => {
    prisma.user.findUnique.mockResolvedValue(null) // not existing
    prisma.account.findUnique.mockResolvedValue(null) // slug unique
    prisma.account.create.mockResolvedValue({
      id: 'acc1',
      name: 'Acme Inc',
      slug: 'acme-inc',
      status: 'ACTIVE',
      plan: 'ROCKET',
      defaultLocale: 'pt-BR',
    })
    prisma.user.create.mockResolvedValue({
      id: 'usr1',
      email: 'a@b.com',
      fullName: 'New Person',
      locale: 'pt-BR',
      totpEnabled: false,
    })
    prisma.accountMember.create.mockResolvedValue({
      id: 'am1',
      accountId: 'acc1',
      userId: 'usr1',
      role: 'ADMINISTRATOR',
    })
    prisma.session.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'sess1',
      createdAt: new Date(),
    }))

    const { svc } = makeService(prisma)
    const out = await svc.signUp({
      email: 'A@B.COM',
      password: 'pw1234567890',
      fullName: 'New Person',
      accountName: 'Acme Inc',
    })

    expect(out.account.id).toBe('acc1')
    expect(out.user.id).toBe('usr1')
    expect(out.membership.role).toBe('ADMINISTRATOR')
    // session.token is plaintext (the DB row stores the hash)
    expect(out.session.token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'a@b.com',
        fullName: 'New Person',
        // passwordHash is non-empty argon2 string
        passwordHash: expect.stringMatching(/^\$argon2/),
      }),
    })
  })

  it('creates the account on ROCKET, the plan cosmo-admin bills it on', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.account.findUnique.mockResolvedValue(null)
    let accountData: Record<string, unknown> | null = null
    prisma.account.create.mockImplementation(async ({ data }) => {
      accountData = data
      return { id: 'acc1', defaultLocale: 'pt-BR', ...data }
    })
    prisma.user.create.mockResolvedValue({ id: 'usr1' })
    prisma.accountMember.create.mockResolvedValue({ id: 'am1' })
    prisma.session.create.mockResolvedValue({ id: 's', token: 'h', expiresAt: new Date() })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: 'Acme',
    })

    // Never EXPLORER: that put a customer paying for 500 conversations on
    // 50-conversation caps, and reported a plan no invoice ever had.
    expect(accountData!.plan).toBe('ROCKET')
    expect(accountData!.status).toBe('ACTIVE')
  })

  function arrangeSignup() {
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.account.findUnique.mockResolvedValue(null)
    prisma.account.create.mockResolvedValue({ id: 'acc1', name: 'Acme', defaultLocale: 'pt-BR' })
    prisma.user.create.mockResolvedValue({ id: 'usr1' })
    prisma.accountMember.create.mockResolvedValue({ id: 'am1' })
    prisma.session.create.mockResolvedValue({ id: 's', token: 'h', expiresAt: new Date() })
  }
  const checkout = {
    paymentLinkUrl: 'https://www.asaas.com/c/abc123',
    paymentLinkId: 'abc123',
    plan: 'Rocket',
    cycle: 'monthly',
    chargedValue: 350,
    trialExpiresAt: '2026-09-20',
  }
  const input = { email: 'a@b.com', password: 'pw1234567890', fullName: 'n', accountName: 'Acme' }

  it('keeps the checkout link on the account for the subscription-ended screen', async () => {
    arrangeSignup()
    const { svc, billing } = makeService(prisma)
    billing.createSignupCheckout.mockResolvedValue(checkout)
    const out = await svc.signUp(input)
    expect(out.checkout).toEqual(checkout)
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      data: { billingCheckoutUrl: 'https://www.asaas.com/c/abc123' },
    })
  })

  it('stores nothing when billing issued no checkout', async () => {
    arrangeSignup()
    const { svc } = makeService(prisma)
    await svc.signUp(input)
    expect(prisma.account.update).not.toHaveBeenCalled()
  })

  it('still signs up when keeping the link fails', async () => {
    arrangeSignup()
    const { svc, billing } = makeService(prisma)
    billing.createSignupCheckout.mockResolvedValue(checkout)
    prisma.account.update.mockRejectedValueOnce(new Error('db down'))
    await expect(svc.signUp(input)).resolves.toMatchObject({ checkout })
    prisma.account.update.mockRejectedValueOnce('a string')
    await expect(svc.signUp(input)).resolves.toMatchObject({ checkout })
  })
})

// ---------- slugify / uniqueSlug (via signUp) ----------

describe('AuthService — slug generation', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
    prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(prisma))
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.user.create.mockResolvedValue({ id: 'u' })
    prisma.accountMember.create.mockResolvedValue({ id: 'm' })
    prisma.session.create.mockResolvedValue({ id: 's', token: 't', expiresAt: new Date() })
  })

  it('produces a kebab-cased slug from the account name', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: '  Hello World!  ',
    })
    expect(savedSlug).toBe('hello-world')
  })

  it('strips combining diacritics (Brazilian Portuguese accents)', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: 'Atenção Espírito Santo',
    })
    // After NFKD normalisation: accents become combining marks, the regex
    // strips them, and the rest passes through the kebab pass.
    expect(savedSlug).toMatch(/^atencao-espirito-santo$/)
  })

  it('falls back to "account" when name has no slug-safe characters', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: '!!!',
    })
    expect(savedSlug).toBe('account')
  })

  it('truncates slug to 48 chars', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: 'A'.repeat(100),
    })
    expect(savedSlug!.length).toBeLessThanOrEqual(48)
  })

  it('appends a random suffix when the base slug is taken', async () => {
    // First lookup returns "taken"; second lookup (with suffix) returns null.
    prisma.account.findUnique
      .mockResolvedValueOnce({ id: 'other' })
      .mockResolvedValueOnce(null)
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: 'Acme',
    })
    expect(savedSlug).toMatch(/^acme-[0-9a-f]{6}$/)
  })

  it('falls back to Date.now() suffix after 5 retries', async () => {
    // Every lookup returns "taken" — exhausts the 6-retry loop.
    prisma.account.findUnique.mockResolvedValue({ id: 'taken' })
    let savedSlug: string | undefined
    prisma.account.create.mockImplementation(async ({ data }) => {
      savedSlug = data.slug
      return { id: 'a', defaultLocale: 'pt-BR', ...data }
    })

    const { svc } = makeService(prisma)
    await svc.signUp({
      email: 'a@b.com',
      password: 'pw',
      fullName: 'n',
      accountName: 'Acme',
    })
    // Fallback uses Date.now() in base36 → only digits + lowercase letters.
    expect(savedSlug).toMatch(/^acme-[0-9a-z]+$/)
  })
})

// ---------- signIn (password path) ----------

describe('AuthService.signIn — password path', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('rejects unknown email', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.signIn({ email: 'x@y.com', password: 'pw' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('rejects user without password hash (SSO-only or migrated user)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash: null,
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.signIn({ email: 'a@b.com', password: 'pw' }),
    ).rejects.toThrow('Invalid credentials')
  })

  it('rejects wrong password', async () => {
    const hash = await argon2.hash('correct-password')
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash: hash,
      totpEnabled: false,
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.signIn({ email: 'a@b.com', password: 'wrong-password' }),
    ).rejects.toThrow('Invalid credentials')
  })

  it('returns a session when password is correct and 2FA is off', async () => {
    const hash = await argon2.hash('correct-password')
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash: hash,
      totpEnabled: false,
    })
    prisma.accountMember.findFirst.mockResolvedValue({
      id: 'am1',
      accountId: 'acc1',
      userId: 'u1',
      isActive: true,
      account: { id: 'acc1', name: 'Acme' },
    })
    prisma.user.update.mockResolvedValue({})
    prisma.session.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'sess',
      createdAt: new Date(),
    }))

    const { svc } = makeService(prisma)
    const result = await svc.signIn({
      email: 'a@b.com',
      password: 'correct-password',
    })
    expect(result.kind).toBe('session')
    if (result.kind === 'session') {
      expect(result.user.id).toBe('u1')
      expect(result.account.id).toBe('acc1')
      expect(result.session.token).toBeTruthy()
    }
    // lastSignInAt was bumped
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastSignInAt: expect.any(Date) },
    })
  })

  it('rejects when user has no active membership', async () => {
    const hash = await argon2.hash('correct-password')
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordHash: hash,
      totpEnabled: false,
    })
    prisma.accountMember.findFirst.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.signIn({ email: 'a@b.com', password: 'correct-password' }),
    ).rejects.toThrow('No active account membership')
  })
})

// ---------- signIn (TOTP path) ----------

describe('AuthService.signIn — TOTP challenge path', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns a challenge token when totpEnabled', async () => {
    const hash = await argon2.hash('correct-password')
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      passwordHash: hash,
      totpEnabled: true,
    })
    let capturedToken: string | undefined
    prisma.session.create.mockImplementation(async ({ data }) => {
      capturedToken = data.token
      return { ...data, id: 'chal1', createdAt: new Date() }
    })

    const { svc } = makeService(prisma)
    const result = await svc.signIn({
      email: 'a@b.com',
      password: 'correct-password',
    })
    expect(result.kind).toBe('totp')
    if (result.kind === 'totp') {
      expect(result.challengeToken).toBeTruthy()
      // DB stores hashed form with chal_ prefix
      expect(capturedToken).toBe(`chal_${hashToken(result.challengeToken)}`)
    }
  })
})

// ---------- redeemTotpChallenge ----------

describe('AuthService.redeemTotpChallenge', () => {
  let prisma: Prisma
  const secret = generateTotpSecret()

  beforeEach(() => {
    prisma = makePrisma()
  })

  function mockChallenge(extra: Record<string, unknown> = {}) {
    prisma.session.findUnique.mockResolvedValue({
      id: 'chal1',
      userId: 'u1',
      token: `chal_${hashToken('plaintext-chal')}`,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      totpAttempts: 0,
      user: {
        id: 'u1',
        email: 'a@b.com',
        totpEnabled: true,
        totpSecret: secret,
        totpRecoveryCodes: null,
        ...extra,
      },
    })
  }

  it('404s on unknown challenge token', async () => {
    prisma.session.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'x', code: '123456' }),
    ).rejects.toThrow('Invalid challenge')
  })

  it('deletes + 401s on expired challenge', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'chal1',
      expiresAt: new Date(Date.now() - 1000),
      totpAttempts: 0,
      user: { totpEnabled: true, totpSecret: secret },
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'x', code: '123456' }),
    ).rejects.toThrow('Challenge expired')
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 'chal1' } })
  })

  it('401s if user has 2FA off mid-challenge', async () => {
    mockChallenge({ totpEnabled: false })
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'x', code: '123456' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('401s if user has no secret', async () => {
    mockChallenge({ totpEnabled: true, totpSecret: null })
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'x', code: '123456' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('bumps totpAttempts on wrong code', async () => {
    mockChallenge()
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'plaintext-chal', code: '000000' }),
    ).rejects.toThrow('Invalid code')
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'chal1' },
      data: { totpAttempts: 1 },
    })
  })

  it('deletes the challenge after the 5th failed attempt (lockout)', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'chal1',
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      totpAttempts: 4, // next attempt = 5, triggers lockout
      user: { id: 'u1', totpEnabled: true, totpSecret: secret, totpRecoveryCodes: null },
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.redeemTotpChallenge({ challengeToken: 'plaintext-chal', code: '000000' }),
    ).rejects.toThrow('Invalid code')
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 'chal1' } })
    expect(prisma.session.update).not.toHaveBeenCalled()
  })

  it('redeems with a valid TOTP code', async () => {
    mockChallenge()
    // We can't easily produce a valid code without knowing the time, but
    // we can spy on verifyTotp by mocking the imported module. Use a custom
    // setup: stub Date.now() and pre-compute the code.
    // Easier path: use a known secret + brute force a code that the impl
    // accepts via the helper from totp tests... but vitest module mocking
    // is cleaner.
    const totpModule = await import('./totp')
    vi.spyOn(totpModule, 'verifyTotp').mockReturnValue(true)

    prisma.accountMember.findFirst.mockResolvedValue({
      id: 'am1',
      accountId: 'acc1',
      userId: 'u1',
      isActive: true,
      account: { id: 'acc1' },
    })
    prisma.user.update.mockResolvedValue({})
    prisma.session.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'sess1',
      createdAt: new Date(),
    }))

    const { svc } = makeService(prisma)
    const result = await svc.redeemTotpChallenge({
      challengeToken: 'plaintext-chal',
      code: '123456',
    })
    expect(result.user.id).toBe('u1')
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 'chal1' } })

    vi.restoreAllMocks()
  })

  it('accepts a valid recovery code (and marks it spent)', async () => {
    const recovery = 'ABCDE-12345'
    const recoveryHash = createHash('sha256').update(recovery).digest('hex')
    mockChallenge({ totpRecoveryCodes: [recoveryHash, 'other-hash'] })

    prisma.accountMember.findFirst.mockResolvedValue({
      id: 'am1',
      accountId: 'acc1',
      userId: 'u1',
      isActive: true,
      account: { id: 'acc1' },
    })
    prisma.user.update.mockResolvedValue({})
    prisma.session.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'sess1',
      createdAt: new Date(),
    }))

    const { svc } = makeService(prisma)
    const result = await svc.redeemTotpChallenge({
      challengeToken: 'plaintext-chal',
      code: recovery,
    })
    expect(result.user.id).toBe('u1')
    // The recovery code's hash should be removed from the user's list.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { totpRecoveryCodes: ['other-hash'] },
      }),
    )
  })
})

// ---------- setupTotp / verifyTotpSetup / disableTotp ----------

describe('AuthService TOTP setup/verify/disable', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('setupTotp returns secret + otpauth URL and writes provisional secret', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
    })
    prisma.user.update.mockResolvedValue({})

    const { svc } = makeService(prisma)
    const out = await svc.setupTotp('u1')
    expect(out.secret).toMatch(/^[A-Z2-7]+$/)
    expect(out.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Cosmika:/)
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { totpSecret: out.secret, totpEnabled: false },
    })
  })

  it('setupTotp 401s for unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.setupTotp('missing')).rejects.toThrow(UnauthorizedException)
  })

  it('verifyTotpSetup 400s if setup was never started', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', totpSecret: null })
    const { svc } = makeService(prisma)
    await expect(svc.verifyTotpSetup('u1', '123456')).rejects.toThrow(
      'Setup not started',
    )
  })

  it('verifyTotpSetup 409s if 2FA is already enabled', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpSecret: 'X',
      totpEnabled: true,
    })
    const { svc } = makeService(prisma)
    await expect(svc.verifyTotpSetup('u1', '123456')).rejects.toThrow(ConflictException)
  })

  it('verifyTotpSetup 400s on wrong code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpEnabled: false,
    })
    const { svc } = makeService(prisma)
    await expect(svc.verifyTotpSetup('u1', '000000')).rejects.toThrow(
      'Code does not match',
    )
  })

  it('verifyTotpSetup enables 2FA + emits recovery codes on right code', async () => {
    const secret = generateTotpSecret()
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpSecret: secret,
      totpEnabled: false,
    })
    prisma.user.update.mockResolvedValue({})

    const totpModule = await import('./totp')
    vi.spyOn(totpModule, 'verifyTotp').mockReturnValue(true)

    const { svc } = makeService(prisma)
    const out = await svc.verifyTotpSetup('u1', '123456')
    expect(out.recoveryCodes).toHaveLength(10)
    expect(out.recoveryCodes[0]).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/)
    // DB write hashes each code before storage
    const updateArg = prisma.user.update.mock.calls[0]![0]
    expect(updateArg.data.totpEnabled).toBe(true)
    expect((updateArg.data.totpRecoveryCodes as string[]).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true)

    vi.restoreAllMocks()
  })

  it('disableTotp 400s if 2FA is not on', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', totpEnabled: false })
    const { svc } = makeService(prisma)
    await expect(svc.disableTotp('u1', '123456')).rejects.toThrow('2FA is not enabled')
  })

  it('disableTotp 400s on wrong code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpRecoveryCodes: [],
    })
    const { svc } = makeService(prisma)
    await expect(svc.disableTotp('u1', '000000')).rejects.toThrow('Code does not match')
  })

  it('disableTotp 400s on wrong code when totpRecoveryCodes is null (no recovery codes)', async () => {
    // Covers the `?? []` fallback when the JSON column is null instead of [].
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpRecoveryCodes: null,
    })
    const { svc } = makeService(prisma)
    await expect(svc.disableTotp('u1', '000000')).rejects.toThrow('Code does not match')
  })

  it('disableTotp succeeds with a valid TOTP code', async () => {
    const secret = generateTotpSecret()
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpEnabled: true,
      totpSecret: secret,
      totpRecoveryCodes: ['unused-hash'],
    })
    prisma.user.update.mockResolvedValue({})

    const totpModule = await import('./totp')
    vi.spyOn(totpModule, 'verifyTotp').mockReturnValue(true)

    const { svc } = makeService(prisma)
    await svc.disableTotp('u1', '123456')
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({
        totpEnabled: false,
        totpSecret: null,
      }),
    })

    vi.restoreAllMocks()
  })

  it('disableTotp also accepts a valid recovery code', async () => {
    const recovery = 'XYZAB-98765'
    const recoveryHash = createHash('sha256').update(recovery).digest('hex')
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      totpEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpRecoveryCodes: [recoveryHash],
    })
    prisma.user.update.mockResolvedValue({})

    const { svc } = makeService(prisma)
    await svc.disableTotp('u1', recovery)
    expect(prisma.user.update).toHaveBeenCalled()
  })
})

// ---------- session lifecycle ----------

describe('AuthService session lifecycle', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('createSession stores hash, returns plaintext', async () => {
    let captured: { userId: string; token: string; expiresAt: Date } | null = null
    prisma.session.create.mockImplementation(async ({ data }) => {
      captured = data
      return { ...data, id: 's1', createdAt: new Date() }
    })
    const { svc } = makeService(prisma)
    const sess = await svc.createSession('u1')
    expect(sess.token).toMatch(/^[A-Za-z0-9_-]+$/)
    // Returned plaintext, stored hash = sha256(plaintext)
    expect(captured!.token).toBe(hashToken(sess.token))
    expect(captured!.token).toHaveLength(64)
  })

  it('createSession honors SESSION_TTL_DAYS from config', async () => {
    let captured: { expiresAt: Date } | null = null
    prisma.session.create.mockImplementation(async ({ data }) => {
      captured = data
      return { ...data, id: 's1' }
    })
    const before = Date.now()
    const { svc } = makeService(prisma, { SESSION_TTL_DAYS: 7 })
    await svc.createSession('u1')
    const after = Date.now()
    const expectedLowerBound = before + 7 * 86_400_000
    const expectedUpperBound = after + 7 * 86_400_000
    expect(captured!.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedLowerBound)
    expect(captured!.expiresAt.getTime()).toBeLessThanOrEqual(expectedUpperBound)
  })

  it('createSession defaults to 30 days when env var missing', async () => {
    let captured: { expiresAt: Date } | null = null
    prisma.session.create.mockImplementation(async ({ data }) => {
      captured = data
      return { ...data, id: 's1' }
    })
    const before = Date.now()
    const { svc } = makeService(prisma) // no config override
    await svc.createSession('u1')
    expect(captured!.expiresAt.getTime() - before).toBeCloseTo(
      30 * 86_400_000,
      -3, // allow 1s wiggle
    )
  })

  it('sessionFromToken returns null for chal_-prefixed tokens', async () => {
    const { svc } = makeService(prisma)
    expect(await svc.sessionFromToken('chal_anything')).toBeNull()
    // Importantly: no DB lookup performed
    expect(prisma.session.findUnique).not.toHaveBeenCalled()
  })

  it('sessionFromToken returns null for unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    expect(await svc.sessionFromToken('random-plain-token')).toBeNull()
  })

  it('sessionFromToken deletes + returns null for expired session', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() - 1000),
      user: { memberships: [{ id: 'm1' }] },
    })
    const { svc } = makeService(prisma)
    expect(await svc.sessionFromToken('token')).toBeNull()
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 's1' } })
  })

  it('sessionFromToken returns null when expired session delete fails (swallowed)', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() - 1000),
      user: { memberships: [] },
    })
    prisma.session.delete.mockRejectedValue(new Error('already gone'))
    const { svc } = makeService(prisma)
    expect(await svc.sessionFromToken('token')).toBeNull()
  })

  it('sessionFromToken returns null when user has no active membership', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'u1', memberships: [] },
    })
    const { svc } = makeService(prisma)
    expect(await svc.sessionFromToken('token')).toBeNull()
  })

  it('sessionFromToken returns the SessionContext for a valid token', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: 'u1',
        email: 'a@b.com',
        memberships: [{ id: 'm1', accountId: 'acc1', userId: 'u1', isActive: true }],
      },
    })
    const { svc } = makeService(prisma)
    const ctx = await svc.sessionFromToken('valid-token')
    expect(ctx?.sessionId).toBe('s1')
    expect(ctx?.user.id).toBe('u1')
    expect(ctx?.membership.id).toBe('m1')
    // Lookup must use the hash, not the plaintext
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { token: hashToken('valid-token') },
      include: expect.any(Object),
    })
  })

  it('signOut deletes by session id', async () => {
    const { svc } = makeService(prisma)
    await svc.signOut('s1')
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { id: 's1' } })
  })
})

// ---------- updateMe / changePassword / getMeContext ----------

describe('AuthService profile mutations', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('updateMe applies only the provided fields (fullName)', async () => {
    prisma.user.update.mockResolvedValue({ id: 'u1', fullName: 'New Name' })
    const { svc } = makeService(prisma)
    await svc.updateMe('u1', { fullName: 'New Name' })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { fullName: 'New Name' },
    })
  })

  it('updateMe applies avatarUrl when explicitly null (clearing)', async () => {
    prisma.user.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.updateMe('u1', { avatarUrl: null })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { avatarUrl: null },
    })
  })

  it('updateMe applies phone, including clearing it with null', async () => {
    prisma.user.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.updateMe('u1', { phone: '+55 11 99999-0000' })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { phone: '+55 11 99999-0000' },
    })
    await svc.updateMe('u1', { phone: null })
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: { phone: null },
    })
  })

  it('updateMe applies locale', async () => {
    prisma.user.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.updateMe('u1', { locale: 'es' })
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { locale: 'es' },
    })
  })

  it('updateMe sends an empty data block when nothing provided', async () => {
    prisma.user.update.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.updateMe('u1', {})
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: {} })
  })

  it('changePassword 401s for unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.changePassword('u1', { currentPassword: 'a', newPassword: 'b' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('changePassword 401s for user with no password (SSO-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: null })
    const { svc } = makeService(prisma)
    await expect(
      svc.changePassword('u1', { currentPassword: 'a', newPassword: 'b' }),
    ).rejects.toThrow(UnauthorizedException)
  })

  it('changePassword 400s on wrong current password', async () => {
    const hash = await argon2.hash('real-current')
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: hash })
    const { svc } = makeService(prisma)
    await expect(
      svc.changePassword('u1', { currentPassword: 'wrong', newPassword: 'new' }),
    ).rejects.toThrow('Current password is incorrect')
  })

  it('changePassword updates with new argon2 hash', async () => {
    const hash = await argon2.hash('correct-current')
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: hash })
    let captured: { passwordHash: string } | null = null
    prisma.user.update.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'u1' }
    })
    const { svc } = makeService(prisma)
    await svc.changePassword('u1', {
      currentPassword: 'correct-current',
      newPassword: 'new-password-123',
    })
    expect(captured!.passwordHash).toMatch(/^\$argon2/)
    // And the new hash verifies against the new password
    expect(await argon2.verify(captured!.passwordHash, 'new-password-123')).toBe(true)
  })

  it('getMeContext returns the session bundle for a valid session id', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      user: {
        id: 'u1',
        memberships: [
          { id: 'm1', isActive: true, account: { id: 'acc1', name: 'Acme' } },
        ],
      },
    })
    const { svc } = makeService(prisma)
    const ctx = await svc.getMeContext('s1')
    expect(ctx.user.id).toBe('u1')
    expect(ctx.account.id).toBe('acc1')
    expect(ctx.membership.id).toBe('m1')
  })

  it('getMeContext 401s when session is missing', async () => {
    prisma.session.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.getMeContext('s1')).rejects.toThrow(UnauthorizedException)
  })

  it('getMeContext 401s when user has no active membership', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      user: { id: 'u1', memberships: [] },
    })
    const { svc } = makeService(prisma)
    await expect(svc.getMeContext('s1')).rejects.toThrow(UnauthorizedException)
  })
})

// ---------- DTO functions ----------

describe('AuthService DTOs', () => {
  it('toUserDTO emits ISO createdAt + no passwordHash', () => {
    const user = {
      id: 'u1',
      email: 'a@b.com',
      fullName: 'Hana',
      avatarUrl: null,
      locale: 'pt-BR',
      totpEnabled: false,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      // a few fields that should NOT leak:
      passwordHash: '$argon2id$...secret',
      totpSecret: 'SECRET',
      totpRecoveryCodes: ['hash1'],
    } as never
    const dto = toUserDTO(user)
    expect(dto.createdAt).toBe('2026-05-01T00:00:00.000Z')
    expect(Object.keys(dto)).not.toContain('passwordHash')
    expect(Object.keys(dto)).not.toContain('totpSecret')
    expect(Object.keys(dto)).not.toContain('totpRecoveryCodes')
  })

  it('toAccountDTO emits ISO createdAt + maps fields', () => {
    const account = {
      id: 'acc1',
      slug: 'acme',
      name: 'Acme',
      domain: null,
      status: 'ACTIVE',
      plan: 'ROCKET',
      defaultLocale: 'pt-BR',
      defaultTimezone: 'America/Sao_Paulo',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    } as never
    const dto = toAccountDTO(account)
    expect(dto.id).toBe('acc1')
    expect(dto.plan).toBe('ROCKET')
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(dto.defaultLocale).toBe('pt-BR')
  })

  // The commercial answers the welcome flow collects live in AccountProfile
  // precisely so they never ride in the session payload, which the web client
  // keeps in localStorage. Adding one of them to this DTO "for convenience"
  // is the one-line change that would undo that.
  it('toAccountDTO carries no field from the commercial profile', () => {
    const account = {
      id: 'acc1',
      slug: 'acme',
      name: 'Acme',
      domain: null,
      status: 'ACTIVE',
      plan: 'ROCKET',
      defaultLocale: 'pt-BR',
      defaultTimezone: 'America/Sao_Paulo',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      profile: {
        businessIndustry: 'healthcare',
        expectedVolume: 'upTo5000',
        conversationVolume: 'upTo500',
      },
    } as never
    const keys = Object.keys(toAccountDTO(account))
    for (const leaked of [
      'profile',
      'businessIndustry',
      'companySize',
      'businessDescription',
      'supportToday',
      'channelsToday',
      'conversationVolume',
      'intendedFeatures',
      'expectedVolume',
      'expectedAiShare',
    ]) {
      expect(keys).not.toContain(leaked)
    }
  })

  it('toAccountDTO normalizes a Nebula numeric locale enum → Cosmika locale', () => {
    const base = {
      id: 'a',
      slug: 's',
      name: 'N',
      domain: null,
      status: 'ACTIVE',
      plan: 'ROCKET',
      defaultTimezone: 'America/Sao_Paulo',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    // 16 = pt-BR, 0 = en, 12 = es in Nebula's language enum.
    expect(toAccountDTO({ ...base, defaultLocale: '16' } as never).defaultLocale).toBe('pt-BR')
    expect(toAccountDTO({ ...base, defaultLocale: '0' } as never).defaultLocale).toBe('en')
    expect(toAccountDTO({ ...base, defaultLocale: '12' } as never).defaultLocale).toBe('es')
  })

  it('toAccountDTO falls back to pt-BR on an unknown/garbage locale value', () => {
    const base = {
      id: 'a',
      slug: 's',
      name: 'N',
      domain: null,
      status: 'ACTIVE',
      plan: 'ROCKET',
      defaultTimezone: 'UTC',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    expect(toAccountDTO({ ...base, defaultLocale: 'klingon' } as never).defaultLocale).toBe('pt-BR')
    expect(toAccountDTO({ ...base, defaultLocale: null } as never).defaultLocale).toBe('pt-BR')
  })

  it('toMembershipDTO embeds toUserDTO', () => {
    const membership = {
      id: 'm1',
      accountId: 'acc1',
      userId: 'u1',
      role: 'ADMINISTRATOR',
      isActive: true,
      user: {
        id: 'u1',
        email: 'a@b.com',
        fullName: 'X',
        avatarUrl: null,
        locale: 'en',
        totpEnabled: false,
        createdAt: new Date(),
        passwordHash: 'SECRET-MUST-NOT-LEAK',
      },
    } as never
    const dto = toMembershipDTO(membership)
    expect(dto.user.id).toBe('u1')
    expect(Object.keys(dto.user)).not.toContain('passwordHash')
  })
})

// ---------- forgot / reset password ----------

describe('AuthService.forgotPassword', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('is a silent no-op for unknown emails (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const { svc, email } = makeService(prisma)
    await expect(svc.forgotPassword('ghost@x.com')).resolves.toBeUndefined()
    expect(prisma.session.create).not.toHaveBeenCalled()
    expect(email.send).not.toHaveBeenCalled()
  })

  it('sends an invited user who never set a password the link they need', async () => {
    // No password and no SSO is exactly the invitee who lost the invite
    // email. Skipping them left invitees locked out for good.
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'new@x.com', passwordHash: null, ssoProvider: null })
    const { svc, email } = makeService(prisma)
    await svc.forgotPassword('new@x.com')
    expect(prisma.session.create).toHaveBeenCalled()
    expect(email.send).toHaveBeenCalled()
  })

  it('is a silent no-op for SSO users without a password hash', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'sso@x.com', passwordHash: null, ssoProvider: 'google' })
    const { svc, email } = makeService(prisma)
    await svc.forgotPassword('sso@x.com')
    expect(prisma.session.create).not.toHaveBeenCalled()
    expect(email.send).not.toHaveBeenCalled()
  })

  it('stores a reset_-prefixed hashed token (~1h) and emails the link', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'r@x.com',
      fullName: 'Rafa',
      passwordHash: 'hash',
    })
    prisma.session.create.mockResolvedValue({})
    const { svc, email } = makeService(prisma, { PUBLIC_WEB_URL: 'https://app.example' })
    const before = Date.now()
    await svc.forgotPassword('r@x.com')

    const created = prisma.session.create.mock.calls[0]![0].data
    expect(created.userId).toBe('u1')
    expect(created.token).toMatch(/^reset_[0-9a-f]{64}$/)
    const ttl = created.expiresAt.getTime() - before
    expect(ttl).toBeGreaterThan(59 * 60 * 1000)
    expect(ttl).toBeLessThan(61 * 60 * 1000)

    // the emailed link carries the PLAINTEXT whose hash is stored
    const [to, subject, body] = email.send.mock.calls[0]!
    expect(to).toBe('r@x.com')
    expect(subject).toContain('senha')
    const token = /token=([A-Za-z0-9_-]+)/.exec(body)![1]!
    expect(created.token).toBe(`reset_${hashToken(token)}`)
    expect(body).toContain('https://app.example/reset-password?token=')
  })

  it('defaults the link base to localhost:3100 when PUBLIC_WEB_URL unset', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'r@x.com', fullName: null, passwordHash: 'h' })
    prisma.session.create.mockResolvedValue({})
    const { svc, email } = makeService(prisma)
    await svc.forgotPassword('r@x.com')
    expect(email.send.mock.calls[0]![2]).toContain('http://localhost:3100/reset-password?token=')
  })
})

describe('AuthService.resetPassword', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('rejects an unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.resetPassword({ token: 'nope', password: 'newpass123' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(prisma.session.findUnique).toHaveBeenCalledWith({
      where: { token: `reset_${hashToken('nope')}` },
    })
  })

  it('rejects and deletes an expired token', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      expiresAt: new Date(Date.now() - 1000),
    })
    const { svc } = makeService(prisma)
    await expect(svc.resetPassword({ token: 'old', password: 'newpass123' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 's1' } })
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it('swallows a failed delete of the expired row and still rejects', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      expiresAt: new Date(Date.now() - 1000),
    })
    prisma.session.delete.mockRejectedValue(new Error('gone'))
    const { svc } = makeService(prisma)
    await expect(svc.resetPassword({ token: 'old', password: 'newpass123' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
  })

  it('sets the new argon2 hash and revokes every session for the user', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 60_000),
    })
    prisma.$transaction.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.resetPassword({ token: 'good', password: 'newpass123' })

    const update = prisma.user.update.mock.calls[0]![0]
    expect(update.where).toEqual({ id: 'u1' })
    await expect(argon2.verify(update.data.passwordHash, 'newpass123')).resolves.toBe(true)
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('AuthService.signUp — invite gate', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  const input = {
    email: 'new@x.com',
    password: 'password1',
    fullName: 'New',
    accountName: 'Acme',
  }

  it('rejects when the code is set and missing/wrong', async () => {
    const { svc } = makeService(prisma, { COSMIKA_SIGNUP_INVITE_CODE: 'beta-42' })
    await expect(svc.signUp(input)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(svc.signUp({ ...input, inviteCode: 'wrong' })).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('proceeds past the gate with the correct code', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'exists' })
    const { svc } = makeService(prisma, { COSMIKA_SIGNUP_INVITE_CODE: 'beta-42' })
    // Reaching the duplicate-email conflict proves the gate passed.
    await expect(svc.signUp({ ...input, inviteCode: 'beta-42' })).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('stays open when no code is configured', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'exists' })
    const { svc } = makeService(prisma)
    await expect(svc.signUp(input)).rejects.toBeInstanceOf(ConflictException)
  })
})


describe('maskEmail (M1 enumeration visibility)', () => {
  it('keeps enough to correlate a sweep, not enough to leak the user list', () => {
    expect(maskEmail('marina@example.com')).toBe('ma****@example.com')
    expect(maskEmail('A@B.COM')).toBe('a*@b.com')
  })

  it('never returns a bare local part, however short', () => {
    // A 1-2 char local must still be starred, or the mask leaks the whole
    // address for short handles.
    expect(maskEmail('jo@x.com')).toBe('jo*@x.com')
    expect(maskEmail('j@x.com')).toBe('j*@x.com')
  })
})


describe('AuthService.sendInvitation', () => {
  let prisma: ReturnType<typeof makePrisma>
  beforeEach(() => { prisma = makePrisma() })

  it('gives a new user a 7-day link to set a password', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'n@x.com', fullName: 'Ana', passwordHash: null, ssoProvider: null })
    const { svc, email } = makeService(prisma)
    await svc.sendInvitation('u1', 'Loja')
    const created = prisma.session.create.mock.calls[0]![0].data
    expect(created.token).toMatch(/^reset_/)
    const days = (created.expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    const [to, subject, body] = email.send.mock.calls[0]!
    expect(to).toBe('n@x.com')
    expect(subject).toBe('Convite para Loja no Cosmika')
    expect(body).toContain('Olá Ana')
    expect(body).toContain('/reset-password?token=')
  })

  it('tells someone who already has a password to sign in', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'o@x.com', fullName: null, passwordHash: 'h', ssoProvider: null })
    const { svc, email } = makeService(prisma)
    await svc.sendInvitation('u1', 'Loja')
    expect(prisma.session.create).not.toHaveBeenCalled()
    const [, subject, body] = email.send.mock.calls[0]!
    expect(subject).toBe('Você foi adicionado a Loja no Cosmika')
    expect(body.startsWith('Olá,')).toBe(true)
    expect(body).toContain('/sign-in')
  })

  it('does nothing for an unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null)
    const { svc, email } = makeService(prisma)
    expect(await svc.sendInvitation('ghost', 'Loja')).toBe(false)
    expect(email.send).not.toHaveBeenCalled()
  })
})
