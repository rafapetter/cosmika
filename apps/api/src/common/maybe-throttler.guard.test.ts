import type { ExecutionContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MaybeThrottlerGuard } from './maybe-throttler.guard'

describe('MaybeThrottlerGuard', () => {
  const ORIGINAL = process.env.COSMIKA_DISABLE_THROTTLE

  afterEach(() => {
    process.env.COSMIKA_DISABLE_THROTTLE = ORIGINAL
    vi.restoreAllMocks()
  })

  it('returns true immediately when COSMIKA_DISABLE_THROTTLE=1 (bypass)', async () => {
    process.env.COSMIKA_DISABLE_THROTTLE = '1'
    const guard = Object.create(MaybeThrottlerGuard.prototype) as MaybeThrottlerGuard
    const superSpy = vi.fn().mockResolvedValue(false)
    Object.getPrototypeOf(MaybeThrottlerGuard.prototype).canActivate = superSpy
    const ctx = {} as ExecutionContext
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(superSpy).not.toHaveBeenCalled()
  })

  it('falls through to ThrottlerGuard.canActivate when the env var is not "1"', async () => {
    process.env.COSMIKA_DISABLE_THROTTLE = '0'
    const guard = Object.create(MaybeThrottlerGuard.prototype) as MaybeThrottlerGuard
    const superSpy = vi.fn().mockResolvedValue(true)
    Object.getPrototypeOf(MaybeThrottlerGuard.prototype).canActivate = superSpy
    const ctx = {} as ExecutionContext
    await guard.canActivate(ctx)
    expect(superSpy).toHaveBeenCalledWith(ctx)
  })

  it('falls through when env var is unset', async () => {
    delete process.env.COSMIKA_DISABLE_THROTTLE
    const guard = Object.create(MaybeThrottlerGuard.prototype) as MaybeThrottlerGuard
    const superSpy = vi.fn().mockResolvedValue(true)
    Object.getPrototypeOf(MaybeThrottlerGuard.prototype).canActivate = superSpy
    const ctx = {} as ExecutionContext
    await guard.canActivate(ctx)
    expect(superSpy).toHaveBeenCalled()
  })
})
