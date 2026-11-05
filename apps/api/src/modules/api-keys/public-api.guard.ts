import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common'

import { ApiKeysService } from './api-keys.service'

const AUTH_HEADER = 'authorization'
const BEARER = 'bearer '

export type ApiKeyContext = {
  accountId: string
  authType: 'api_key'
}

type AuthedRequest = {
  headers: Record<string, string | string[] | undefined>
  apiKey?: ApiKeyContext
}

/**
 * Guard for programmatic API endpoints. Accepts an API key in the
 * `Authorization: Bearer cosmika_<prefix>_<secret>` form and resolves it to
 * an account context. Stateless — no user identity is attached.
 */
@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const raw = req.headers[AUTH_HEADER]
    const header = (Array.isArray(raw) ? raw[0] : raw) ?? ''
    if (!header.toLowerCase().startsWith(BEARER)) {
      throw new UnauthorizedException()
    }
    const token = header.slice(BEARER.length).trim()
    if (!token.startsWith('cosmika_')) {
      throw new UnauthorizedException('API key required')
    }
    const resolved = await this.apiKeys.resolveToken(token)
    if (!resolved) throw new UnauthorizedException()
    req.apiKey = { accountId: resolved.accountId, authType: 'api_key' }
    return true
  }
}

// Extracted so the logic is unit-testable without dragging in NestJS's
// createParamDecorator metadata machinery. The decorator wraps this.
export function extractApiKeyFromRequest(ctx: ExecutionContext): ApiKeyContext {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>()
  if (!req.apiKey) throw new UnauthorizedException()
  return req.apiKey
}

export const ApiKey = createParamDecorator(
  /* c8 ignore next 2 */
  (_data: unknown, ctx: ExecutionContext): ApiKeyContext =>
    extractApiKeyFromRequest(ctx),
)
