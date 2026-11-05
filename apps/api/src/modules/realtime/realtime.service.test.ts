import { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock ioredis before importing the service so the Redis constructor we
// hand to lazy-init is fully controllable.
const redisInstances: Array<{
  publish: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  errorHandler?: (err: Error) => void
}> = []

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => {
      const instance = {
        publish: vi.fn().mockResolvedValue(1),
        on: vi.fn(),
        quit: vi.fn().mockResolvedValue('OK'),
        errorHandler: undefined as ((err: Error) => void) | undefined,
      }
      instance.on.mockImplementation((event: string, cb: (err: Error) => void) => {
        if (event === 'error') instance.errorHandler = cb
        return instance
      })
      redisInstances.push(instance)
      return instance
    }),
  }
})

import { RealtimeService } from './realtime.service'

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string) => overrides[key]),
  } as unknown as ConfigService
}

beforeEach(() => {
  redisInstances.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RealtimeService', () => {
  it('publishes nothing before onModuleInit (Redis client is null)', async () => {
    const svc = new RealtimeService(makeConfig())
    await expect(
      svc.publish({
        type: 'MessageCreated',
        accountId: 'acc1',
        conversationId: 'cv1',
        inboxId: 'inb1',
        messageId: 'm1',
        senderType: 'CONTACT',
        content: 'hi',
        isPrivate: false,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ).resolves.toBeUndefined()
    expect(redisInstances).toHaveLength(0)
  })

  it('onModuleInit wires a Redis client with the configured URL', () => {
    const svc = new RealtimeService(makeConfig({ REDIS_URL: 'redis://prod:6379' }))
    svc.onModuleInit()
    expect(redisInstances).toHaveLength(1)
    expect(redisInstances[0]!.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('defaults to redis://localhost:6379 when REDIS_URL not configured', () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    expect(redisInstances).toHaveLength(1)
  })

  it('publishes MessageCreated to "account:<id>" channel as JSON', async () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    const event = {
      type: 'MessageCreated' as const,
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      messageId: 'm1',
      senderType: 'CONTACT',
      content: 'hello',
      isPrivate: false,
      createdAt: '2026-01-01T00:00:00Z',
    }
    await svc.publish(event)
    expect(redisInstances[0]!.publish).toHaveBeenCalledWith(
      'account:acc1',
      JSON.stringify(event),
    )
  })

  it('publishes ConversationStatusChanged to the same channel shape', async () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    await svc.publish({
      type: 'ConversationStatusChanged',
      accountId: 'acc1',
      conversationId: 'cv1',
      status: 'RESOLVED',
      changedAt: '2026-01-01T00:00:00Z',
    })
    expect(redisInstances[0]!.publish).toHaveBeenCalledWith(
      'account:acc1',
      expect.stringContaining('ConversationStatusChanged'),
    )
  })

  it('swallows publish errors so the calling request never fails on Redis hiccups', async () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    redisInstances[0]!.publish.mockRejectedValue(new Error('CONNECTION_LOST'))
    await expect(
      svc.publish({
        type: 'MessageCreated',
        accountId: 'acc1',
        conversationId: 'cv1',
        inboxId: 'inb1',
        messageId: 'm1',
        senderType: 'CONTACT',
        content: null,
        isPrivate: false,
        createdAt: 'now',
      }),
    ).resolves.toBeUndefined()
  })

  it('onModuleDestroy calls quit on the Redis client', async () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    await svc.onModuleDestroy()
    expect(redisInstances[0]!.quit).toHaveBeenCalled()
  })

  it('onModuleDestroy swallows quit errors', async () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    redisInstances[0]!.quit.mockRejectedValue(new Error('already closed'))
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined()
  })

  it('onModuleDestroy is safe when init never ran', async () => {
    const svc = new RealtimeService(makeConfig())
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined()
  })

  it('logs but does not throw when Redis emits an error event', () => {
    const svc = new RealtimeService(makeConfig())
    svc.onModuleInit()
    // Trigger the registered error handler — should not throw.
    expect(() => redisInstances[0]!.errorHandler!(new Error('test'))).not.toThrow()
  })
})

describe('RealtimeService — team-scoped accounts', () => {
  const msg = (accountId = 'acc1', content: string | null = 'segredo do Financeiro') => ({
    type: 'MessageCreated' as const,
    accountId,
    conversationId: 'cv1',
    inboxId: 'inb1',
    messageId: 'm1',
    senderType: 'CONTACT',
    content,
    isPrivate: false,
    createdAt: '2026-01-01T00:00:00Z',
  })
  const published = () =>
    redisInstances[0]!.publish.mock.calls.map((c: unknown[]) => JSON.parse(c[1] as string))

  it('leaves the message text out when agents only see their teams, reading the flag once', async () => {
    const findUnique = vi.fn().mockResolvedValue({ teamScopedVisibility: true })
    const svc = new RealtimeService(makeConfig(), { account: { findUnique } } as never)
    svc.onModuleInit()
    await svc.publish(msg())
    await svc.publish(msg())
    expect(published().map((e: { content: string | null }) => e.content)).toEqual([null, null])
    expect(findUnique).toHaveBeenCalledTimes(1)
  })

  it('keeps it otherwise, when the lookup fails, and for events without text', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ teamScopedVisibility: false })
      .mockRejectedValueOnce(new Error('db down'))
    const svc = new RealtimeService(makeConfig(), { account: { findUnique } } as never)
    svc.onModuleInit()
    await svc.publish(msg('acc1'))
    await svc.publish(msg('acc2'))
    await svc.publish(msg('acc3', null))
    await svc.publish({ type: 'ConversationStatusChanged', accountId: 'acc4', conversationId: 'c', status: 'OPEN', changedAt: 'x' } as never)
    expect(published().map((e: { content?: string | null }) => e.content)).toEqual([
      'segredo do Financeiro',
      'segredo do Financeiro',
      null,
      undefined,
    ])
    expect(findUnique).toHaveBeenCalledTimes(2)
  })

  it('re-reads the flag after the cache window', async () => {
    vi.useFakeTimers()
    const findUnique = vi.fn().mockResolvedValue({ teamScopedVisibility: false })
    const svc = new RealtimeService(makeConfig(), { account: { findUnique } } as never)
    svc.onModuleInit()
    await svc.publish(msg())
    vi.advanceTimersByTime(31_000)
    await svc.publish(msg())
    expect(findUnique).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
