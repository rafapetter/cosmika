import { ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthGuard, extractAuthFromRequest, isBillingExempt } from './auth.guard'
import type { AuthService } from './auth.service'

function makeContext(
  headers: Record<string, string | string[] | undefined>,
  url = '/conversations',
): {
  ctx: ExecutionContext
  req: { headers: typeof headers; url: string; auth?: unknown }
} {
  const req = { headers, url }
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

function makeAuthService(sessionResult: unknown): AuthService {
  return {
    sessionFromToken: vi.fn().mockResolvedValue(sessionResult),
  } as unknown as AuthService
}

// Allow-all billing unless a test overrides it.
function makeBilling(accessAllowed = true) {
  return {
    access: vi.fn().mockResolvedValue({ accessAllowed, paying: accessAllowed, found: true }),
  } as never
}

describe('AuthGuard', () => {
  let guard: AuthGuard

  it('401s when no authorization header is present', async () => {
    const auth = makeAuthService(null)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(auth.sessionFromToken).not.toHaveBeenCalled()
  })

  it('401s when header is present but does not start with "Bearer "', async () => {
    const auth = makeAuthService(null)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({ authorization: 'Basic dXNlcjpwYXNz' })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
    expect(auth.sessionFromToken).not.toHaveBeenCalled()
  })

  it('accepts "bearer " case-insensitively', async () => {
    const session = { sessionId: 's1', user: { id: 'u1' }, membership: { id: 'm1', accountId: 'acc1' } }
    const auth = makeAuthService(session)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx, req } = makeContext({ authorization: 'bearer token-abc' })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.auth).toBe(session)
    expect(auth.sessionFromToken).toHaveBeenCalledWith('token-abc')
  })

  it('accepts "Bearer " (capitalised) and "BEARER "', async () => {
    const session = { sessionId: 's1', membership: { id: 'm1', accountId: 'acc1' } }
    const auth = makeAuthService(session)
    guard = new AuthGuard(auth, makeBilling())

    const { ctx: c1 } = makeContext({ authorization: 'Bearer token1' })
    await expect(guard.canActivate(c1)).resolves.toBe(true)

    const { ctx: c2 } = makeContext({ authorization: 'BEARER token2' })
    await expect(guard.canActivate(c2)).resolves.toBe(true)
  })

  it('trims whitespace around the token', async () => {
    const session = { sessionId: 's1', membership: { id: 'm1', accountId: 'acc1' } }
    const auth = makeAuthService(session)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({ authorization: 'Bearer    spaced-token   ' })
    await guard.canActivate(ctx)
    expect(auth.sessionFromToken).toHaveBeenCalledWith('spaced-token')
  })

  it('handles header value as an array (Fastify multi-value)', async () => {
    const session = { sessionId: 's1', membership: { id: 'm1', accountId: 'acc1' } }
    const auth = makeAuthService(session)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({ authorization: ['Bearer one', 'Bearer two'] })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(auth.sessionFromToken).toHaveBeenCalledWith('one')
  })

  it('401s when sessionFromToken returns null (invalid / expired token)', async () => {
    const auth = makeAuthService(null)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({ authorization: 'Bearer rejected' })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('attaches the session context to req.auth on success', async () => {
    const session = { sessionId: 's-attached', user: { id: 'u1' }, membership: { id: 'm1' } }
    const auth = makeAuthService(session)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx, req } = makeContext({ authorization: 'Bearer ok' })
    await guard.canActivate(ctx)
    expect(req.auth).toEqual(session)
  })

  it('401s when header value is an empty array', async () => {
    const auth = makeAuthService(null)
    guard = new AuthGuard(auth, makeBilling())
    const { ctx } = makeContext({ authorization: [] })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })
})

// extractAuthFromRequest is the inner logic of the `Auth` param decorator,
// pulled out so we can unit-test it without NestJS's createParamDecorator
// metadata wiring.

describe('extractAuthFromRequest', () => {
  it('returns req.auth when set by a prior AuthGuard pass', () => {
    const session = { sessionId: 's1', user: { id: 'u1' }, membership: { id: 'm1', accountId: 'acc1' } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ auth: session, headers: {} }) }),
    } as unknown as ExecutionContext
    expect(extractAuthFromRequest(ctx)).toEqual(session)
  })

  it('throws UnauthorizedException when req.auth is missing', () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as unknown as ExecutionContext
    expect(() => extractAuthFromRequest(ctx)).toThrow(UnauthorizedException)
  })
})

describe('AuthGuard — subscription gate', () => {
  const session = {
    sessionId: 's1',
    user: { id: 'u1' },
    membership: { id: 'm1', accountId: 'acc1' },
  }

  it('402s a denied account on a normal route', async () => {
    const guard = new AuthGuard(makeAuthService(session), makeBilling(false))
    const { ctx } = makeContext({ authorization: 'Bearer t' }, '/accounts/acc1/conversations')
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException)
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 402 })
  })

  it('lets a denied account still reach the recovery routes', async () => {
    for (const url of ['/me', '/auth/sign-in', '/billing/checkout', '/health']) {
      const guard = new AuthGuard(makeAuthService(session), makeBilling(false))
      const { ctx } = makeContext({ authorization: 'Bearer t' }, url)
      await expect(guard.canActivate(ctx)).resolves.toBe(true)
    }
  })

  it('treats a request with no url as gated (defensive: not exempt)', async () => {
    const billing = makeBilling(false) as unknown as { access: ReturnType<typeof vi.fn> }
    const guard = new AuthGuard(makeAuthService(session), billing as never)
    const req = { headers: { authorization: 'Bearer t' } }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 402 })
    expect(billing.access).toHaveBeenCalledWith('acc1')
  })

  it('allows an account billing approves', async () => {
    const guard = new AuthGuard(makeAuthService(session), makeBilling(true))
    const { ctx } = makeContext({ authorization: 'Bearer t' }, '/accounts/acc1/contacts')
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })

  it('checks the gate against the session\'s own account', async () => {
    const billing = makeBilling(true) as unknown as { access: ReturnType<typeof vi.fn> }
    const guard = new AuthGuard(makeAuthService(session), billing as never)
    const { ctx } = makeContext({ authorization: 'Bearer t' }, '/accounts/acc1/contacts')
    await guard.canActivate(ctx)
    expect(billing.access).toHaveBeenCalledWith('acc1')
  })
})

describe('isBillingExempt', () => {
  it.each([
    ['/me', true],
    ['/me/', true],
    ['/auth/sign-up', true],
    ['/health', true],
    ['/billing/anything', true],
    ['/me?x=1', true],
    ['/accounts/a/conversations', false],
    ['/metrics', false],
    ['/authorised-thing', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(isBillingExempt(url)).toBe(expected)
  })
})
