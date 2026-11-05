import { ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiKeysService } from './api-keys.service'
import { extractApiKeyFromRequest, PublicApiGuard } from './public-api.guard'

function makeContext(
  headers: Record<string, string | string[] | undefined>,
  apiKey?: unknown,
) {
  const req = { headers, apiKey }
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext
  return { ctx, req }
}

function makeApiKeysSvc(resolved: unknown): ApiKeysService {
  return {
    resolveToken: vi.fn().mockResolvedValue(resolved),
  } as unknown as ApiKeysService
}

describe('PublicApiGuard', () => {
  let guard: PublicApiGuard

  it('401s when authorization header missing', async () => {
    const svc = makeApiKeysSvc(null)
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({})
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('401s when header is not Bearer', async () => {
    const svc = makeApiKeysSvc(null)
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({ authorization: 'Basic xyz' })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('rejects a Bearer token that does not start with cosmika_', async () => {
    const svc = makeApiKeysSvc({ accountId: 'acc1' })
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({ authorization: 'Bearer not-a-cosmika-key' })
    await expect(guard.canActivate(ctx)).rejects.toThrow('API key required')
    expect(svc.resolveToken).not.toHaveBeenCalled()
  })

  it('401s when apiKeys.resolveToken returns null (unknown / revoked / wrong hash)', async () => {
    const svc = makeApiKeysSvc(null)
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({ authorization: 'Bearer cosmika_abcd1234_secret' })
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException)
  })

  it('attaches ApiKeyContext on success', async () => {
    const svc = makeApiKeysSvc({ accountId: 'acc-resolved' })
    guard = new PublicApiGuard(svc)
    const { ctx, req } = makeContext({ authorization: 'Bearer cosmika_abcd1234_secret' })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.apiKey).toEqual({ accountId: 'acc-resolved', authType: 'api_key' })
    expect(svc.resolveToken).toHaveBeenCalledWith('cosmika_abcd1234_secret')
  })

  it('handles header value as array (Fastify multi-value)', async () => {
    const svc = makeApiKeysSvc({ accountId: 'acc1' })
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({
      authorization: ['Bearer cosmika_abcd1234_first', 'Bearer cosmika_abcd1234_second'],
    })
    await guard.canActivate(ctx)
    expect(svc.resolveToken).toHaveBeenCalledWith('cosmika_abcd1234_first')
  })

  it('accepts BEARER case-insensitively', async () => {
    const svc = makeApiKeysSvc({ accountId: 'acc1' })
    guard = new PublicApiGuard(svc)
    const { ctx } = makeContext({ authorization: 'BEARER cosmika_abcd1234_secret' })
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
  })
})

describe('extractApiKeyFromRequest', () => {
  it('returns req.apiKey when set by a prior PublicApiGuard pass', () => {
    const apiKey = { accountId: 'acc1', authType: 'api_key' as const }
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ apiKey, headers: {} }) }),
    } as unknown as ExecutionContext
    expect(extractApiKeyFromRequest(ctx)).toEqual(apiKey)
  })

  it('throws UnauthorizedException when req.apiKey is missing', () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as unknown as ExecutionContext
    expect(() => extractApiKeyFromRequest(ctx)).toThrow(UnauthorizedException)
  })
})
