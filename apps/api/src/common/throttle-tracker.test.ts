import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { ThrottlerStorageService } from '@nestjs/throttler'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MaybeThrottlerGuard } from './maybe-throttler.guard'
import { trustProxyFromEnv } from './trust-proxy'

// The throttle's tracker is `req.ip`. These tests run real Fastify requests
// (same adapter options as main.ts) through the real guard and storage, so
// they show who shares a bucket: before trustProxy, every visitor behind
// Caddy arrived as the Docker gateway and shared one.

const GATEWAY = '172.18.0.1'
const ROUTES = `Iface\tDestination\tGateway\neth0\t00000000\t010012AC\n`

// The adapter's own instance type; `fastify` is not a direct dependency here.
type FastifyInstance = FastifyAdapter extends FastifyAdapter<
  infer _S, infer _Q, infer _R, infer _Rq, infer _Rp, infer I
>
  ? I
  : never

class SignUp {
  handle() {}
}

async function buildApp(trustProxy: string[] | false, limit = 2): Promise<FastifyInstance> {
  const guard = new MaybeThrottlerGuard(
    [{ name: 'default', ttl: 60_000, limit }],
    new ThrottlerStorageService(),
    new Reflector(),
  )
  await guard.onModuleInit()
  const app = new FastifyAdapter({ trustProxy }).getInstance<FastifyInstance>()
  app.get('/sign-up', async (req, reply) => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
      getHandler: () => SignUp.prototype.handle,
      getClass: () => SignUp,
    } as unknown as ExecutionContext
    try {
      await guard.canActivate(ctx)
      return { ip: req.ip }
    } catch {
      return reply.code(429).send({ ip: req.ip })
    }
  })
  return app
}

function hit(app: FastifyInstance, remoteAddress: string, xff?: string) {
  return app.inject({
    method: 'GET',
    url: '/sign-up',
    remoteAddress,
    headers: xff ? { 'x-forwarded-for': xff } : {},
  })
}

describe('throttle tracker behind Caddy', () => {
  const ORIGINAL = process.env.COSMIKA_DISABLE_THROTTLE
  let app: FastifyInstance

  beforeEach(() => {
    process.env.COSMIKA_DISABLE_THROTTLE = '0'
  })
  afterEach(async () => {
    process.env.COSMIKA_DISABLE_THROTTLE = ORIGINAL
    await app?.close()
  })

  it('without trustProxy every visitor is the gateway and shares one bucket (the bug)', async () => {
    app = await buildApp(false)
    const a = await hit(app, GATEWAY, '200.1.1.1')
    const b = await hit(app, GATEWAY, '200.2.2.2')
    const c = await hit(app, GATEWAY, '200.3.3.3')
    expect(a.json().ip).toBe(GATEWAY)
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 429])
  })

  it('with the default trust, each visitor behind the gateway gets their own bucket', async () => {
    app = await buildApp(trustProxyFromEnv({}, () => ROUTES))
    const statuses: number[] = []
    for (const ip of ['200.1.1.1', '200.2.2.2', '200.3.3.3']) {
      const res = await hit(app, GATEWAY, ip)
      expect(res.json().ip).toBe(ip)
      statuses.push(res.statusCode)
    }
    expect(statuses).toEqual([200, 200, 200])
  })

  it('still limits a single visitor behind the gateway', async () => {
    app = await buildApp(trustProxyFromEnv({}, () => ROUTES))
    const codes = []
    for (let i = 0; i < 3; i++) codes.push((await hit(app, GATEWAY, '200.1.1.1')).statusCode)
    expect(codes).toEqual([200, 200, 429])
  })

  it('also trusts a proxy on loopback', async () => {
    app = await buildApp(trustProxyFromEnv({}, () => ROUTES))
    expect((await hit(app, '127.0.0.1', '200.9.9.9')).json().ip).toBe('200.9.9.9')
  })

  it('ignores X-Forwarded-For from anyone else, so rotating it does not reset the limit', async () => {
    app = await buildApp(trustProxyFromEnv({}, () => ROUTES))
    const codes = []
    for (const spoof of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const res = await hit(app, '203.0.113.7', spoof)
      expect(res.json().ip).toBe('203.0.113.7')
      codes.push(res.statusCode)
    }
    expect(codes).toEqual([200, 200, 429])
  })

  it('takes the hop the gateway saw, not a value the client prepended', async () => {
    app = await buildApp(trustProxyFromEnv({}, () => ROUTES))
    // A client sending its own X-Forwarded-For through a proxy that appends.
    const res = await hit(app, GATEWAY, '6.6.6.6, 200.1.1.1')
    expect(res.json().ip).toBe('200.1.1.1')
  })
})
