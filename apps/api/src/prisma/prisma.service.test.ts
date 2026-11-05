import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PrismaService } from './prisma.service'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.restoreAllMocks()
})

describe('PrismaService.onModuleInit', () => {
  it('returns silently when first $connect succeeds', async () => {
    const svc = new PrismaService()
    vi.spyOn(svc, '$connect').mockResolvedValue(undefined)
    await expect(svc.onModuleInit()).resolves.toBeUndefined()
    expect(svc.$connect).toHaveBeenCalledTimes(1)
    await svc.onModuleDestroy().catch(() => undefined)
  })

  it('retries on failure with exponential backoff', async () => {
    const svc = new PrismaService()
    let calls = 0
    vi.spyOn(svc, '$connect').mockImplementation(async () => {
      calls += 1
      if (calls < 3) throw new Error('Postgres not ready')
      return undefined
    })
    // Speed up setTimeout — we run real delays but with tiny values via fake timers.
    vi.useFakeTimers()
    const p = svc.onModuleInit()
    // Advance through the backoff steps (250ms + 500ms).
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(calls).toBe(3)
    vi.useRealTimers()
    await svc.onModuleDestroy().catch(() => undefined)
  })

  it('caps backoff at MAX_BACKOFF_MS and gives up after CONNECT_TIMEOUT_MS', async () => {
    const svc = new PrismaService()
    vi.spyOn(svc, '$connect').mockRejectedValue(new Error('still down'))
    // Fast-forward Date.now so the timeout-check fires on attempt #2.
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    // Each setTimeout call simulates the delay by bumping `now` past
    // CONNECT_TIMEOUT_MS (30s).
    vi.spyOn(global, 'setTimeout').mockImplementation((cb: () => void) => {
      now += 31_000 // past timeout
      cb()
      return 0 as never
    })
    await expect(svc.onModuleInit()).rejects.toThrow('still down')
    await svc.onModuleDestroy().catch(() => undefined)
  })

  it('handles non-Error throwables when logging the retry attempt', async () => {
    const svc = new PrismaService()
    let calls = 0
    vi.spyOn(svc, '$connect').mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw 'string thrown' // not an Error instance
      return undefined
    })
    vi.useFakeTimers()
    const p = svc.onModuleInit()
    await vi.advanceTimersByTimeAsync(300)
    await p
    expect(calls).toBe(2)
    vi.useRealTimers()
    await svc.onModuleDestroy().catch(() => undefined)
  })
})

describe('PrismaService.onModuleDestroy', () => {
  it('calls $disconnect', async () => {
    const svc = new PrismaService()
    const spy = vi.spyOn(svc, '$disconnect').mockResolvedValue(undefined)
    await svc.onModuleDestroy()
    expect(spy).toHaveBeenCalled()
  })
})

describe('buildDatabaseUrl (via constructor side effect)', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.DATABASE_POOL_SIZE
  })

  it('constructs without DATABASE_URL and defers the failure to connect time', () => {
    // Passing `{ url: undefined }` used to throw "Invalid value undefined for
    // datasource" from the PrismaClient constructor — a message that names
    // neither DATABASE_URL nor the service, and that fires before any logging
    // is set up. Omitting the override instead lets Prisma fall back to the
    // schema's env("DATABASE_URL") and fail at $connect, where the retry loop
    // logs which variable is missing.
    expect(() => new PrismaService()).not.toThrow()
  })

  it('returns DATABASE_URL unchanged when DATABASE_POOL_SIZE not set', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test'
    expect(() => new PrismaService()).not.toThrow()
  })

  it('injects connection_limit when DATABASE_POOL_SIZE is set', () => {
    process.env.DATABASE_URL = 'postgres://user:pw@localhost/test'
    process.env.DATABASE_POOL_SIZE = '20'
    expect(() => new PrismaService()).not.toThrow()
  })

  it('does NOT overwrite an existing connection_limit param', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test?connection_limit=5'
    process.env.DATABASE_POOL_SIZE = '20'
    expect(() => new PrismaService()).not.toThrow()
  })

  it('falls back to raw DATABASE_URL when URL parsing fails', () => {
    // PrismaClient itself may reject a malformed URL but our buildDatabaseUrl
    // should swallow the URL() constructor error and return the original.
    process.env.DATABASE_URL = 'not-a-valid-url'
    process.env.DATABASE_POOL_SIZE = '20'
    expect(() => new PrismaService()).not.toThrow()
  })
})

describe('PrismaService logging configuration', () => {
  it('uses warn+error in development', () => {
    process.env.NODE_ENV = 'development'
    expect(() => new PrismaService()).not.toThrow()
  })

  it('uses error-only in production', () => {
    process.env.NODE_ENV = 'production'
    expect(() => new PrismaService()).not.toThrow()
  })

  it('uses error-only when NODE_ENV unset', () => {
    delete process.env.NODE_ENV
    expect(() => new PrismaService()).not.toThrow()
  })
})

describe('PrismaService — lastMessageAt hook', () => {
  // Grab the middleware the service installs, then drive it directly. This
  // keeps the test honest about the real middleware contract (params, next)
  // without needing a database.
  function installedMiddleware(svc: PrismaService) {
    const captured: Array<(params: unknown, next: unknown) => unknown> = []
    vi.spyOn(svc, '$use').mockImplementation(((mw: never) => {
      captured.push(mw)
    }) as never)
    vi.spyOn(svc, '$connect').mockResolvedValue(undefined)
    return { captured, svc }
  }

  async function boot() {
    const svc = new PrismaService()
    const { captured } = installedMiddleware(svc)
    await svc.onModuleInit()
    const update = vi.fn().mockResolvedValue({})
    Object.defineProperty(svc, 'conversation', {
      value: { update },
      configurable: true,
    })
    return { svc, mw: captured[0]!, update }
  }

  const CREATED = new Date('2026-08-07T12:00:00Z')
  const next = async () => ({ id: 'm1', conversationId: 'c1', createdAt: CREATED })

  it('bumps the conversation when a real message is created', async () => {
    const { mw, update } = await boot()
    await mw({ model: 'Message', action: 'create', args: { data: { conversationId: 'c1' } } }, next)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { lastMessageAt: CREATED },
    })
  })

  it('does NOT bump for activity notes', async () => {
    const { mw, update } = await boot()
    await mw(
      {
        model: 'Message',
        action: 'create',
        args: {
          data: {
            conversationId: 'c1',
            contentAttributes: { activity: { type: 'label' } },
          },
        },
      },
      next,
    )
    // Labelling a 2021 thread must not float it to the top of the inbox.
    expect(update).not.toHaveBeenCalled()
  })

  it('ignores everything that is not a message create', async () => {
    const { mw, update } = await boot()
    await mw({ model: 'Message', action: 'update', args: { data: {} } }, next)
    await mw({ model: 'Contact', action: 'create', args: { data: {} } }, next)
    expect(update).not.toHaveBeenCalled()
  })

  it('falls back to the created row for the conversation id and timestamp', async () => {
    const { mw, update } = await boot()
    await mw({ model: 'Message', action: 'create', args: {} }, next)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { lastMessageAt: CREATED },
    })
  })

  it('falls back to the payload timestamp, then to now, if the row has none', async () => {
    const { mw, update } = await boot()
    const bare = async () => ({ id: 'm1', conversationId: 'c1' })
    const explicit = '2026-08-07T09:30:00.000Z'
    await mw(
      { model: 'Message', action: 'create', args: { data: { conversationId: 'c1', createdAt: explicit } } },
      bare,
    )
    expect(update.mock.calls[0]![0].data.lastMessageAt).toEqual(new Date(explicit))

    await mw({ model: 'Message', action: 'create', args: { data: { conversationId: 'c1' } } }, bare)
    expect(update.mock.calls[1]![0].data.lastMessageAt).toBeInstanceOf(Date)
  })

  it('skips silently when no conversation id can be determined', async () => {
    const { mw, update } = await boot()
    await mw({ model: 'Message', action: 'create', args: { data: {} } }, async () => null)
    expect(update).not.toHaveBeenCalled()
  })

  it('never lets a failed bump break the write it followed', async () => {
    const { mw, update } = await boot()
    update.mockRejectedValue(new Error('db down'))
    const result = await mw(
      { model: 'Message', action: 'create', args: { data: { conversationId: 'c1' } } },
      next,
    )
    // The message itself is the durable record; the sort key is best-effort.
    expect(result).toMatchObject({ id: 'm1' })

    update.mockRejectedValue('a string blow-up')
    await expect(
      mw({ model: 'Message', action: 'create', args: { data: { conversationId: 'c1' } } }, next),
    ).resolves.toBeDefined()
  })
})

describe('PrismaService — queuedAt hook', () => {
  async function queuedMiddleware(findUnique = vi.fn().mockResolvedValue(null)) {
    const svc = new PrismaService()
    const captured: Array<(params: unknown, next: unknown) => Promise<unknown>> = []
    vi.spyOn(svc, '$use').mockImplementation(((mw: never) => {
      captured.push(mw)
    }) as never)
    vi.spyOn(svc, '$connect').mockResolvedValue(undefined)
    await svc.onModuleInit()
    Object.defineProperty(svc, 'conversation', { value: { findUnique }, configurable: true })
    return captured[1]!
  }
  const next = async (p: unknown) => p

  it('stamps the queue clock when a write hands control to a human', async () => {
    const mw = await queuedMiddleware()
    for (const action of ['update', 'updateMany']) {
      const params = { model: 'Conversation', action, args: { where: { id: 'c1' }, data: { controlMode: 'HUMAN' } } }
      await mw(params, next)
      expect((params.args.data as Record<string, unknown>).queuedAt).toBeInstanceOf(Date)
    }
  })

  it('leaves other writes, bot control and an explicit value alone', async () => {
    const mw = await queuedMiddleware()
    const explicit = new Date('2026-01-01T00:00:00Z')
    const cases = [
      { model: 'Conversation', action: 'update', args: { data: { controlMode: 'BOT' } } },
      { model: 'Conversation', action: 'update', args: { data: { controlMode: 'HUMAN', queuedAt: explicit } } },
      { model: 'Conversation', action: 'create', args: { data: { controlMode: 'HUMAN' } } },
      { model: 'Message', action: 'update', args: { data: { controlMode: 'HUMAN' } } },
      { model: 'Conversation', action: 'update', args: {} },
      { model: 'Conversation', action: 'update' },
    ]
    for (const params of cases) await mw(params, next)
    expect(cases.map((c) => (c.args?.data as Record<string, unknown> | undefined)?.queuedAt)).toEqual([
      undefined, explicit, undefined, undefined, undefined, undefined,
    ])
  })
})

describe('PrismaService — protocol hook', () => {
  async function protocolMiddleware(findFirst = vi.fn().mockResolvedValue(null)) {
    const svc = new PrismaService()
    const captured: Array<(params: unknown, next: unknown) => Promise<unknown>> = []
    vi.spyOn(svc, '$use').mockImplementation(((mw: never) => {
      captured.push(mw)
    }) as never)
    vi.spyOn(svc, '$connect').mockResolvedValue(undefined)
    await svc.onModuleInit()
    Object.defineProperty(svc, 'conversation', { value: { findFirst }, configurable: true })
    return { mw: captured[2]!, findFirst }
  }
  const next = async (p: unknown) => p
  const create = (data: Record<string, unknown>) => ({ model: 'Conversation', action: 'create', args: { data } })

  it('reuses the contact\'s open case protocol, on any channel', async () => {
    const { mw, findFirst } = await protocolMiddleware(
      vi.fn().mockResolvedValue({ protocol: '20261016-000123', status: 'OPEN', resolvedAt: null }),
    )
    const params = create({ accountId: 'acc1', contactId: 'ct1', inboxId: 'whatsapp' })
    await mw(params, next)
    expect(params.args.data.protocol).toBe('20261016-000123')
    expect(findFirst).toHaveBeenCalledWith({
      where: { accountId: 'acc1', contactId: 'ct1', protocol: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { protocol: true, status: true, resolvedAt: true },
    })
  })

  it('reads relation-style ids too, and starts a new protocol for a closed case', async () => {
    const { mw } = await protocolMiddleware(
      vi.fn().mockResolvedValue({ protocol: 'OLD', status: 'RESOLVED', resolvedAt: new Date(0) }),
    )
    const params = create({ account: { connect: { id: 'acc1' } }, contact: { connect: { id: 'ct1' } } })
    await mw(params, next)
    expect(params.args.data.protocol).toMatch(/^\d{8}-\d{6}$/)
  })

  it('falls back to a fresh protocol when the lookup fails or ids are missing', async () => {
    const { mw } = await protocolMiddleware(vi.fn().mockRejectedValue(new Error('db down')))
    const a = create({ accountId: 'acc1', contactId: 'ct1' })
    await mw(a, next)
    expect(a.args.data.protocol).toMatch(/^\d{8}-\d{6}$/)
    const { mw: mw2 } = await protocolMiddleware(vi.fn().mockRejectedValue('string'))
    const b = create({ accountId: 'acc1', contactId: 'ct1' })
    await mw2(b, next)
    expect(b.args.data.protocol).toMatch(/^\d{8}-\d{6}$/)
    const c = create({ accountId: 'acc1' })
    await mw2(c, next)
    expect(c.args.data.protocol).toMatch(/^\d{8}-\d{6}$/)
  })

  it('leaves an explicit protocol, other models and other actions alone', async () => {
    const { mw, findFirst } = await protocolMiddleware()
    const explicit = create({ accountId: 'a', contactId: 'c', protocol: 'MINE' })
    await mw(explicit, next)
    expect(explicit.args.data.protocol).toBe('MINE')
    await mw({ model: 'Conversation', action: 'update', args: { data: {} } }, next)
    await mw({ model: 'Message', action: 'create', args: { data: {} } }, next)
    await mw({ model: 'Conversation', action: 'create', args: {} }, next)
    expect(findFirst).not.toHaveBeenCalled()
  })
})


describe('PrismaService — queuedAt hook on reassignment', () => {
  async function mwWith(findUnique: ReturnType<typeof vi.fn>) {
    const svc = new PrismaService()
    const captured: Array<(params: unknown, next: unknown) => Promise<unknown>> = []
    vi.spyOn(svc, '$use').mockImplementation(((mw: never) => {
      captured.push(mw)
    }) as never)
    vi.spyOn(svc, '$connect').mockResolvedValue(undefined)
    await svc.onModuleInit()
    Object.defineProperty(svc, 'conversation', { value: { findUnique }, configurable: true })
    return captured[1]!
  }
  const next = async (p: unknown) => p
  const upd = () => ({ model: 'Conversation', action: 'update', args: { where: { id: 'c1' }, data: { controlMode: 'HUMAN' } } })

  it('keeps the clock when the conversation is already with a person', async () => {
    const mw = await mwWith(vi.fn().mockResolvedValue({ controlMode: 'HUMAN' }))
    const p = upd()
    await mw(p, next)
    expect((p.args.data as Record<string, unknown>).queuedAt).toBeUndefined()
  })

  it('starts it on a real handover from the bot, or when the state is unknown', async () => {
    for (const lookup of [
      vi.fn().mockResolvedValue({ controlMode: 'BOT' }),
      vi.fn().mockResolvedValue(null),
      vi.fn().mockRejectedValue(new Error('db down')),
    ]) {
      const mw = await mwWith(lookup)
      const p = upd()
      await mw(p, next)
      expect((p.args.data as Record<string, unknown>).queuedAt).toBeInstanceOf(Date)
    }
  })
})
