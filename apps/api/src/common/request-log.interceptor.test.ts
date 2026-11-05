import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Observable, of, throwError } from 'rxjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RequestLogInterceptor, redactUrl } from './request-log.interceptor'

function makeContext(
  req: { method: string; url: string; headers?: Record<string, string | string[] | undefined> },
  res: { statusCode: number } = { statusCode: 200 },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext
}

function makeHandler(observable: Observable<unknown>): CallHandler {
  return { handle: () => observable }
}

describe('RequestLogInterceptor', () => {
  let loggerSpy: ReturnType<typeof vi.spyOn>
  let interceptor: RequestLogInterceptor

  beforeEach(() => {
    interceptor = new RequestLogInterceptor()
    loggerSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function awaitObservable<T>(o: Observable<T>): Promise<T | { error: unknown }> {
    return new Promise((resolve) => {
      let value: T
      o.subscribe({
        next: (v) => { value = v },
        complete: () => resolve(value!),
        error: (err) => resolve({ error: err }),
      })
    })
  }

  it('emits one log line on successful response', async () => {
    const ctx = makeContext({ method: 'GET', url: '/contacts', headers: {} })
    const handler = makeHandler(of('ok'))
    await awaitObservable(interceptor.intercept(ctx, handler))
    expect(loggerSpy).toHaveBeenCalledTimes(1)
    const arg = loggerSpy.mock.calls[0]![0] as string
    const entry = JSON.parse(arg) as Record<string, unknown>
    expect(entry.method).toBe('GET')
    expect(entry.url).toBe('/contacts')
    expect(entry.status).toBe(200)
    expect(entry.request_id).toMatch(/^[0-9a-f]{16}$/) // randomBytes(8).toString('hex')
    expect(typeof entry.duration_ms).toBe('number')
  })

  it('reuses x-request-id from inbound header when present', async () => {
    const ctx = makeContext({
      method: 'POST',
      url: '/api/v1/whoami',
      headers: { 'x-request-id': 'inbound-tracer' },
    })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.request_id).toBe('inbound-tracer')
  })

  it('handles x-request-id as array (takes first element)', async () => {
    const ctx = makeContext({
      method: 'POST',
      url: '/api/v1/whoami',
      headers: { 'x-request-id': ['first', 'second'] },
    })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.request_id).toBe('first')
  })

  it('silences GET /health (noisy-paths filter)', async () => {
    const ctx = makeContext({ method: 'GET', url: '/health', headers: {} })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    expect(loggerSpy).not.toHaveBeenCalled()
  })

  it('silences GET /ready', async () => {
    const ctx = makeContext({ method: 'GET', url: '/ready', headers: {} })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    expect(loggerSpy).not.toHaveBeenCalled()
  })

  it('emits an err field on error responses', async () => {
    const ctx = makeContext({ method: 'POST', url: '/contacts', headers: {} }, { statusCode: 0 })
    const error = new Error('boom')
    await awaitObservable(interceptor.intercept(ctx, makeHandler(throwError(() => error))))
    expect(loggerSpy).toHaveBeenCalled()
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.err).toBe('boom')
    // statusCode=0 → falls back to 500 when error is present
    expect(entry.status).toBe(500)
  })

  it('logs the exception status, not the 201 Nest pre-set on a POST', async () => {
    // Fastify reply already holds the route default (201) when the handler
    // throws; the filter only swaps it for 409 after this line is written.
    const ctx = makeContext({ method: 'POST', url: '/auth/sign-up', headers: {} }, { statusCode: 201 })
    const error = new ConflictException({ error: 'email_taken', message: 'Email already registered' })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(throwError(() => error))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.status).toBe(409)
    expect(entry.err).toBe('Email already registered')
  })

  it('logs 404 for a NotFoundException on a GET pre-set to 200', async () => {
    const ctx = makeContext({ method: 'GET', url: '/contacts/x', headers: {} }, { statusCode: 200 })
    await awaitObservable(
      interceptor.intercept(ctx, makeHandler(throwError(() => new NotFoundException()))),
    )
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.status).toBe(404)
  })

  it('logs 500 for a non-HTTP error even when the reply says 201', async () => {
    const ctx = makeContext({ method: 'POST', url: '/contacts', headers: {} }, { statusCode: 201 })
    await awaitObservable(
      interceptor.intercept(ctx, makeHandler(throwError(() => new Error('db down')))),
    )
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.status).toBe(500)
  })

  it('handles non-Error throwables (string)', async () => {
    const ctx = makeContext({ method: 'POST', url: '/contacts', headers: {} }, { statusCode: 0 })
    await awaitObservable(
      interceptor.intercept(ctx, makeHandler(throwError(() => 'a string thrown'))),
    )
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.err).toBe('a string thrown')
  })

  it('uses response.statusCode when present (e.g. 201 Created)', async () => {
    const ctx = makeContext({ method: 'POST', url: '/contacts', headers: {} }, { statusCode: 201 })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.status).toBe(201)
  })

  it('falls back to status=200 on success when statusCode is 0', async () => {
    const ctx = makeContext({ method: 'GET', url: '/x', headers: {} }, { statusCode: 0 })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(entry.status).toBe(200)
  })

  it('duration_ms is a finite non-negative number', async () => {
    const ctx = makeContext({ method: 'GET', url: '/x', headers: {} })
    await awaitObservable(interceptor.intercept(ctx, makeHandler(of('ok'))))
    const entry = JSON.parse(loggerSpy.mock.calls[0]![0] as string)
    expect(Number.isFinite(entry.duration_ms)).toBe(true)
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

describe('redactUrl', () => {
  it('masks the Meta verify token and keeps the rest of the query', () => {
    expect(
      redactUrl('/webhooks/meta?hub.mode=subscribe&hub.challenge=42&hub.verify_token=abc&hub_verify_token=abc'),
    ).toBe('/webhooks/meta?hub.mode=subscribe&hub.challenge=42&hub.verify_token=[redacted]&hub_verify_token=[redacted]')
  })

  it('masks other secret-looking keys, encoded or not', () => {
    expect(redactUrl('/x?access_token=a&api_key=b&client%5Fsecret=c&page=2')).toBe(
      '/x?access_token=[redacted]&api_key=[redacted]&client%5Fsecret=[redacted]&page=2',
    )
  })

  it('keeps flag-style params and keys it cannot decode', () => {
    expect(redactUrl('/x?debug&%E0%A4%A=1&token=z')).toBe('/x?debug&%E0%A4%A=1&token=[redacted]')
  })

  it('leaves URLs without a query untouched', () => {
    expect(redactUrl('/contacts')).toBe('/contacts')
  })
})
