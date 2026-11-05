import { randomBytes } from 'node:crypto'

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common'
import { Observable, tap } from 'rxjs'

const NOISY_PATHS = new Set(['/health', '/ready'])

/** Query keys whose values never reach the log (Meta's hub.verify_token, etc.). */
const SECRET_QUERY_KEY = /token|secret|password|signature|api[_-]?key/i

/** The URL with secret-looking query values masked; the path stays as is. */
export function redactUrl(url: string): string {
  const at = url.indexOf('?')
  if (at === -1) return url
  const query = url
    .slice(at + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return pair
      let key = pair.slice(0, eq)
      try {
        key = decodeURIComponent(key)
      } catch {
        // keep the raw key
      }
      return SECRET_QUERY_KEY.test(key) ? `${pair.slice(0, eq)}=[redacted]` : pair
    })
    .join('&')
  return `${url.slice(0, at)}?${query}`
}

/**
 * The status an error response actually goes out with. Nest sets the route's
 * default code (201 for a POST) on the reply BEFORE the handler runs, and the
 * exception filter only replaces it after this interceptor has logged, so
 * `res.statusCode` still read 201 for a 409 (sign-up, 2026-10-20). Mirrors
 * SentryExceptionFilter: HttpException carries its code, anything else is 500.
 */
export function errorStatus(err: unknown): number {
  return err instanceof HttpException
    ? err.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR
}

type LoggedRequest = {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

type LoggedResponse = {
  statusCode: number
}

/**
 * Lightweight per-request log. Emits one line per response with method,
 * route, status, duration, and a generated requestId (so downstream logs
 * can be correlated). Single dependency-free `Logger.log` for now —
 * easy to swap for pino later without touching call sites.
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('http')

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp()
    const req = http.getRequest<LoggedRequest>()
    const res = http.getResponse<LoggedResponse>()
    const start = process.hrtime.bigint()
    const existing = req.headers['x-request-id']
    const requestId = (Array.isArray(existing) ? existing[0] : existing) ??
      randomBytes(8).toString('hex')

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, res, start, requestId, null),
        error: (err) => this.emit(req, res, start, requestId, err),
      }),
    )
  }

  private emit(
    req: LoggedRequest,
    res: LoggedResponse,
    start: bigint,
    requestId: string,
    err: unknown,
  ): void {
    if (NOISY_PATHS.has(req.url)) return
    const ns = process.hrtime.bigint() - start
    const durationMs = Number(ns) / 1_000_000
    const status = err ? errorStatus(err) : res.statusCode || 200
    const entry: Record<string, unknown> = {
      method: req.method,
      url: redactUrl(req.url),
      status,
      duration_ms: Number(durationMs.toFixed(2)),
      request_id: requestId,
    }
    if (err) {
      entry.err = err instanceof Error ? err.message : String(err)
    }
    this.logger.log(JSON.stringify(entry))
  }
}
