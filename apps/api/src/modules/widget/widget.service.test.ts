import {
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WidgetService, toWidgetMessage } from './widget.service'
import { signVisitorJwt } from './widget-jwt'

// ---------- mock factories ----------

const JWT_SECRET = 'widget-test-secret-at-least-16-chars-long'

function makePrisma() {
  const tx = {
    contactInbox: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    contact: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ blockedAt: null }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  }
  const prisma = {
    inbox: {
      findFirst: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
      // Default: not the visitor's first message, so no routing.
      count: vi.fn().mockResolvedValue(2),
    },
    conversation: {
      update: vi.fn(),
    },
    contact: {
      update: vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: vi.fn(async (fn: (t: typeof tx) => any) => fn(tx)),
    // Expose tx so tests can wire its mocks
    __tx: tx,
  }
  return prisma
}

type Prisma = ReturnType<typeof makePrisma>

function makeConfig(
  // Sentinel so callers can pass `undefined` and have it respected as "unset"
  // (vs. the default-parameter falling back to JWT_SECRET).
  ...args: [] | [string | undefined]
): ConfigService {
  const secret = args.length === 0 ? JWT_SECRET : args[0]
  return {
    get: vi.fn((key: string) => (key === 'WIDGET_JWT_SECRET' ? secret : undefined)),
  } as unknown as ConfigService
}

function makeOrchestrator() {
  return {
    handleInbound: vi.fn().mockResolvedValue(undefined),
  }
}

type Orchestrator = ReturnType<typeof makeOrchestrator>

function makeRealtime() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  }
}

type Realtime = ReturnType<typeof makeRealtime>

function makeFlowRunner() {
  // Default: no flow handles the turn → AI orchestrator runs as before.
  return { handleInbound: vi.fn().mockResolvedValue(false) }
}
type FlowRunner = ReturnType<typeof makeFlowRunner>

function makeAssignment() {
  return { route: vi.fn().mockResolvedValue({ assigneeId: null, pickedId: null }) }
}
type Assignment = ReturnType<typeof makeAssignment>

function makeService(
  prisma: Prisma = makePrisma(),
  config: ConfigService = makeConfig(),
  orchestrator: Orchestrator = makeOrchestrator(),
  realtime: Realtime = makeRealtime(),
  flowRunner: FlowRunner = makeFlowRunner(),
  assignment: Assignment = makeAssignment(),
): {
  svc: WidgetService
  prisma: Prisma
  config: ConfigService
  orchestrator: Orchestrator
  realtime: Realtime
  flowRunner: FlowRunner
  assignment: Assignment
} {
  const svc = new WidgetService(
    prisma as never,
    config,
    orchestrator as never,
    realtime as never,
    flowRunner as never,
    assignment as never,
  )
  return { svc, prisma, config, orchestrator, realtime, flowRunner, assignment }
}

const WIDGET_HASH = 'abcdefghijklmnop1234' // ≥ 16 chars

const WIDGET_INBOX = {
  id: 'inb1',
  accountId: 'acc1',
  channelType: 'WEB_WIDGET',
  channelConfig: { widgetHash: WIDGET_HASH },
}

// ---------- resolveInbox ----------

describe('WidgetService.resolveInbox', () => {
  it('404s on empty hash', async () => {
    const { svc } = makeService()
    await expect(svc.resolveInbox('')).rejects.toThrow(NotFoundException)
  })

  it('404s on too-short hash (< 16 chars)', async () => {
    const { svc } = makeService()
    await expect(svc.resolveInbox('short')).rejects.toThrow(NotFoundException)
  })

  it('404s when no matching inbox row exists', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue(null)
    await expect(svc.resolveInbox(WIDGET_HASH)).rejects.toThrow(NotFoundException)
    expect(prisma.inbox.findFirst).toHaveBeenCalledWith({
      where: {
        channelType: 'WEB_WIDGET',
        channelConfig: { path: ['widgetHash'], equals: WIDGET_HASH },
      },
    })
  })

  it('returns the inbox when one matches', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    await expect(svc.resolveInbox(WIDGET_HASH)).resolves.toBe(WIDGET_INBOX)
  })
})

// ---------- jwtSecret guard (via createSession) ----------

describe('WidgetService.jwtSecret', () => {
  it('rejects the session when the existing contact is blocked', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.contact.findUnique.mockResolvedValue({ blockedAt: new Date() })
    await expect(
      svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-blocked-1' }),
    ).rejects.toThrow(/blocked/i)
  })

  it('throws when WIDGET_JWT_SECRET is unset', async () => {
    const { svc, prisma } = makeService(makePrisma(), makeConfig(undefined))
    prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    await expect(
      svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-fixed-1' }),
    ).rejects.toThrow(/WIDGET_JWT_SECRET/)
  })

  it('throws when WIDGET_JWT_SECRET is shorter than 16 chars', async () => {
    const { svc, prisma } = makeService(makePrisma(), makeConfig('short'))
    prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })
    await expect(
      svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-fixed-2' }),
    ).rejects.toThrow(/WIDGET_JWT_SECRET/)
  })
})

// ---------- assertOriginAllowed (M4 fail-closed) ----------

describe('WidgetService.assertOriginAllowed (via createSession)', () => {
  it('allows session when websiteUrl is unset (no CORS gate)', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX) // no websiteUrl
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-without-cors-gate',
        origin: 'https://random.example.com',
      }),
    ).resolves.toBeDefined()
  })

  it('allows session when origin header is absent (no CORS gate)', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: { ...WIDGET_INBOX.channelConfig, websiteUrl: 'https://customer.example' },
    })
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-no-origin-header',
        // origin omitted
      }),
    ).resolves.toBeDefined()
  })

  it('allows when origin matches the configured websiteUrl origin', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 'https://customer.example/some/path',
      },
    })
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-origin-match',
        origin: 'https://customer.example',
      }),
    ).resolves.toBeDefined()
  })

  it('rejects when origin differs from configured websiteUrl', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 'https://customer.example',
      },
    })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-mismatch',
        origin: 'https://attacker.example',
      }),
    ).rejects.toThrow(/Origin not allowed/)
  })

  it('M4: fails CLOSED when websiteUrl is malformed (does NOT silently skip)', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 'not-a-url-at-all',
      },
    })
    // Suppress the expected warn log so the test output stays clean
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined)

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-malformed-url',
        origin: 'https://attacker.example',
      }),
    ).rejects.toThrow(/Widget misconfigured/)

    // Ensure it logged the misconfiguration
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('handles channelConfig with non-string websiteUrl as "no website set" (gate skipped)', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 12345, // non-string → treated as null
      },
    })
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-nonstring-url',
        origin: 'https://anywhere.example',
      }),
    ).resolves.toBeDefined()
  })

  it('handles inbox.channelConfig === null safely (no CORS gate)', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: null,
    })
    prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await expect(
      svc.createSession({
        hash: WIDGET_HASH,
        visitorId: 'visitor-id-null-cfg',
        origin: 'https://anywhere.example',
      }),
    ).resolves.toBeDefined()
  })
})

// ---------- createSession ----------

describe('WidgetService.createSession', () => {
  let h: ReturnType<typeof makeService>

  beforeEach(() => {
    h = makeService()
    h.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
  })

  it('reuses an existing contact + open conversation', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({
      id: 'cv-existing',
      status: 'OPEN',
    })

    const res = await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-existing-yes',
    })
    expect(res.contactId).toBe('ct-existing')
    expect(res.conversationId).toBe('cv-existing')
    expect(res.visitorToken.split('.')).toHaveLength(3)
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(h.prisma.__tx.contact.create).not.toHaveBeenCalled()
    expect(h.prisma.__tx.conversation.create).not.toHaveBeenCalled()
  })

  it('updates contact name/email when supplied alongside existing contact', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.contact.update.mockResolvedValue({ id: 'ct-existing' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-existing-update',
      name: 'Alice',
      email: 'alice@example.com',
    })
    expect(h.prisma.__tx.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct-existing' },
      data: { name: 'Alice', email: 'alice@example.com' },
    })
  })

  it('updates only the name when only name is supplied', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.contact.update.mockResolvedValue({ id: 'ct-existing' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-name-only',
      name: 'Bob',
    })
    expect(h.prisma.__tx.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct-existing' },
      data: { name: 'Bob' },
    })
  })

  it('updates only the email when only email is supplied', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.contact.update.mockResolvedValue({ id: 'ct-existing' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-email-only',
      email: 'bob@example.com',
    })
    expect(h.prisma.__tx.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct-existing' },
      data: { email: 'bob@example.com' },
    })
  })

  it('does NOT update contact when neither name nor email supplied', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-noupdate',
    })
    expect(h.prisma.__tx.contact.update).not.toHaveBeenCalled()
  })

  it('creates a new Contact + ContactInbox when none exists for this visitorId', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({
      id: 'ct-new',
      accountId: 'acc1',
    })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({
      id: 'ci-new',
      contactId: 'ct-new',
      inboxId: 'inb1',
      sourceId: 'visitor-id-newcontact-x',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-new' })

    const res = await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-newcontact-x',
      name: 'Carol',
      email: 'carol@example.com',
    })
    expect(res.contactId).toBe('ct-new')
    expect(res.conversationId).toBe('cv-new')
    expect(h.prisma.__tx.contact.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        name: 'Carol',
        email: 'carol@example.com',
        identifier: 'visitor-id-newcontact-x',
      },
    })
    expect(h.prisma.__tx.contactInbox.create).toHaveBeenCalledWith({
      data: {
        contactId: 'ct-new',
        inboxId: 'inb1',
        sourceId: 'visitor-id-newcontact-x',
      },
    })
    expect(h.prisma.__tx.conversation.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        inboxId: 'inb1',
        contactId: 'ct-new',
        contactInboxId: 'ci-new',
        status: 'OPEN',
        // No agent bot on the test inbox → HUMAN control.
        controlMode: 'HUMAN',
        // A visitor starting a chat is a billable new conversation from the
        // first word, unlike a broadcast row nobody answered.
        origin: 'INBOUND',
        billableAt: expect.any(Date),
      },
    })
  })

  it('creates a new Contact with name=null + email=null when neither is supplied', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-anon' })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-anon' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-anon' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-anon-create',
    })
    expect(h.prisma.__tx.contact.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        name: null,
        email: null,
        identifier: 'visitor-id-anon-create',
      },
    })
  })

  it('generates a server-side visitorId when client did not provide one', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockImplementation(async ({ data }) => ({
      id: 'ct-gen',
      ...data,
    }))
    h.prisma.__tx.contactInbox.create.mockImplementation(async ({ data }) => ({
      id: 'ci-gen',
      ...data,
    }))
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-gen' })

    await h.svc.createSession({ hash: WIDGET_HASH }) // no visitorId

    // 12 random bytes → 24 hex chars
    const sourceId = h.prisma.__tx.contactInbox.create.mock.calls[0]![0].data
      .sourceId as string
    expect(sourceId).toMatch(/^[0-9a-f]{24}$/)
  })

  it('generates a server-side visitorId when client supplies one shorter than 8 chars', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-short' })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-short' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-short' })

    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'tiny' }) // < 8

    const sourceId = h.prisma.__tx.contactInbox.create.mock.calls[0]![0].data
      .sourceId as string
    expect(sourceId).not.toBe('tiny')
    expect(sourceId).toMatch(/^[0-9a-f]{24}$/)
  })

  it('truncates a client-supplied visitorId longer than 64 chars', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-trunc' })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-trunc' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-trunc' })

    const longId = 'x'.repeat(200)
    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: longId })

    const sourceId = h.prisma.__tx.contactInbox.create.mock.calls[0]![0].data
      .sourceId as string
    expect(sourceId).toBe('x'.repeat(64))
  })

  it('reuses an existing OPEN conversation without creating a new one', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({
      id: 'cv-open',
      status: 'OPEN',
    })

    const res = await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-reuse-conv',
    })
    expect(res.conversationId).toBe('cv-open')
    expect(h.prisma.__tx.conversation.create).not.toHaveBeenCalled()
    // verify the OPEN/PENDING filter is applied
    expect(h.prisma.__tx.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        contactId: 'ct1',
        inboxId: 'inb1',
        status: { in: ['OPEN', 'PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('creates a new conversation when contact has no OPEN/PENDING one', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct1',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-fresh' })

    const res = await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-fresh-conv',
    })
    expect(res.conversationId).toBe('cv-fresh')
    expect(h.prisma.__tx.conversation.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        inboxId: 'inb1',
        contactId: 'ct1',
        contactInboxId: 'ci1',
        status: 'OPEN',
        controlMode: 'HUMAN',
        origin: 'INBOUND',
        billableAt: expect.any(Date),
      },
    })
  })

  it('returned visitorToken can be verified with the configured secret', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-jwt',
    })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv-jwt' })

    const res = await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-id-jwt-verify',
    })
    const decoded = h.svc.decodeToken(WIDGET_HASH, res.visitorToken)
    expect(decoded.conversationId).toBe('cv-jwt')
    expect(decoded.contactId).toBe('ct-jwt')
    expect(decoded.inboxId).toBe('inb1')
  })
})

// ---------- decodeToken ----------

describe('WidgetService.decodeToken', () => {
  it('returns the verified payload for a valid token', () => {
    const { svc } = makeService()
    const token = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' },
      JWT_SECRET,
    )
    const payload = svc.decodeToken(WIDGET_HASH, token)
    expect(payload.conversationId).toBe('cv1')
    expect(payload.contactId).toBe('ct1')
    expect(payload.inboxId).toBe('inb1')
  })

  it('400s on a tampered/invalid token', () => {
    const { svc } = makeService()
    expect(() => svc.decodeToken(WIDGET_HASH, 'not.a.jwt')).toThrow(
      BadRequestException,
    )
  })

  it('400s on a token signed with a different secret', () => {
    const { svc } = makeService()
    const token = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' },
      'wrong-secret-which-is-long-enough',
    )
    expect(() => svc.decodeToken(WIDGET_HASH, token)).toThrow(BadRequestException)
  })
})

// ---------- postMessage ----------

describe('WidgetService.postMessage', () => {
  let h: ReturnType<typeof makeService>
  let validToken: string

  beforeEach(() => {
    h = makeService()
    h.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    validToken = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' },
      JWT_SECRET,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('400s when the visitor token belongs to a different inbox', async () => {
    const otherToken = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'OTHER-INBOX' },
      JWT_SECRET,
    )
    await expect(
      h.svc.postMessage({ hash: WIDGET_HASH, token: otherToken, content: 'hi' }),
    ).rejects.toThrow(/does not match this widget/)
  })

  it('400s on empty content', async () => {
    await expect(
      h.svc.postMessage({ hash: WIDGET_HASH, token: validToken, content: '' }),
    ).rejects.toThrow(/Empty message/)
  })

  it('400s on whitespace-only content (trim → empty)', async () => {
    await expect(
      h.svc.postMessage({
        hash: WIDGET_HASH,
        token: validToken,
        content: '   \t\n  ',
      }),
    ).rejects.toThrow(/Empty message/)
  })

  it('400s on null/undefined content (defensive ?? "" guard)', async () => {
    await expect(
      h.svc.postMessage({
        hash: WIDGET_HASH,
        token: validToken,
        content: undefined as unknown as string,
      }),
    ).rejects.toThrow(/Empty message/)
  })

  it('400s when content is longer than 4000 chars', async () => {
    await expect(
      h.svc.postMessage({
        hash: WIDGET_HASH,
        token: validToken,
        content: 'a'.repeat(4001),
      }),
    ).rejects.toThrow(/Message too long/)
  })

  it('creates a message, updates conversation+contact timestamps, publishes realtime, and fires orchestrator', async () => {
    const createdAt = new Date('2026-05-25T10:00:00Z')
    h.prisma.message.create.mockResolvedValue({
      id: 'msg-1',
      createdAt,
      senderType: 'CONTACT',
      content: 'hi from visitor',
      isPrivate: false,
    })
    h.prisma.conversation.update.mockResolvedValue({})
    h.prisma.contact.update.mockResolvedValue({})

    const res = await h.svc.postMessage({
      hash: WIDGET_HASH,
      token: validToken,
      content: '  hi from visitor  ', // leading/trailing space → trimmed
    })

    expect(res).toEqual({ id: 'msg-1', createdAt: createdAt.toISOString() })

    expect(h.prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'cv1',
        inboxId: 'inb1',
        accountId: 'acc1',
        senderType: 'CONTACT',
        senderContactId: 'ct1',
        content: 'hi from visitor', // trimmed
        contentType: 'TEXT',
        status: 'DELIVERED',
      },
    })
    expect(h.prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { contactLastSeenAt: expect.any(Date) },
    })
    expect(h.prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct1' },
      data: { lastActivityAt: expect.any(Date) },
    })
    expect(h.realtime.publish).toHaveBeenCalledWith({
      type: 'MessageCreated',
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      messageId: 'msg-1',
      senderType: 'CONTACT',
      content: 'hi from visitor',
      isPrivate: false,
      createdAt: createdAt.toISOString(),
    })
    expect(h.orchestrator.handleInbound).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      inboundMessageContent: 'hi from visitor',
    })
    // Not the visitor's first message: nothing to distribute.
    expect(h.assignment.route).not.toHaveBeenCalled()
  })

  it('a tapped menu option carries its id to the flow and onto the row', async () => {
    h.prisma.message.create.mockResolvedValue({
      id: 'msg-1', createdAt: new Date(), senderType: 'CONTACT', content: 'Financeiro', isPrivate: false,
    })
    h.prisma.conversation.update.mockResolvedValue({})
    h.prisma.contact.update.mockResolvedValue({})
    await h.svc.postMessage({
      hash: WIDGET_HASH,
      token: validToken,
      content: 'Financeiro',
      interactiveReplyId: 'opt-fin',
    })
    expect(h.prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      content: 'Financeiro',
      contentAttributes: { interactiveReplyId: 'opt-fin' },
    })
    expect(h.flowRunner.handleInbound).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      content: 'Financeiro',
      interactiveReplyId: 'opt-fin',
    })
  })

  it("distributes the conversation on the visitor's first message", async () => {
    h.prisma.message.create.mockResolvedValue({
      id: 'msg-1', createdAt: new Date(), senderType: 'CONTACT', content: 'hi', isPrivate: false,
    })
    h.prisma.message.count.mockResolvedValue(1)
    h.prisma.conversation.update.mockResolvedValue({})
    h.prisma.contact.update.mockResolvedValue({})
    await h.svc.postMessage({ hash: WIDGET_HASH, token: validToken, content: 'hi' })
    expect(h.prisma.message.count).toHaveBeenCalledWith({
      where: { conversationId: 'cv1', senderType: 'CONTACT' },
    })
    expect(h.assignment.route).toHaveBeenCalledWith('cv1', 'conversation_created')
  })

  it('when a flow handles the turn, the AI orchestrator is skipped', async () => {
    const flowRunner = makeFlowRunner()
    flowRunner.handleInbound.mockResolvedValue(true)
    const h2 = makeService(makePrisma(), makeConfig(), makeOrchestrator(), makeRealtime(), flowRunner)
    h2.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    h2.prisma.message.create.mockResolvedValue({
      id: 'msg-f', createdAt: new Date(), senderType: 'CONTACT', content: 'hi', isPrivate: false,
    })
    h2.prisma.conversation.update.mockResolvedValue({})
    h2.prisma.contact.update.mockResolvedValue({})
    const token = signVisitorJwt({ conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' }, JWT_SECRET, 3600)
    await h2.svc.postMessage({ hash: WIDGET_HASH, token, content: 'hi' })
    expect(h2.flowRunner.handleInbound).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      content: 'hi',
      interactiveReplyId: null,
    })
    expect(h2.orchestrator.handleInbound).not.toHaveBeenCalled()
  })

  it('swallows a flow-runner error and still lets the AI agent run', async () => {
    const flowRunner = makeFlowRunner()
    flowRunner.handleInbound.mockRejectedValue(new Error('flow boom'))
    const h2 = makeService(makePrisma(), makeConfig(), makeOrchestrator(), makeRealtime(), flowRunner)
    h2.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    h2.prisma.message.create.mockResolvedValue({
      id: 'msg-fe', createdAt: new Date(), senderType: 'CONTACT', content: 'hi', isPrivate: false,
    })
    h2.prisma.conversation.update.mockResolvedValue({})
    h2.prisma.contact.update.mockResolvedValue({})
    const token = signVisitorJwt({ conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' }, JWT_SECRET, 3600)
    await h2.svc.postMessage({ hash: WIDGET_HASH, token, content: 'hi' })
    await new Promise((r) => setImmediate(r))
    expect(h2.orchestrator.handleInbound).toHaveBeenCalled()
  })

  it('swallows orchestrator errors so ingestion still succeeds', async () => {
    h.prisma.message.create.mockResolvedValue({
      id: 'msg-2',
      createdAt: new Date(),
      senderType: 'CONTACT',
      content: 'x',
      isPrivate: false,
    })
    h.prisma.conversation.update.mockResolvedValue({})
    h.prisma.contact.update.mockResolvedValue({})
    h.orchestrator.handleInbound.mockRejectedValue(new Error('AI exploded'))

    // The .catch(() => undefined) means postMessage itself resolves cleanly.
    await expect(
      h.svc.postMessage({ hash: WIDGET_HASH, token: validToken, content: 'x' }),
    ).resolves.toMatchObject({ id: 'msg-2' })

    // Let the void-promise settle to flush the .catch
    await new Promise((r) => setImmediate(r))
    expect(h.orchestrator.handleInbound).toHaveBeenCalled()
  })

  it('enforces origin allowlist on postMessage too', async () => {
    h.prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 'https://customer.example',
      },
    })
    await expect(
      h.svc.postMessage({
        hash: WIDGET_HASH,
        token: validToken,
        content: 'hi',
        origin: 'https://evil.example',
      }),
    ).rejects.toThrow(/Origin not allowed/)
  })
})

// ---------- listMessages ----------

describe('WidgetService.listMessages', () => {
  let h: ReturnType<typeof makeService>
  let validToken: string

  beforeEach(() => {
    h = makeService()
    h.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
    validToken = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'inb1' },
      JWT_SECRET,
    )
  })

  it('returns the messages projected to the DTO shape', async () => {
    const t = new Date('2026-05-25T11:00:00Z')
    h.prisma.message.findMany.mockResolvedValue([
      {
        id: 'm1',
        senderType: 'CONTACT',
        content: 'hello',
        contentType: 'TEXT',
        createdAt: t,
        isPrivate: false,
      },
      {
        id: 'm2',
        senderType: 'AGENT',
        content: null,
        contentType: 'TEXT',
        createdAt: t,
        isPrivate: false,
      },
    ])

    const out = await h.svc.listMessages({ hash: WIDGET_HASH, token: validToken })
    expect(out).toEqual([
      { id: 'm1', senderType: 'CONTACT', content: 'hello', contentType: 'TEXT', createdAt: t.toISOString() },
      { id: 'm2', senderType: 'AGENT', content: null, contentType: 'TEXT', createdAt: t.toISOString() },
    ])
    expect(h.prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'cv1', isPrivate: false },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    })
  })

  it('400s when token belongs to a different inbox', async () => {
    const otherToken = signVisitorJwt(
      { conversationId: 'cv1', contactId: 'ct1', inboxId: 'OTHER-INBOX' },
      JWT_SECRET,
    )
    await expect(
      h.svc.listMessages({ hash: WIDGET_HASH, token: otherToken }),
    ).rejects.toThrow(/does not match this widget/)
  })

  it('enforces origin allowlist on listMessages too', async () => {
    h.prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteUrl: 'https://customer.example',
      },
    })
    await expect(
      h.svc.listMessages({
        hash: WIDGET_HASH,
        token: validToken,
        origin: 'https://attacker.example',
      }),
    ).rejects.toThrow(/Origin not allowed/)
  })
})

// ---------- embedScript ----------

describe('WidgetService.embedScript', () => {
  it('emits a script that contains the supplied hash and apiBase as JSON literals', () => {
    const { svc } = makeService()
    const out = svc.embedScript('hash-xyz', 'https://api.example.com')
    expect(out).toContain('const HASH = "hash-xyz"')
    expect(out).toContain('const FALLBACK_API = "https://api.example.com"')
    expect(out).toContain(
      'window.Cosmika = { send, fetchMessages, ensureSession, config }',
    )
    expect(out).toContain("/config")
  })

  it('properly JSON-escapes a hash containing quotes/backslashes', () => {
    const { svc } = makeService()
    const out = svc.embedScript('"weird"\\hash', 'https://api')
    // JSON.stringify handles the escaping; we just make sure it didn't throw
    // and the result still references the embed entry point.
    expect(out).toContain('window.Cosmika')
    expect(out).toContain(JSON.stringify('"weird"\\hash'))
  })
})

// ---------- preChat capture ----------

describe('WidgetService.createSession — preChat', () => {
  let h: ReturnType<typeof makeService>
  beforeEach(() => {
    h = makeService()
    h.prisma.inbox.findFirst.mockResolvedValue(WIDGET_INBOX)
  })

  it('new contact: name/email map to columns, other keys → customAttributes', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-pre' })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-pre' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-pre' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-prechat-new',
      preChat: { name: 'Dora', email: 'dora@e.com', order_id: 'A-99' },
    })
    expect(h.prisma.__tx.contact.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        name: 'Dora',
        email: 'dora@e.com',
        identifier: 'visitor-prechat-new',
        customAttributes: { order_id: 'A-99' },
      },
    })
  })

  it('explicit name/email params win over preChat values', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-pre2' })
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-pre2' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-pre2' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-prechat-win',
      name: 'Explicit',
      preChat: { name: 'FromPrechat' },
    })
    expect(h.prisma.__tx.contact.create.mock.calls[0]![0].data.name).toBe(
      'Explicit',
    )
  })

  it('existing contact with no prior customAttributes: starts from {}', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    // default findUnique mock returns { blockedAt: null } — no customAttributes
    h.prisma.__tx.contact.update.mockResolvedValue({ id: 'ct-existing' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-prechat-noattrs',
      preChat: { order_id: 'C-1' },
    })
    expect(h.prisma.__tx.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct-existing' },
      data: { customAttributes: { order_id: 'C-1' } },
    })
  })

  it('existing contact: merges extra keys into existing customAttributes', async () => {
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({
      id: 'ci1',
      contactId: 'ct-existing',
    })
    h.prisma.__tx.contact.findUnique.mockResolvedValue({
      blockedAt: null,
      customAttributes: { tier: 'gold' },
    })
    h.prisma.__tx.contact.update.mockResolvedValue({ id: 'ct-existing' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue({ id: 'cv1' })

    await h.svc.createSession({
      hash: WIDGET_HASH,
      visitorId: 'visitor-prechat-existing',
      preChat: { order_id: 'B-7' },
    })
    expect(h.prisma.__tx.contact.update).toHaveBeenCalledWith({
      where: { id: 'ct-existing' },
      data: { customAttributes: { tier: 'gold', order_id: 'B-7' } },
    })
  })
})

// ---------- publicConfig ----------

describe('WidgetService.publicConfig', () => {
  it('returns appearance + preChatFields from channelConfig', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      name: 'Fallback Inbox',
      channelConfig: {
        ...WIDGET_INBOX.channelConfig,
        websiteName: 'Acme Support',
        primaryColor: '#ff8800',
        welcomeMessage: 'Hi!',
        launcherText: 'Chat with us',
        preChatFields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
        ],
      },
    })
    const cfg = await svc.publicConfig(WIDGET_HASH)
    expect(cfg).toEqual({
      title: 'Acme Support',
      primaryColor: '#ff8800',
      welcomeMessage: 'Hi!',
      launcherText: 'Chat with us',
      preChatFields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
      ],
    })
  })

  it('falls back to inbox.name + nulls + empty fields when config is sparse', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      name: 'Fallback Inbox',
      channelConfig: { widgetHash: WIDGET_HASH },
    })
    const cfg = await svc.publicConfig(WIDGET_HASH)
    expect(cfg).toEqual({
      title: 'Fallback Inbox',
      primaryColor: null,
      welcomeMessage: null,
      launcherText: null,
      preChatFields: [],
    })
  })

  it('treats a null channelConfig safely', async () => {
    const { svc, prisma } = makeService()
    prisma.inbox.findFirst.mockResolvedValue({
      ...WIDGET_INBOX,
      name: 'Nullcfg Inbox',
      channelConfig: null,
    })
    const cfg = await svc.publicConfig(WIDGET_HASH)
    expect(cfg.title).toBe('Nullcfg Inbox')
    expect(cfg.preChatFields).toEqual([])
  })
})


// ---------- toWidgetMessage ----------

describe('toWidgetMessage', () => {
  const base = {
    id: 'm1',
    senderType: 'AGENT_BOT',
    content: 'Escolha',
    createdAt: new Date('2026-10-16T12:00:00Z'),
  }

  it('exposes a flow menu so the chat box can draw buttons', () => {
    const interactive = { kind: 'buttons', body: 'Escolha', buttons: [{ id: 'b1', label: 'Financeiro' }] }
    const out = toWidgetMessage({ ...base, contentType: 'QUICK_REPLIES', contentAttributes: interactive } as never)
    expect(out.interactive).toEqual(interactive)
  })

  it('drops a malformed menu instead of sending internals', () => {
    const out = toWidgetMessage({ ...base, contentType: 'QUICK_REPLIES', contentAttributes: { wamids: ['x'] } } as never)
    expect(out).not.toHaveProperty('interactive')
  })

  it('exposes a flow media link, but only an http(s) one', () => {
    const ok = toWidgetMessage({ ...base, contentType: 'AUDIO', contentAttributes: { url: 'https://x/a.mp3' } } as never)
    expect(ok.media).toEqual({ type: 'AUDIO', url: 'https://x/a.mp3' })
    const bad = toWidgetMessage({ ...base, contentType: 'IMAGE', contentAttributes: { url: 'javascript:alert(1)' } } as never)
    expect(bad).not.toHaveProperty('media')
    const none = toWidgetMessage({ ...base, contentType: 'FILE', contentAttributes: null } as never)
    expect(none).not.toHaveProperty('media')
  })

  it('never leaks other contentAttributes', () => {
    const out = toWidgetMessage({ ...base, contentType: 'TEXT', contentAttributes: { aiGenerated: true, wamids: ['w'] } } as never)
    expect(Object.keys(out).sort()).toEqual(['content', 'contentType', 'createdAt', 'id', 'senderType'])
  })
})


// ---------- preChat phone → one contact across Webchat and WhatsApp ----------

describe('WidgetService.createSession — phone joins the WhatsApp contact', () => {
  let h: ReturnType<typeof makeService>
  const PHONE_INBOX = {
    ...WIDGET_INBOX,
    channelConfig: {
      widgetHash: WIDGET_HASH,
      preChatFields: [{ key: 'cel', label: 'Celular', type: 'phone', required: true }],
    },
  }
  beforeEach(() => {
    h = makeService()
    h.prisma.inbox.findFirst.mockResolvedValue(PHONE_INBOX)
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue(null)
    h.prisma.__tx.contactInbox.create.mockResolvedValue({ id: 'ci-new' })
    h.prisma.__tx.conversation.findFirst.mockResolvedValue(null)
    h.prisma.__tx.conversation.create.mockResolvedValue({ id: 'cv-new' })
  })

  it('stores the typed phone as E.164 on a new contact', async () => {
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-new' })
    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-1', preChat: { name: 'Ana', cel: '(11) 99999-0000' } })
    expect(h.prisma.__tx.contact.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: 'acc1',
        phoneNumber: { in: expect.arrayContaining(['+5511999990000', '551199990000']) },
      },
      orderBy: { createdAt: 'asc' },
    })
    expect(h.prisma.__tx.contact.create.mock.calls[0]![0].data).toMatchObject({ phoneNumber: '+5511999990000', name: 'Ana' })
  })

  it('opens the chat on the contact WhatsApp already knows, reusing its widget row', async () => {
    h.prisma.__tx.contact.findFirst.mockResolvedValue({ id: 'ct-wa', blockedAt: null })
    h.prisma.__tx.contactInbox.findUnique
      .mockResolvedValueOnce(null) // by (inbox, visitorId)
      .mockResolvedValueOnce({ id: 'ci-wa-widget' }) // by (contact, inbox)
    const out = await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-2', preChat: { cel: '11999990000' } })
    expect(out.contactId).toBe('ct-wa')
    expect(h.prisma.__tx.contact.create).not.toHaveBeenCalled()
    expect(h.prisma.__tx.contactInbox.create).not.toHaveBeenCalled()
    expect(h.prisma.__tx.conversation.create.mock.calls[0]![0].data.contactInboxId).toBe('ci-wa-widget')
  })

  it('links a known contact without a widget row by creating one', async () => {
    h.prisma.__tx.contact.findFirst.mockResolvedValue({ id: 'ct-wa', blockedAt: null })
    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-3', preChat: { cel: '11999990000' } })
    expect(h.prisma.__tx.contactInbox.create).toHaveBeenCalledWith({
      data: { contactId: 'ct-wa', inboxId: 'inb1', sourceId: 'visitor-phone-3' },
    })
  })

  it('refuses a known contact that is blocked', async () => {
    h.prisma.__tx.contact.findFirst.mockResolvedValue({ id: 'ct-wa', blockedAt: new Date() })
    await expect(
      h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-4', preChat: { cel: '11999990000' } }),
    ).rejects.toThrow(/blocked/)
  })

  it('takes a phone from a key named like one, and updates a returning visitor', async () => {
    h.prisma.inbox.findFirst.mockResolvedValue({ ...WIDGET_INBOX, channelConfig: { widgetHash: WIDGET_HASH, preChatFields: 'bad' } })
    h.prisma.__tx.contactInbox.findUnique.mockResolvedValue({ id: 'ci1', contactId: 'ct1' })
    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-5', preChat: { telefone: '+55 11 3333-4444' } })
    expect(h.prisma.__tx.contact.update.mock.calls[0]![0].data).toMatchObject({ phoneNumber: '+551133334444' })
  })

  it('ignores something that is not a phone', async () => {
    h.prisma.__tx.contact.create.mockResolvedValue({ id: 'ct-x' })
    await h.svc.createSession({ hash: WIDGET_HASH, visitorId: 'visitor-phone-6', preChat: { cel: 'n/a' } })
    expect(h.prisma.__tx.contact.findFirst).not.toHaveBeenCalled()
    expect(h.prisma.__tx.contact.create.mock.calls[0]![0].data).not.toHaveProperty('phoneNumber')
  })
})
