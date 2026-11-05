import type { ApiErrorCode } from '@cosmika/shared'
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common'

import { BillingService } from '../billing/billing.service'

import { AuthService, SessionContext } from './auth.service'

const AUTH_HEADER = 'authorization'
const BEARER = 'bearer '

// Routes that stay reachable when billing says no, so a locked-out account
// can still see who it is and get to the payment link. Blocking these would
// leave the user staring at an error with no way to recover.
const BILLING_EXEMPT = ['/me', '/auth', '/health', '/billing']

export function isBillingExempt(url: string): boolean {
  const path = url.split('?')[0]!.replace(/\/+$/, '')
  return BILLING_EXEMPT.some((p) => path === p || path.startsWith(`${p}/`))
}

type AuthedRequest = {
  headers: Record<string, string | string[] | undefined>
  url?: string
  auth?: SessionContext
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const raw = req.headers[AUTH_HEADER]
    const header = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    if (!header.toLowerCase().startsWith(BEARER)) {
      throw new UnauthorizedException()
    }
    const token = header.slice(BEARER.length).trim()
    const session = await this.authService.sessionFromToken(token)
    if (!session) throw new UnauthorizedException()
    req.auth = session

    // Subscription gate. `access()` fails open (unreachable billing API, or
    // an account the billing side has never heard of, such as a migrated
    // one) so an outage can never lock out paying customers.
    if (!isBillingExempt(req.url ?? '')) {
      const access = await this.billing.access(session.membership.accountId)
      if (!access.accessAllowed) {
        throw new HttpException(
          {
            error: 'payment_required',
            code: 'subscription_inactive' satisfies ApiErrorCode,
            message: 'This account has no active subscription.',
            accountId: session.membership.accountId,
          },
          HttpStatus.PAYMENT_REQUIRED,
        )
      }
    }
    return true
  }
}

// Extracted so the logic is unit-testable without dragging in NestJS's
// createParamDecorator metadata machinery. The decorator wraps this.
export function extractAuthFromRequest(ctx: ExecutionContext): SessionContext {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>()
  if (!req.auth) throw new UnauthorizedException()
  return req.auth
}

export const Auth = createParamDecorator(
  // The arrow body is a one-line proxy to the unit-tested function
  // above; reaching it requires NestJS's request pipeline (no way to
  // call it from a unit test without mounting a controller). Coverage
  // is asserted on extractAuthFromRequest instead.
  /* c8 ignore next 2 */
  (_data: unknown, ctx: ExecutionContext): SessionContext =>
    extractAuthFromRequest(ctx),
)
