import { ExecutionContext, Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Wraps ThrottlerGuard so we can globally bypass rate limiting in dev / e2e
 * by setting `COSMIKA_DISABLE_THROTTLE=1`. The per-endpoint `@Throttle({...})`
 * decorators bind to ThrottlerGuard specifically and aren't affected by the
 * global module config, so we need a guard-level escape hatch.
 */
@Injectable()
export class MaybeThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.COSMIKA_DISABLE_THROTTLE === '1') return true
    return super.canActivate(context)
  }
}
