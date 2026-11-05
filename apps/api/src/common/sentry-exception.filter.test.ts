import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module-level mock so the captureException spy is reassignable. Importing
// the module after the mock declaration gives us a controllable proxy.
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
}))
import * as Sentry from '@sentry/node'

import { SentryExceptionFilter } from './sentry-exception.filter'

function makeHost() {
  const send = vi.fn()
  const status = vi.fn(() => ({ send }))
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost
  return { host, status, send }
}

describe('SentryExceptionFilter', () => {
  const captureSpy = Sentry.captureException as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    captureSpy.mockClear()
  })

  it('serializes a 4xx HttpException without reporting to Sentry', () => {
    const filter = new SentryExceptionFilter()
    const { host, status, send } = makeHost()
    filter.catch(new BadRequestException({ message: 'bad' }), host)
    expect(status).toHaveBeenCalledWith(400)
    // When BadRequestException receives an object directly, the wrapper
    // fields (error/statusCode) aren't auto-added — the body is used verbatim.
    expect(send).toHaveBeenCalledWith({ message: 'bad' })
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('serializes a 404 NotFoundException without reporting to Sentry', () => {
    const filter = new SentryExceptionFilter()
    const { host, status } = makeHost()
    filter.catch(new NotFoundException(), host)
    expect(status).toHaveBeenCalledWith(404)
    expect(captureSpy).not.toHaveBeenCalled()
  })

  it('serializes a 5xx HttpException AND reports to Sentry', () => {
    const filter = new SentryExceptionFilter()
    const { host, status } = makeHost()
    filter.catch(new InternalServerErrorException('boom'), host)
    expect(status).toHaveBeenCalledWith(500)
    expect(captureSpy).toHaveBeenCalledTimes(1)
  })

  it('serializes a non-Http exception as 500 + reports to Sentry', () => {
    const filter = new SentryExceptionFilter()
    const { host, status, send } = makeHost()
    filter.catch(new Error('totally unexpected'), host)
    expect(status).toHaveBeenCalledWith(500)
    expect(send).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    })
    expect(captureSpy).toHaveBeenCalledTimes(1)
  })

  it('handles non-Error throwables (e.g. string) gracefully', () => {
    const filter = new SentryExceptionFilter()
    const { host, send } = makeHost()
    filter.catch('a string was thrown', host)
    expect(send).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    })
    expect(captureSpy).toHaveBeenCalledWith('a string was thrown')
  })

  it('handles custom HttpException subclasses', () => {
    class CustomError extends HttpException {
      constructor() {
        super('custom failure', 502)
      }
    }
    const filter = new SentryExceptionFilter()
    const { host, status } = makeHost()
    filter.catch(new CustomError(), host)
    expect(status).toHaveBeenCalledWith(502)
    expect(captureSpy).toHaveBeenCalledTimes(1) // 502 is 5xx
  })
})
