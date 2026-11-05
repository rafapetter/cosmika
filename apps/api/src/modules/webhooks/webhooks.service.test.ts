import { createHmac } from 'node:crypto'

import { ForbiddenException, NotFoundException } from '@nestjs/common'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'

// Mock the SSRF guard. Default behaviour: pass-through (resolve to a URL).
// Individual tests override with `mockRejectedValueOnce` to assert the
// guard's failure paths.
vi.mock('../../common/safe-fetch', () => ({
  assertSafeFetchUrl: vi.fn(async (raw: string) => new URL(raw)),
}))

import { assertSafeFetchUrl } from '../../common/safe-fetch'
import { WebhooksService } from './webhooks.service'

const mockedAssertSafeFetchUrl = assertSafeFetchUrl as unknown as Mock

// ---------- helpers ----------

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    webhook: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    webhookDelivery: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): WebhooksService {
  return new WebhooksService(prisma as never)
}

const ADMIN_MEMBER = {
  accountId: 'acc1',
  userId: 'u1',
  role: 'ADMINISTRATOR',
  isActive: true,
}

const AGENT_MEMBER = {
  accountId: 'acc1',
  userId: 'u1',
  role: 'AGENT',
  isActive: true,
}

const WEBHOOK = {
  id: 'wh1',
  accountId: 'acc1',
  name: 'orders',
  url: 'https://hooks.example.com/orders',
  events: ['conversation.created'],
  secret: 'whsec_test-secret-value',
  isActive: true,
  createdAt: new Date('2026-05-25T12:00:00.000Z'),
}

// ---------- admin guard (assertAdmin) ----------

describe('WebhooksService.assertAdmin (exercised via list)', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
  })

  it('throws ForbiddenException when membership not found', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException when membership exists but is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      ...ADMIN_MEMBER,
      isActive: false,
    })
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('throws ForbiddenException with admin-required message when role is AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT_MEMBER)
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(
      'Administrator role required',
    )
  })

  it('passes the guard for ADMINISTRATOR + active membership', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
    prisma.webhook.findMany.mockResolvedValue([])
    await expect(svc.list('u1', 'acc1')).resolves.toEqual([])
    expect(prisma.accountMember.findUnique).toHaveBeenCalledWith({
      where: { accountId_userId: { accountId: 'acc1', userId: 'u1' } },
    })
  })
})

// ---------- list ----------

describe('WebhooksService.list', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('returns webhooks for the account, ordered by createdAt desc', async () => {
    prisma.webhook.findMany.mockResolvedValue([WEBHOOK])
    const out = await svc.list('u1', 'acc1')
    expect(out).toEqual([WEBHOOK])
    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'desc' },
    })
  })
})

// ---------- create ----------

describe('WebhooksService.create', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('persists a webhook with a freshly-generated whsec_ secret', async () => {
    prisma.webhook.create.mockImplementation(async ({ data }) => ({
      id: 'wh-new',
      ...data,
      isActive: true,
      createdAt: new Date(),
    }))
    const out = await svc.create('u1', 'acc1', {
      name: 'orders',
      url: 'https://hooks.example.com/orders',
      events: ['conversation.created'],
    })
    expect(out.id).toBe('wh-new')
    expect(prisma.webhook.create).toHaveBeenCalledTimes(1)
    const data = (prisma.webhook.create.mock.calls[0]![0] as { data: { secret: string; accountId: string; name: string; url: string; events: string[] } }).data
    expect(data.accountId).toBe('acc1')
    expect(data.name).toBe('orders')
    expect(data.url).toBe('https://hooks.example.com/orders')
    expect(data.events).toEqual(['conversation.created'])
    expect(data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/)
  })

  it('generates a different secret on each call', async () => {
    prisma.webhook.create.mockImplementation(async ({ data }) => ({
      id: 'wh-x',
      ...data,
      isActive: true,
      createdAt: new Date(),
    }))
    await svc.create('u1', 'acc1', {
      name: 'a',
      url: 'https://hooks.example.com/a',
      events: ['conversation.created'],
    })
    await svc.create('u1', 'acc1', {
      name: 'b',
      url: 'https://hooks.example.com/b',
      events: ['conversation.created'],
    })
    const s1 = (prisma.webhook.create.mock.calls[0]![0] as { data: { secret: string } }).data.secret
    const s2 = (prisma.webhook.create.mock.calls[1]![0] as { data: { secret: string } }).data.secret
    expect(s1).not.toBe(s2)
  })
})

// ---------- update ----------

describe('WebhooksService.update', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('404s when webhook does not exist', async () => {
    prisma.webhook.findUnique.mockResolvedValue(null)
    await expect(
      svc.update('u1', 'acc1', 'wh-missing', { name: 'x' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when webhook belongs to a different account (IDOR guard)', async () => {
    prisma.webhook.findUnique.mockResolvedValue({ ...WEBHOOK, accountId: 'acc2' })
    await expect(
      svc.update('u1', 'acc1', WEBHOOK.id, { name: 'x' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('builds the update data from only the provided fields (name)', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue({ ...WEBHOOK, name: 'renamed' })
    await svc.update('u1', 'acc1', WEBHOOK.id, { name: 'renamed' })
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: { name: 'renamed' },
    })
  })

  it('builds the update data from only the provided fields (url)', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue(WEBHOOK)
    await svc.update('u1', 'acc1', WEBHOOK.id, { url: 'https://new.example.com/x' })
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: { url: 'https://new.example.com/x' },
    })
  })

  it('builds the update data from only the provided fields (events)', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue(WEBHOOK)
    await svc.update('u1', 'acc1', WEBHOOK.id, { events: ['message.created'] })
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: { events: ['message.created'] },
    })
  })

  it('builds the update data from only the provided fields (isActive)', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue({ ...WEBHOOK, isActive: false })
    await svc.update('u1', 'acc1', WEBHOOK.id, { isActive: false })
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: { isActive: false },
    })
  })

  it('builds the update data from all provided fields at once', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue(WEBHOOK)
    await svc.update('u1', 'acc1', WEBHOOK.id, {
      name: 'n',
      url: 'https://x.example.com/',
      events: ['contact.created'],
      isActive: true,
    })
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: {
        name: 'n',
        url: 'https://x.example.com/',
        events: ['contact.created'],
        isActive: true,
      },
    })
  })

  it('passes an empty data object when no fields are provided', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.update.mockResolvedValue(WEBHOOK)
    await svc.update('u1', 'acc1', WEBHOOK.id, {})
    expect(prisma.webhook.update).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
      data: {},
    })
  })
})

// ---------- remove ----------

describe('WebhooksService.remove', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('404s when webhook does not exist', async () => {
    prisma.webhook.findUnique.mockResolvedValue(null)
    await expect(svc.remove('u1', 'acc1', 'wh-missing')).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.webhook.delete).not.toHaveBeenCalled()
  })

  it('404s when webhook belongs to a different account', async () => {
    prisma.webhook.findUnique.mockResolvedValue({ ...WEBHOOK, accountId: 'acc2' })
    await expect(svc.remove('u1', 'acc1', WEBHOOK.id)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes the webhook on success', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhook.delete.mockResolvedValue(WEBHOOK)
    await svc.remove('u1', 'acc1', WEBHOOK.id)
    expect(prisma.webhook.delete).toHaveBeenCalledWith({
      where: { id: WEBHOOK.id },
    })
  })
})

// ---------- listDeliveries ----------

describe('WebhooksService.listDeliveries', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('404s when webhook not found', async () => {
    prisma.webhook.findUnique.mockResolvedValue(null)
    await expect(svc.listDeliveries('u1', 'acc1', 'wh-x')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s on IDOR (webhook belongs to other account)', async () => {
    prisma.webhook.findUnique.mockResolvedValue({ ...WEBHOOK, accountId: 'acc2' })
    await expect(svc.listDeliveries('u1', 'acc1', WEBHOOK.id)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns deliveries with the default limit of 50', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhookDelivery.findMany.mockResolvedValue([{ id: 'd1' }])
    const out = await svc.listDeliveries('u1', 'acc1', WEBHOOK.id)
    expect(out).toEqual([{ id: 'd1' }])
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith({
      where: { webhookId: WEBHOOK.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
  })

  it('respects a custom limit', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhookDelivery.findMany.mockResolvedValue([])
    await svc.listDeliveries('u1', 'acc1', WEBHOOK.id, 10)
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    )
  })
})

// ---------- dispatch ----------

describe('WebhooksService.dispatch', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
  })

  it('no-ops when no webhooks are subscribed to the event', async () => {
    prisma.webhook.findMany.mockResolvedValue([])
    await svc.dispatch('acc1', 'conversation.created', { foo: 'bar' })
    expect(prisma.webhookDelivery.createMany).not.toHaveBeenCalled()
  })

  it('inserts a PENDING delivery row per subscribed webhook', async () => {
    prisma.webhook.findMany.mockResolvedValue([{ id: 'wh1' }, { id: 'wh2' }])
    prisma.webhookDelivery.createMany.mockResolvedValue({ count: 2 })
    await svc.dispatch('acc1', 'message.created', { msg: 'hi' })
    expect(prisma.webhook.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', isActive: true, events: { has: 'message.created' } },
      select: { id: true },
    })
    const args = prisma.webhookDelivery.createMany.mock.calls[0]![0] as {
      data: Array<{
        webhookId: string
        event: string
        payload: unknown
        status: string
        nextRetryAt: Date
      }>
    }
    expect(args.data).toHaveLength(2)
    expect(args.data[0]!.webhookId).toBe('wh1')
    expect(args.data[0]!.event).toBe('message.created')
    expect(args.data[0]!.payload).toEqual({ msg: 'hi' })
    expect(args.data[0]!.status).toBe('PENDING')
    expect(args.data[0]!.nextRetryAt).toBeInstanceOf(Date)
    expect(args.data[1]!.webhookId).toBe('wh2')
  })
})

// ---------- attemptDelivery (exercised via processDueDeliveries) ----------

describe('WebhooksService.processDueDeliveries (HTTP + retry)', () => {
  let prisma: Prisma
  let svc: WebhooksService
  const ORIG_FETCH = globalThis.fetch

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    mockedAssertSafeFetchUrl.mockReset()
    mockedAssertSafeFetchUrl.mockImplementation(async (raw: string) => new URL(raw))
  })

  afterEach(() => {
    globalThis.fetch = ORIG_FETCH
    vi.restoreAllMocks()
  })

  function makeDeliveryRow(overrides: Partial<{
    id: string
    attempts: number
    payload: unknown
    event: string
    webhook: typeof WEBHOOK
  }> = {}) {
    return {
      id: overrides.id ?? 'd1',
      attempts: overrides.attempts ?? 0,
      payload: overrides.payload ?? { foo: 'bar' },
      event: overrides.event ?? 'conversation.created',
      webhook: overrides.webhook ?? WEBHOOK,
    }
  }

  it('returns 0 when no deliveries are due', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([])
    const out = await svc.processDueDeliveries()
    expect(out).toBe(0)
  })

  it('queries PENDING deliveries with nextRetryAt <= now, ordered asc, capped at 50', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([])
    await svc.processDueDeliveries()
    const args = prisma.webhookDelivery.findMany.mock.calls[0]![0] as {
      where: { status: string; nextRetryAt: { lte: Date } }
      include: { webhook: boolean }
      orderBy: { nextRetryAt: string }
      take: number
    }
    expect(args.where.status).toBe('PENDING')
    expect(args.where.nextRetryAt.lte).toBeInstanceOf(Date)
    expect(args.include.webhook).toBe(true)
    expect(args.orderBy.nextRetryAt).toBe('asc')
    expect(args.take).toBe(50)
  })

  it('signs the body with HMAC-SHA256 of the webhook secret and sends required headers', async () => {
    const row = makeDeliveryRow()
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await svc.processDueDeliveries()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(WEBHOOK.url)
    const initTyped = init as RequestInit & { headers: Record<string, string>; body: string }
    expect(initTyped.method).toBe('POST')
    expect(initTyped.redirect).toBe('manual')
    expect(initTyped.headers['content-type']).toBe('application/json')
    expect(initTyped.headers['x-cosmika-event']).toBe('conversation.created')
    expect(initTyped.headers['x-cosmika-attempt']).toBe('1')

    // Independently compute the expected HMAC over the body the service sent.
    const expectedSig =
      'sha256=' + createHmac('sha256', WEBHOOK.secret).update(initTyped.body).digest('hex')
    expect(initTyped.headers['x-cosmika-signature']).toBe(expectedSig)

    // Body shape: {event, timestamp, data}
    const parsed = JSON.parse(initTyped.body) as {
      event: string
      timestamp: string
      data: unknown
    }
    expect(parsed.event).toBe('conversation.created')
    expect(parsed.data).toEqual({ foo: 'bar' })
    expect(typeof parsed.timestamp).toBe('string')
    expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('marks delivery SUCCESS on 2xx response and clears errorMessage', async () => {
    const row = makeDeliveryRow()
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201 }) as unknown as typeof fetch

    await svc.processDueDeliveries()

    expect(prisma.webhookDelivery.update).toHaveBeenCalledTimes(1)
    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      where: { id: string }
      data: {
        status: string
        responseStatus: number | null
        errorMessage: string | null
        attempts: number
        lastAttemptAt: Date
      }
    }
    expect(args.where.id).toBe(row.id)
    expect(args.data.status).toBe('SUCCESS')
    expect(args.data.responseStatus).toBe(201)
    expect(args.data.errorMessage).toBeNull()
    expect(args.data.attempts).toBe(1)
    expect(args.data.lastAttemptAt).toBeInstanceOf(Date)
  })

  it('schedules retry #2 in 60s after first failure (HTTP 500)', async () => {
    const t0 = Date.UTC(2026, 4, 25, 12, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(t0))
    const row = makeDeliveryRow({ attempts: 0 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch

    await svc.processDueDeliveries()

    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: {
        status: string
        responseStatus: number | null
        errorMessage: string | null
        attempts: number
        nextRetryAt: Date
      }
    }
    expect(args.data.status).toBe('PENDING')
    expect(args.data.responseStatus).toBe(500)
    expect(args.data.errorMessage).toBe('HTTP 500')
    expect(args.data.attempts).toBe(1)
    expect(args.data.nextRetryAt.getTime() - t0).toBe(60_000)
    vi.useRealTimers()
  })

  it('schedules retry #3 in 5 minutes (300_000 ms) after second failure', async () => {
    const t0 = Date.UTC(2026, 4, 25, 12, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(t0))
    const row = makeDeliveryRow({ attempts: 1 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch

    await svc.processDueDeliveries()

    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: { status: string; attempts: number; nextRetryAt: Date }
    }
    expect(args.data.status).toBe('PENDING')
    expect(args.data.attempts).toBe(2)
    expect(args.data.nextRetryAt.getTime() - t0).toBe(5 * 60_000)
    vi.useRealTimers()
  })

  it('marks FAILED after the 3rd attempt fails (MAX_ATTEMPTS = 3)', async () => {
    const row = makeDeliveryRow({ attempts: 2 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch

    await svc.processDueDeliveries()

    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: {
        status: string
        responseStatus: number | null
        errorMessage: string | null
        attempts: number
        lastAttemptAt: Date
      }
    }
    expect(args.data.status).toBe('FAILED')
    expect(args.data.responseStatus).toBe(503)
    expect(args.data.errorMessage).toBe('HTTP 503')
    expect(args.data.attempts).toBe(3)
    expect(args.data.lastAttemptAt).toBeInstanceOf(Date)
    // No nextRetryAt on FAILED — retries are over.
    expect(
      (args.data as Record<string, unknown>).nextRetryAt,
    ).toBeUndefined()
  })

  it('records errorMessage from Error thrown by fetch (network error)', async () => {
    const row = makeDeliveryRow({ attempts: 0 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 1.2.3.4:443')) as unknown as typeof fetch

    await svc.processDueDeliveries()

    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: { status: string; responseStatus: number | null; errorMessage: string | null }
    }
    expect(args.data.status).toBe('PENDING') // attempt 1 of 3 → retry
    expect(args.data.responseStatus).toBeNull()
    expect(args.data.errorMessage).toBe('ECONNREFUSED 1.2.3.4:443')
  })

  it('records errorMessage when fetch throws a non-Error value', async () => {
    const row = makeDeliveryRow({ attempts: 0 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    // Reject with a plain string — covers the `String(err)` branch.
    globalThis.fetch = vi.fn().mockRejectedValue('weird non-error') as unknown as typeof fetch

    await svc.processDueDeliveries()

    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: { errorMessage: string | null }
    }
    expect(args.data.errorMessage).toBe('weird non-error')
  })

  it('records SSRF block as a delivery failure WITHOUT calling fetch (S6 H2 guard)', async () => {
    const row = makeDeliveryRow({
      attempts: 0,
      webhook: { ...WEBHOOK, url: 'http://10.0.0.1/internal' },
    })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})

    mockedAssertSafeFetchUrl.mockRejectedValueOnce(
      new Error('blocked: target IP is internal'),
    )
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await svc.processDueDeliveries()

    expect(mockedAssertSafeFetchUrl).toHaveBeenCalledWith('http://10.0.0.1/internal')
    expect(fetchMock).not.toHaveBeenCalled()
    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: { status: string; errorMessage: string | null; responseStatus: number | null }
    }
    expect(args.data.status).toBe('PENDING') // attempt 1 → retry, not FAILED yet
    expect(args.data.errorMessage).toBe('blocked: target IP is internal')
    expect(args.data.responseStatus).toBeNull()
  })

  it('SSRF block on attempt #3 marks the delivery FAILED', async () => {
    const row = makeDeliveryRow({
      attempts: 2,
      webhook: { ...WEBHOOK, url: 'http://127.0.0.1/x' },
    })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})

    mockedAssertSafeFetchUrl.mockRejectedValueOnce(
      new Error('blocked: target IP is internal'),
    )
    globalThis.fetch = vi.fn() as unknown as typeof fetch

    await svc.processDueDeliveries()
    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      data: { status: string; attempts: number }
    }
    expect(args.data.status).toBe('FAILED')
    expect(args.data.attempts).toBe(3)
  })

  it('returns the number of deliveries processed in this tick', async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([
      makeDeliveryRow({ id: 'd1' }),
      makeDeliveryRow({ id: 'd2' }),
    ])
    prisma.webhookDelivery.update.mockResolvedValue({})
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch
    const out = await svc.processDueDeliveries()
    expect(out).toBe(2)
    expect(prisma.webhookDelivery.update).toHaveBeenCalledTimes(2)
  })

  it('attempt number propagates into the x-cosmika-attempt header', async () => {
    const row = makeDeliveryRow({ attempts: 1 })
    prisma.webhookDelivery.findMany.mockResolvedValue([row])
    prisma.webhookDelivery.update.mockResolvedValue({})
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await svc.processDueDeliveries()
    const init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> }
    // priorAttempts=1 → attemptNumber=2
    expect(init.headers['x-cosmika-attempt']).toBe('2')
  })
})

// ---------- retryDelivery ----------

describe('WebhooksService.retryDelivery', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN_MEMBER)
  })

  it('403s when caller is not an admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT_MEMBER)
    await expect(
      svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd1'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404s when webhook not found', async () => {
    prisma.webhook.findUnique.mockResolvedValue(null)
    await expect(
      svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when webhook belongs to another account (IDOR)', async () => {
    prisma.webhook.findUnique.mockResolvedValue({ ...WEBHOOK, accountId: 'acc2' })
    await expect(
      svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when delivery not found', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhookDelivery.findUnique.mockResolvedValue(null)
    await expect(
      svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd-missing'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404s when delivery belongs to a different webhook (cross-webhook IDOR)', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhookDelivery.findUnique.mockResolvedValue({
      id: 'd1',
      webhookId: 'other-webhook',
    })
    await expect(
      svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('resets status to PENDING with nextRetryAt=now and does NOT zero attempts', async () => {
    prisma.webhook.findUnique.mockResolvedValue(WEBHOOK)
    prisma.webhookDelivery.findUnique.mockResolvedValue({
      id: 'd1',
      webhookId: WEBHOOK.id,
      attempts: 2,
      status: 'FAILED',
    })
    prisma.webhookDelivery.update.mockResolvedValue({})
    await svc.retryDelivery('u1', 'acc1', WEBHOOK.id, 'd1')
    const args = prisma.webhookDelivery.update.mock.calls[0]![0] as {
      where: { id: string }
      data: { status: string; nextRetryAt: Date; attempts?: number }
    }
    expect(args.where.id).toBe('d1')
    expect(args.data.status).toBe('PENDING')
    expect(args.data.nextRetryAt).toBeInstanceOf(Date)
    // attempts should NOT appear in the update — operators want to see history
    expect(args.data.attempts).toBeUndefined()
  })
})

// ---------- toDTO + toDTOWithSecret ----------

describe('WebhooksService.toDTO / toDTOWithSecret', () => {
  let prisma: Prisma
  let svc: WebhooksService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
  })

  it('toDTO returns the public shape (no secret) with ISO createdAt', () => {
    const dto = svc.toDTO(WEBHOOK as never)
    expect(dto).toEqual({
      id: WEBHOOK.id,
      accountId: WEBHOOK.accountId,
      name: WEBHOOK.name,
      url: WEBHOOK.url,
      events: WEBHOOK.events,
      isActive: WEBHOOK.isActive,
      createdAt: '2026-05-25T12:00:00.000Z',
    })
    expect(Object.keys(dto)).not.toContain('secret')
  })

  it('toDTOWithSecret extends toDTO with the secret field', () => {
    const dto = svc.toDTOWithSecret(WEBHOOK as never)
    expect(dto.secret).toBe(WEBHOOK.secret)
    expect(dto.id).toBe(WEBHOOK.id)
    expect(dto.createdAt).toBe('2026-05-25T12:00:00.000Z')
  })
})
