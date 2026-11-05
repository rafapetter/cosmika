import { channelsOver } from '../channels/channels.testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ConversationsService,
  initialControlMode,
  renderTemplateBody,
  pickPreviewMessage,
} from './conversations.service'

// ─── helpers ────────────────────────────────────────────────────────

function makePrisma() {
  return {
    accountMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      groupBy: vi.fn(),
    },
    contact: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    inbox: {
      findUnique: vi.fn(),
    },
    whatsappTemplate: {
      findUnique: vi.fn(),
    },
    inboxMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    contactInbox: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    team: {
      findUnique: vi.fn(),
    },
    // Activity notes resolve the acting user's + target's display name.
    user: {
      findUnique: vi.fn().mockResolvedValue({ fullName: 'Ana Agent' }),
    },
    label: {
      findUnique: vi.fn(),
    },
    conversationLabel: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    message: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    conversationParticipant: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
    },
    attachment: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeOrchestrator() {
  return {
    handleInbound: vi.fn().mockResolvedValue(undefined),
    handOffSilentTurn: vi.fn().mockResolvedValue(undefined),
  }
}

function makeRealtime() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  }
}

function makeAutomation() {
  return {
    evaluate: vi.fn().mockResolvedValue([]),
  }
}

function makeWhatsapp() {
  return {
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'wamid-text' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
    sendMedia: vi.fn().mockResolvedValue({ wamid: 'wamid-media' }),
    sendTemplate: vi.fn().mockResolvedValue({ wamid: 'wamid-tmpl' }),
    resolveRecipient: vi.fn().mockResolvedValue(null),
    recipientForConversation: vi.fn().mockResolvedValue('+1234'),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    setReaction: vi.fn(async (m: Record<string, unknown>) => m),
    messagingWindowFor: vi.fn().mockResolvedValue({
      open: true, lastInboundAt: null, expiresAt: null,
    }),
  }
}

function makeAttachments() {
  return {
    attachToMessage: vi.fn().mockResolvedValue([]),
    // Default: storage handed us a link Meta can fetch.
    resolveOutboundMedia: vi
      .fn()
      .mockResolvedValue({ kind: 'link', url: 'https://cdn.example.com/a.png' }),
  }
}

function makeNotifications() {
  return {
    createMentions: vi.fn().mockResolvedValue(undefined),
    createAssignment: vi.fn().mockResolvedValue(undefined),
  }
}

function makeWebhooks() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
  }
}

function makeCsat() {
  return {
    maybeCreateForResolvedConversation: vi.fn().mockResolvedValue(undefined),
  }
}

function makeSla() {
  return {
    computeStatus: vi.fn().mockReturnValue({
      state: 'NOT_APPLICABLE',
      dimension: null,
      targetAt: null,
      minutesRemaining: null,
    }),
  }
}

function makeUsage() {
  return {
    assertWithinCap: vi.fn().mockResolvedValue(undefined),
  }
}

function makeAi() {
  return {
    translate: vi.fn().mockResolvedValue('translated'),
  }
}

function makeFlowRunner() {
  // Default: no flow → AI agent path runs (existing tests unchanged).
  return {
    handleInbound: vi.fn().mockResolvedValue(false),
  }
}

const makeAutoReply = () => ({
  maybeAutoReply: vi.fn().mockResolvedValue(undefined),
})

// Routing default: nobody picked, assignee unchanged.
const makeAssignment = () => ({
  route: vi.fn().mockResolvedValue({ assigneeId: null, pickedId: null }),
})

const makeActivity = () => ({
  log: vi.fn().mockResolvedValue(undefined),
  actorName: vi.fn().mockResolvedValue('Ana Agent'),
})

type Deps = {
  prisma: Prisma
  orchestrator: ReturnType<typeof makeOrchestrator>
  realtime: ReturnType<typeof makeRealtime>
  automation: ReturnType<typeof makeAutomation>
  whatsapp: ReturnType<typeof makeWhatsapp>
  attachments: ReturnType<typeof makeAttachments>
  notifications: ReturnType<typeof makeNotifications>
  webhooks: ReturnType<typeof makeWebhooks>
  csat: ReturnType<typeof makeCsat>
  sla: ReturnType<typeof makeSla>
  usage: ReturnType<typeof makeUsage>
  ai: ReturnType<typeof makeAi>
  flowRunner: ReturnType<typeof makeFlowRunner>
  activity: ReturnType<typeof makeActivity>
  autoReply: ReturnType<typeof makeAutoReply>
  assignment: ReturnType<typeof makeAssignment>
}

function makeService(overrides: Partial<Deps> = {}): {
  svc: ConversationsService
  deps: Deps
} {
  const deps: Deps = {
    prisma: overrides.prisma ?? makePrisma(),
    orchestrator: overrides.orchestrator ?? makeOrchestrator(),
    realtime: overrides.realtime ?? makeRealtime(),
    automation: overrides.automation ?? makeAutomation(),
    whatsapp: overrides.whatsapp ?? makeWhatsapp(),
    attachments: overrides.attachments ?? makeAttachments(),
    notifications: overrides.notifications ?? makeNotifications(),
    webhooks: overrides.webhooks ?? makeWebhooks(),
    csat: overrides.csat ?? makeCsat(),
    sla: overrides.sla ?? makeSla(),
    usage: overrides.usage ?? makeUsage(),
    ai: overrides.ai ?? makeAi(),
    flowRunner: overrides.flowRunner ?? makeFlowRunner(),
    activity: overrides.activity ?? makeActivity(),
    autoReply: overrides.autoReply ?? makeAutoReply(),
    assignment: overrides.assignment ?? makeAssignment(),
  }
  const svc = new ConversationsService(
    deps.prisma as never,
    deps.orchestrator as never,
    deps.realtime as never,
    deps.automation as never,
    deps.whatsapp as never,
    deps.attachments as never,
    deps.notifications as never,
    deps.webhooks as never,
    deps.csat as never,
    deps.sla as never,
    deps.usage as never,
    deps.activity as never,
    deps.autoReply as never,
    deps.ai as never,
    deps.flowRunner as never,
    deps.assignment as never,
    channelsOver(deps.whatsapp, deps.attachments) as never,
  )
  return { svc, deps }
}

function mockTransactionPassthrough(prisma: Prisma) {
  prisma.$transaction.mockImplementation(async (fnOrArr: unknown) => {
    if (typeof fnOrArr === 'function') {
      return (fnOrArr as (tx: Prisma) => unknown)(prisma)
    }
    // Array form: run all promises in sequence and return their results.
    return Promise.all(fnOrArr as Promise<unknown>[])
  })
}

function priv(role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' | 'BOT' = 'AGENT') {
  return {
    id: 'm1',
    accountId: 'acc1',
    userId: 'u1',
    role,
    isActive: true,
  }
}

const SAMPLE_CONVERSATION = {
  id: 'conv1',
  accountId: 'acc1',
  inboxId: 'inb1',
  contactId: 'cnt1',
  contactInboxId: 'ci1',
  assigneeId: null,
  teamId: null,
  status: 'OPEN',
  priority: 'NORMAL',
  agentLastSeenAt: null,
  contactLastSeenAt: null,
  firstReplyAt: null,
  resolvedAt: null,
  reopenedAt: null,
  aiSummary: null,
  aiSentiment: null,
  aiTags: [],
  customAttributes: {},
  forwardedFromConversationId: null,
  displayId: 42,
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-02T00:00:00Z'),
}

// ─── getMembership (via the helpers it gates) ───────────────────────

describe('getMembership (via list)', () => {
  it('rejects when no membership exists', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.list('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('rejects when membership is inactive', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue({
      ...priv('AGENT'),
      isActive: false,
    })
    await expect(svc.list('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

// ─── list ──────────────────────────────────────────────────────────

describe('ConversationsService.list', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
  })

  it('returns rows for a privileged user with default page size and no cursor', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([{ ...SAMPLE_CONVERSATION }])
    const out = await svc.list('u1', 'acc1', {} as never)
    expect(out.data).toHaveLength(1)
    expect(out.nextCursor).toBeNull()
    const call = deps.prisma.conversation.findMany.mock.calls[0]![0]
    expect(call.where).toEqual({ accountId: 'acc1' })
    expect(call.take).toBe(26) // limit + 1
    expect(call.skip).toBeUndefined()
  })

  it('uses accessFilter for unprivileged users', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', {} as never)
    const call = deps.prisma.conversation.findMany.mock.calls[0]![0]
    expect(call.where.OR).toBeDefined()
    expect(call.where.OR).toHaveLength(3)
  })

  it('narrows an agent to their teams when the account scopes by team', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.account.findUnique.mockResolvedValue({ teamScopedVisibility: true })
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', {} as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.OR[2]).toEqual({
      AND: [
        { inbox: { members: { some: { userId: 'u1' } } } },
        { OR: [{ teamId: null }, { team: { members: { some: { userId: 'u1' } } } }] },
      ],
    })
  })

  it('caps limit at MAX_PAGE_SIZE', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', { limit: 9999 } as never)
    const call = deps.prisma.conversation.findMany.mock.calls[0]![0]
    expect(call.take).toBe(101) // MAX_PAGE_SIZE + 1
  })

  it('applies status/inboxId/assigneeId/contactId/excludeId/q filters', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', {
      status: 'OPEN',
      controlMode: 'BOT',
      inboxId: 'inb1',
      assigneeId: 'u2',
      contactId: 'cnt1',
      excludeId: 'convX',
      q: 'hello',
    } as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.status).toBe('OPEN')
    expect(where.controlMode).toBe('BOT')
    expect(where.inboxId).toBe('inb1')
    expect(where.assigneeId).toBe('u2')
    expect(where.contactId).toBe('cnt1')
    expect(where.NOT).toEqual({ id: 'convX' })
    // Search is an OR wrapped in AND so it doesn't clobber accessFilter's OR.
    const searchOr = where.AND[0].OR
    expect(searchOr).toEqual(
      expect.arrayContaining([
        { messages: { some: { content: { contains: 'hello', mode: 'insensitive' } } } },
        { contact: { name: { contains: 'hello', mode: 'insensitive' } } },
        { contact: { email: { contains: 'hello', mode: 'insensitive' } } },
        { contact: { phoneNumber: { contains: 'hello', mode: 'insensitive' } } },
      ]),
    )
    // Non-numeric query does NOT add a displayId clause.
    expect(searchOr.some((c: { displayId?: number }) => 'displayId' in c)).toBe(false)
  })

  it('numeric search also matches the conversation displayId', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', { q: '42' } as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.AND[0].OR).toContainEqual({ displayId: 42 })
  })

  it('applies team/label/displayId/country/date-range filters', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    const createdAfter = new Date('2026-01-01T00:00:00Z')
    const createdBefore = new Date('2026-02-01T00:00:00Z')
    const lastActivityAfter = new Date('2026-03-01T00:00:00Z')
    const lastActivityBefore = new Date('2026-04-01T00:00:00Z')
    await svc.list('u1', 'acc1', {
      teamId: 't1',
      labelId: 'l1',
      displayId: 99,
      country: 'BR',
      createdAfter,
      createdBefore,
      lastActivityAfter,
      lastActivityBefore,
    } as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.teamId).toBe('t1')
    expect(where.conversationLabels).toEqual({ some: { labelId: 'l1' } })
    expect(where.displayId).toBe(99)
    expect(where.contact).toEqual({
      additionalAttributes: { path: ['country_code'], equals: 'BR' },
    })
    expect(where.createdAt).toEqual({ gte: createdAfter, lte: createdBefore })
    expect(where.updatedAt).toEqual({ gte: lastActivityAfter, lte: lastActivityBefore })
  })

  it('applies only the provided half of a date range', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    const createdAfter = new Date('2026-01-01T00:00:00Z')
    await svc.list('u1', 'acc1', { createdAfter } as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.createdAt).toEqual({ gte: createdAfter })
  })

  it('omits controlMode from where when not provided', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', {} as never)
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.controlMode).toBeUndefined()
  })

  it.each([
    ['ACTIVITY_DESC', [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]],
    ['ACTIVITY_ASC', [{ lastMessageAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]],
    ['CREATED_DESC', [{ createdAt: 'desc' }, { id: 'desc' }]],
    ['CREATED_ASC', [{ createdAt: 'asc' }, { id: 'asc' }]],
    ['PRIORITY_DESC', [{ priority: 'desc' }, { lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]],
  ] as const)('sorts by %s', async (sort, expected) => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', { sort } as never)
    expect(deps.prisma.conversation.findMany.mock.calls[0]![0].orderBy).toEqual(expected)
  })

  it('defaults to ACTIVITY_DESC sort when sort is omitted', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', {} as never)
    expect(deps.prisma.conversation.findMany.mock.calls[0]![0].orderBy).toEqual([
      { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      { id: 'desc' },
    ])
  })

  it('emits a nextCursor when there are more rows', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    // Use limit=1 → take=2 → return 2 rows so pagination triggers.
    deps.prisma.conversation.findMany.mockResolvedValue([
      { ...SAMPLE_CONVERSATION, id: 'a' },
      { ...SAMPLE_CONVERSATION, id: 'b' },
    ])
    const out = await svc.list('u1', 'acc1', { limit: 1 } as never)
    expect(out.data).toHaveLength(1)
    expect(out.nextCursor).toBe('b')
  })

  it('handles undefined pop result (defensive — empty pop after length check)', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    // Simulate findMany returning an array whose pop returns undefined (won't
    // happen normally — guard against the `next ? next.id : null` branch).
    const arr: typeof SAMPLE_CONVERSATION[] = []
    Object.defineProperty(arr, 'length', { value: 99 }) // fake length
    arr.pop = () => undefined as never
    deps.prisma.conversation.findMany.mockResolvedValue(arr as never)
    const out = await svc.list('u1', 'acc1', { limit: 1 } as never)
    expect(out.nextCursor).toBeNull()
  })

  it('passes cursor and skip=1 when provided', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findMany.mockResolvedValue([])
    await svc.list('u1', 'acc1', { cursor: 'convX' } as never)
    const call = deps.prisma.conversation.findMany.mock.calls[0]![0]
    expect(call.cursor).toEqual({ id: 'convX' })
    expect(call.skip).toBe(1)
  })
})

// ─── getDetail / assertConversationAccess ───────────────────────────

describe('ConversationsService.getDetail', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
  })

  it('404s when conversation not accessible', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue(null)
    await expect(svc.getDetail('u1', 'acc1', 'conv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s if assertConversationAccess passes but findUnique returns null', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue(null)
    await expect(svc.getDetail('u1', 'acc1', 'conv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns conversation + aggregate counts with null forwardedFrom', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _max: { createdAt: new Date('2026-05-03T00:00:00Z') },
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    expect(out.messageCount).toBe(5)
    expect(out.lastMessageAt?.toISOString()).toBe('2026-05-03T00:00:00.000Z')
    expect(out.forwardedFrom).toBeNull()
  })

  it('reports no messaging window on a channel that has none', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      inbox: { id: 'inb1', channelType: 'WEB_WIDGET' },
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 0 }, _max: { createdAt: null },
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    // A widget conversation is always writable — null, not a closed window.
    expect(out.messagingWindow).toBeNull()
    expect(deps.whatsapp.messagingWindowFor).not.toHaveBeenCalled()
  })

  it('reports the window on a WhatsApp conversation', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 0 }, _max: { createdAt: null },
    })
    deps.whatsapp.messagingWindowFor.mockResolvedValue({
      open: false, lastInboundAt: null, expiresAt: null,
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    expect(out.messagingWindow).toEqual({
      open: false, lastInboundAt: null, expiresAt: null,
    })
  })

  it('returns lastMessageAt null when no messages', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _max: { createdAt: null },
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    expect(out.lastMessageAt).toBeNull()
  })

  it('resolves forwardedFrom when set + source exists', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      forwardedFromConversationId: 'src1',
    })
    deps.prisma.conversation.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'conv1') {
        return {
          ...SAMPLE_CONVERSATION,
          forwardedFromConversationId: 'src1',
          inbox: { id: 'inb1', channelType: 'WHATSAPP' },
        }
      }
      return { id: 'src1', displayId: 7 }
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { createdAt: new Date() },
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    expect(out.forwardedFrom).toEqual({ id: 'src1', displayId: 7 })
  })

  it('leaves forwardedFrom null when source row no longer exists', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      forwardedFromConversationId: 'src1',
    })
    deps.prisma.conversation.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'conv1') {
        return {
          ...SAMPLE_CONVERSATION,
          forwardedFromConversationId: 'src1',
          inbox: { id: 'inb1', channelType: 'WHATSAPP' },
        }
      }
      return null
    })
    deps.prisma.message.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _max: { createdAt: new Date() },
    })
    const out = await svc.getDetail('u1', 'acc1', 'conv1')
    expect(out.forwardedFrom).toBeNull()
  })
})

// ─── remove ──────────────────────────────────────────────────────────

describe('ConversationsService.remove', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
  })

  it('404s when the conversation is not accessible', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue(null)
    await expect(svc.remove('u1', 'acc1', 'conv1')).rejects.toThrow(
      NotFoundException,
    )
    expect(deps.prisma.conversation.delete).not.toHaveBeenCalled()
  })

  it('deletes the conversation when accessible', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.delete.mockResolvedValue({})
    await svc.remove('u1', 'acc1', 'conv1')
    expect(deps.prisma.conversation.delete).toHaveBeenCalledWith({
      where: { id: 'conv1' },
    })
  })
})

// ─── buildTranscript ─────────────────────────────────────────────────

describe('ConversationsService.buildTranscript', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('404s when the conversation row is missing after the access check', async () => {
    deps.prisma.conversation.findUnique.mockResolvedValue(null)
    await expect(svc.buildTranscript('u1', 'acc1', 'conv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('renders public messages with each speaker label, skips private notes', async () => {
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      contact: { name: 'Ada Lovelace', email: null, phoneNumber: null },
    })
    deps.prisma.message.findMany.mockResolvedValue([
      {
        content: 'Hi there',
        senderType: 'CONTACT',
        createdAt: new Date('2026-05-01T10:00:00Z'),
        contentType: 'TEXT',
      },
      {
        content: 'How can I help?',
        senderType: 'USER',
        createdAt: new Date('2026-05-01T10:01:00Z'),
        contentType: 'TEXT',
      },
      {
        content: 'auto reply',
        senderType: 'AGENT_BOT',
        createdAt: new Date('2026-05-01T10:02:00Z'),
        contentType: 'TEXT',
      },
      {
        content: null,
        senderType: 'SYSTEM',
        createdAt: new Date('2026-05-01T10:03:00Z'),
        contentType: 'IMAGE',
      },
    ])
    const out = await svc.buildTranscript('u1', 'acc1', 'conv1')
    expect(out.displayId).toBe(42)
    expect(out.filename).toBe('conversation-42.txt')
    // private messages are excluded at the query level
    expect(deps.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv1', isPrivate: false } }),
    )
    expect(out.text).toContain('Conversation #42 — Ada Lovelace')
    expect(out.text).toContain('Ada Lovelace: Hi there')
    expect(out.text).toContain('Agent: How can I help?')
    expect(out.text).toContain('Bot: auto reply')
    // null content falls back to the content type, SYSTEM speaker label
    expect(out.text).toContain('System: [image]')
  })

  it('falls back through email then phone for the contact label', async () => {
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      contact: { name: null, email: null, phoneNumber: '+5511999' },
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    const out = await svc.buildTranscript('u1', 'acc1', 'conv1')
    expect(out.text).toContain('+5511999')
  })

  it('uses a generic "Contact" label when the contact has no identity', async () => {
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      contact: { name: null, email: null, phoneNumber: null },
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    const out = await svc.buildTranscript('u1', 'acc1', 'conv1')
    expect(out.text).toContain('Contact')
  })
})

// ─── create ─────────────────────────────────────────────────────────

describe('ConversationsService.create', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    mockTransactionPassthrough(deps.prisma)
  })

  it('404s on unknown contact', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue(null)
    await expect(
      svc.create('u1', 'acc1', { contactId: 'cnt1', inboxId: 'inb1' } as never),
    ).rejects.toThrow(/Contact not found/)
  })

  it('404s on cross-account contact', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({
      id: 'cnt1',
      accountId: 'other',
    })
    await expect(
      svc.create('u1', 'acc1', { contactId: 'cnt1', inboxId: 'inb1' } as never),
    ).rejects.toThrow(/Contact not found/)
  })

  it('404s on unknown inbox', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      svc.create('u1', 'acc1', { contactId: 'cnt1', inboxId: 'inb1' } as never),
    ).rejects.toThrow(/Inbox not found/)
  })

  it('404s on cross-account inbox', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      accountId: 'other',
    })
    await expect(
      svc.create('u1', 'acc1', { contactId: 'cnt1', inboxId: 'inb1' } as never),
    ).rejects.toThrow(/Inbox not found/)
  })

  it('forbids non-privileged users not on inbox', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.inboxMember.findUnique.mockResolvedValue(null)
    await expect(
      svc.create('u1', 'acc1', { contactId: 'cnt1', inboxId: 'inb1' } as never),
    ).rejects.toThrow(/Not a member of this inbox/)
  })

  it('allows non-privileged user when inbox member exists', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.inboxMember.findUnique.mockResolvedValue({ id: 'im1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    const out = await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
    } as never)
    expect(out.id).toBe('conv1')
  })

  it('creates a new ContactInbox when none exists, without sourceId', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue(null)
    deps.prisma.contactInbox.create.mockResolvedValue({ id: 'ci-new' })
    deps.prisma.conversation.create.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      contactInboxId: 'ci-new',
    })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      contactInboxId: 'ci-new',
    })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
    } as never)
    expect(deps.prisma.contactInbox.create).toHaveBeenCalled()
  })

  it('reuses existing ContactInbox by (inboxId,sourceId) lookup', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique
      .mockResolvedValueOnce(null) // by (contactId,inboxId)
      .mockResolvedValueOnce({ id: 'ci-by-source', contactId: 'cnt1' }) // by source
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
      sourceId: 'wa:12345',
    } as never)
    expect(deps.prisma.contactInbox.create).not.toHaveBeenCalled()
  })

  it('throws Conflict if sourceId is used by a DIFFERENT contact', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ci-other', contactId: 'OTHER' })
    await expect(
      svc.create('u1', 'acc1', {
        contactId: 'cnt1',
        inboxId: 'inb1',
        sourceId: 'wa:12345',
      } as never),
    ).rejects.toThrow(/already used by another contact/)
  })

  it('falls through to create ContactInbox when sourceId lookup returns null', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    deps.prisma.contactInbox.create.mockResolvedValue({ id: 'ci-new' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
      sourceId: 'wa:12345',
    } as never)
    expect(deps.prisma.contactInbox.create).toHaveBeenCalledWith({
      data: { contactId: 'cnt1', inboxId: 'inb1', sourceId: 'wa:12345' },
    })
  })

  it('creates initial CONTACT message + fires CONVERSATION_CREATED with isFirstMessage=true', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.message.create.mockResolvedValue({ id: 'm1' })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
      initialMessage: {
        senderType: 'CONTACT',
        content: 'hi',
        contentType: 'TEXT',
        isPrivate: false,
      },
    } as never)
    expect(deps.prisma.message.create).toHaveBeenCalled()
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'CONVERSATION_CREATED',
        isFirstMessage: true,
      }),
    )
  })

  it('updates firstReplyAt/agentLastSeenAt when initial USER message is public', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.message.create.mockResolvedValue({ id: 'm1' })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
      initialMessage: {
        senderType: 'USER',
        content: 'first reply',
        contentType: 'TEXT',
        isPrivate: false,
      },
    } as never)
    expect(deps.prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: expect.objectContaining({
        firstReplyAt: expect.any(Date),
        agentLastSeenAt: expect.any(Date),
      }),
    })
  })

  it('does not update firstReplyAt when initial USER message is private', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.prisma.message.create.mockResolvedValue({ id: 'm1' })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
      initialMessage: {
        senderType: 'USER',
        content: 'private note',
        contentType: 'TEXT',
        isPrivate: true,
      },
    } as never)
    expect(deps.prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('throws NotFound when fresh conversation lookup returns null', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue(null)
    await expect(
      svc.create('u1', 'acc1', {
        contactId: 'cnt1',
        inboxId: 'inb1',
      } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('dispatches webhook + automation post-commit (isFirstMessage=false when no initial)', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
    } as never)
    expect(deps.webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'conversation.created',
      expect.objectContaining({ conversationId: 'conv1' }),
    )
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ isFirstMessage: false }),
    )
  })

  it('swallows webhook dispatch errors', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.contact.findUnique.mockResolvedValue({ id: 'cnt1', accountId: 'acc1' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci1' })
    deps.prisma.conversation.create.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      // getDetail selects the inbox; the window check reads its channelType.
      inbox: { id: 'inb1', channelType: 'WHATSAPP' },
    })
    deps.webhooks.dispatch.mockRejectedValue(new Error('queue down'))
    const out = await svc.create('u1', 'acc1', {
      contactId: 'cnt1',
      inboxId: 'inb1',
    } as never)
    expect(out.id).toBe('conv1')
    // give the void promise a tick to settle so the rejection handler runs
    await new Promise((r) => setImmediate(r))
  })
})

// ─── update ────────────────────────────────────────────────────────

describe('ConversationsService.update — transcript activity notes (Nebula parity)', () => {
  let deps: Deps
  let svc: ConversationsService

  // Notes go through the shared ActivityService; assert on what we asked it
  // to write (the service's own tests cover the row + realtime publish).
  const activityRows = () =>
    deps.activity.log.mock.calls.map((c) => c[1] as Record<string, unknown>)

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('asks the activity service for a resolved note naming the actor', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'RESOLVED' })
    await svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED' } as never)
    const rows = activityRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('Conversation resolved by Ana Agent')
    // Structured facts travel with the note so the UI can localise later.
    expect(rows[0]).toMatchObject({ type: 'status', from: 'OPEN', to: 'RESOLVED' })
    // The row write + realtime publish are ActivityService's job, covered by
    // its own tests; here we only assert what we asked it to record.
    expect(deps.activity.log).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv1' }),
      expect.anything(),
    )
  })

  it('writes no note for a reopen, because a closed conversation is never reopened', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'RESOLVED' })
    await expect(
      svc.update('u1', 'acc1', 'conv1', { status: 'OPEN' } as never),
    ).rejects.toMatchObject({ response: { code: 'conversation_closed' } })
    expect(activityRows()).toHaveLength(0)
  })

  it('names the assignee, and phrases a self-assignment differently', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u2' })
    deps.prisma.user.findUnique.mockResolvedValue({ fullName: 'Bruno Silva' }) // target
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation assigned to Bruno Silva by Ana Agent')

    // Self-assignment: "Ana self-assigned", not "assigned to Ana by Ana".
    const again = makeService()
    again.deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    again.deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    again.deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u1' })
    await again.svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u1' } as never)
    const selfRows = again.deps.activity.log.mock.calls.map((c) => c[1] as Record<string, unknown>)
    expect(selfRows[0]!.text).toBe('Ana Agent self-assigned this conversation')
  })

  it('writes the transfer note as a private message after a handover', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u2' })
    deps.prisma.user.findUnique.mockResolvedValue({ fullName: 'Bruno Silva' })
    deps.prisma.message.create.mockResolvedValue({ id: 'note1', content: 'Cliente quer 2ª via do boleto', createdAt: new Date() })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2', transferNote: 'Cliente quer 2ª via do boleto' } as never)
    expect(deps.prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 'conv1',
        senderType: 'USER',
        senderUserId: 'u1',
        content: 'Cliente quer 2ª via do boleto',
        contentAttributes: { transferNote: true },
        isPrivate: true,
      }),
    })
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageCreated', messageId: 'note1', isPrivate: true }),
    )
  })

  it('also takes a transfer note with a team change, and ignores it without a handover', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't2' })
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Financeiro' })
    deps.prisma.message.create.mockResolvedValue({ id: 'note2', content: 'x', createdAt: new Date() })
    await svc.update('u1', 'acc1', 'conv1', { teamId: 't2', assigneeId: undefined, transferNote: 'x' } as never)
    expect(deps.prisma.message.create).toHaveBeenCalledTimes(1)

    deps.prisma.message.create.mockClear()
    await svc.update('u1', 'acc1', 'conv1', { priority: 'HIGH', transferNote: 'sem troca' } as never)
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: SAMPLE_CONVERSATION.assigneeId, transferNote: 'mesmo dono' } as never)
    expect(deps.prisma.message.create).not.toHaveBeenCalled()
  })

  it('notes unassignment and team routing', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u9' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: null })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: null } as never)
    expect(activityRows()[0]!.text).toBe('Conversation unassigned by Ana Agent')

    deps.activity.log.mockClear()
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Suporte' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't1' })
    await svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation assigned to team Suporte by Ana Agent')
  })

  it('notes a priority change', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, priority: 'URGENT' })
    await svc.update('u1', 'acc1', 'conv1', { priority: 'URGENT' } as never)
    expect(activityRows()[0]!.text).toBe('Priority changed to urgent by Ana Agent')
  })

  it('writes NOTHING when the values did not actually change', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', {
      status: 'OPEN',
      priority: 'NORMAL',
      assigneeId: null,
      teamId: null,
    } as never)
    expect(activityRows()).toHaveLength(0)
  })

  it('omits the actor name when the user record has none', async () => {
    deps.activity.actorName.mockResolvedValue(null)
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'RESOLVED' })
    await svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation resolved')
  })

  it('falls back to a generic label when the assignee or team record is missing', async () => {
    deps.prisma.user.findUnique.mockResolvedValue(null) // target unknown
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u2' })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation assigned to an agent by Ana Agent')
  })

  it('notes removal from a team', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't9' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: null })
    await svc.update('u1', 'acc1', 'conv1', { teamId: null } as never)
    expect(activityRows()[0]!.text).toBe('Conversation removed from its team by Ana Agent')
  })

  it('bulk status change writes a note per conversation that actually changed', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
      { id: 'c2', status: 'RESOLVED', resolvedAt: new Date(), reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    deps.prisma.$transaction.mockResolvedValue([])
    await svc.bulk('u1', 'acc1', ['c1', 'c2'], { type: 'STATUS', status: 'RESOLVED' } as never)
    const rows = activityRows()
    // c2 was already RESOLVED — no note for it.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('Conversation resolved by Ana Agent')
  })

  it('bulk "mark open" leaves closed conversations closed, and bulk pending gets the right wording', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'RESOLVED', resolvedAt: new Date(), reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
      { id: 'c3', status: 'PENDING', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    deps.prisma.$transaction.mockResolvedValue([])
    const out = await svc.bulk('u1', 'acc1', ['c1', 'c3'], { type: 'STATUS', status: 'OPEN' } as never)
    // Only the pending one moved; the closed one was skipped, not reopened.
    expect(out).toEqual({ updated: 1 })
    expect(deps.prisma.conversation.update).toHaveBeenCalledTimes(1)
    expect(deps.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c3' } }),
    )
    expect(deps.prisma.conversation.update.mock.calls[0]![0].data).not.toHaveProperty('reopenedAt')
    expect(activityRows()).toHaveLength(1)
    expect(activityRows()[0]!.text).toBe('Conversation marked open by Ana Agent')
    expect(deps.realtime.publish).toHaveBeenCalledTimes(1)

    deps.activity.log.mockClear()
    deps.prisma.conversation.update.mockClear()
    // A selection of closed conversations only: nothing to do, nothing fails.
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'RESOLVED', resolvedAt: new Date(), reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    expect(
      await svc.bulk('u1', 'acc1', ['c1'], { type: 'STATUS', status: 'PENDING' } as never),
    ).toEqual({ updated: 0 })
    expect(deps.prisma.conversation.update).not.toHaveBeenCalled()
    expect(activityRows()).toHaveLength(0)

    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c2', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    await svc.bulk('u1', 'acc1', ['c2'], { type: 'STATUS', status: 'PENDING' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation marked pending by Ana Agent')
  })

  it('bulk assign and bulk priority write notes too', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 1 })
    // ensureAccountMember uses findUnique; keep the ADMINISTRATOR default but
    // make it active so the assign passes validation.
    deps.prisma.accountMember.findUnique.mockResolvedValue({
      ...priv('ADMINISTRATOR'),
      isActive: true,
    })
    deps.prisma.user.findUnique.mockResolvedValue({ fullName: 'Bruno Silva' })
    await svc.bulk('u1', 'acc1', ['c1'], { type: 'ASSIGN', assigneeId: 'u2' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation assigned to Bruno Silva by Ana Agent')

    deps.activity.log.mockClear()
    await svc.bulk('u1', 'acc1', ['c1'], { type: 'PRIORITY', priority: 'URGENT' } as never)
    expect(activityRows()[0]!.text).toBe('Priority changed to urgent by Ana Agent')

    // Unassigning in bulk reads as "unassigned".
    deps.activity.log.mockClear()
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: 'u9', priority: 'NORMAL' },
    ])
    await svc.bulk('u1', 'acc1', ['c1'], { type: 'ASSIGN', assigneeId: null } as never)
    expect(activityRows()[0]!.text).toBe('Conversation unassigned by Ana Agent')
  })

  it('degrades gracefully when names are missing (no actor, no target)', async () => {
    // self-assign with no actor record
    deps.activity.actorName.mockResolvedValue(null)
    deps.prisma.user.findUnique.mockResolvedValue(null)
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, assigneeId: 'u1' })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u1' } as never)
    expect(activityRows()[0]!.text).toBe('An agent self-assigned this conversation')

    // bulk with no actor record and an unknown assignee
    deps.activity.log.mockClear()
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
    ])
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 1 })
    deps.prisma.accountMember.findUnique.mockResolvedValue({
      ...priv('ADMINISTRATOR'),
      isActive: true,
    })
    await svc.bulk('u1', 'acc1', ['c1'], { type: 'ASSIGN', assigneeId: 'u2' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation assigned to an agent')
  })

  it('marks non-resolved statuses with the status name', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'PENDING' })
    await svc.update('u1', 'acc1', 'conv1', { status: 'PENDING' } as never)
    expect(activityRows()[0]!.text).toBe('Conversation marked pending by Ana Agent')
  })
})

describe('ConversationsService.update', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    // Default: caller has access
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('updates priority alone', async () => {
    deps.prisma.conversation.update.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      priority: 'HIGH',
    })
    const out = await svc.update('u1', 'acc1', 'conv1', { priority: 'HIGH' } as never)
    expect(out.priority).toBe('HIGH')
    expect(deps.realtime.publish).not.toHaveBeenCalled() // status didn't change
    // Automation fires because a tracked field (priority) changed.
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_UPDATED' }),
    )
  })

  it('updates aiSummary/aiSentiment/aiTags without triggering automation or realtime', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', {
      aiSummary: 'sum',
      aiSentiment: 'POSITIVE',
      aiTags: ['x'],
    } as never)
    expect(deps.realtime.publish).not.toHaveBeenCalled()
    expect(deps.automation.evaluate).not.toHaveBeenCalled()
  })

  it('updates status OPEN→RESOLVED: sets resolvedAt, publishes realtime, dispatches conversation.resolved webhook, triggers CSAT', async () => {
    deps.prisma.conversation.update.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      resolvedAt: new Date(),
    })
    await svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED' } as never)
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ConversationStatusChanged', status: 'RESOLVED' }),
    )
    expect(deps.webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'conversation.resolved',
      expect.any(Object),
    )
    expect(deps.csat.maybeCreateForResolvedConversation).toHaveBeenCalledWith('conv1')
  })

  describe('closing message (PoC item 08)', () => {
    const closing = (closingMessage: string | null) => {
      deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'RESOLVED' })
      deps.prisma.conversation.findUnique.mockResolvedValue({
        ...SAMPLE_CONVERSATION,
        displayId: 77,
        inbox: { name: 'Financeiro', closingMessage },
        contact: { name: 'Maria Souza', email: null, phoneNumber: '+1234', customAttributes: {} },
      })
      deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'WHATSAPP' })
      deps.prisma.message.create.mockResolvedValue({ id: 'm-close', createdAt: new Date('2026-10-16T12:00:00Z') })
    }
    const resolve = () => svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED' } as never)

    it('goes to the contact with their variables, before the CSAT survey', async () => {
      closing('Obrigado, {{contact.first_name}}! Atendimento {{conversation.id}} encerrado por {{agent.name}}.')
      const order: string[] = []
      deps.whatsapp.sendOutbound.mockImplementation(async () => { order.push('closing'); return { wamid: 'w-close' } })
      deps.csat.maybeCreateForResolvedConversation.mockImplementation(async () => { order.push('csat') })
      await resolve()
      const text = 'Obrigado, Maria! Atendimento 77 encerrado por Ana Agent.'
      expect(deps.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ senderType: 'AGENT_BOT', content: text, status: 'PENDING', inboxId: SAMPLE_CONVERSATION.inboxId }),
      })
      expect(deps.whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+1234', text)
      // Settled only from PENDING, so a receipt that raced ahead is not undone.
      expect(deps.prisma.message.updateMany).toHaveBeenCalledWith({
        where: { id: 'm-close', status: 'PENDING' },
        data: { status: 'SENT' },
      })
      expect(deps.realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'MessageCreated', messageId: 'm-close', content: text }))
      expect(order).toEqual(['closing', 'csat'])
    })

    it('an inbox without one, or one that renders empty, sends nothing', async () => {
      closing(null)
      await resolve()
      closing('{{contact.email}}')
      await resolve()
      expect(deps.prisma.message.create).not.toHaveBeenCalled()
    })

    it('a failed push is recorded as FAILED, never as delivered', async () => {
      closing('Até logo!')
      deps.whatsapp.sendOutbound.mockRejectedValueOnce(new Error('window closed')).mockRejectedValueOnce('boom')
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await resolve()
      await resolve()
      expect(deps.prisma.message.updateMany.mock.calls.map((c: Array<{ data: { status: string } }>) => c[0].data.status)).toEqual(['FAILED', 'FAILED'])
      expect(err).toHaveBeenCalledWith('[closing] outbound failed for conv1:', 'boom')
    })

    it('never undoes the resolution when writing the message fails', async () => {
      closing('Até logo!')
      deps.prisma.message.create.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce('down')
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      await expect(resolve()).resolves.toBeDefined()
      await expect(resolve()).resolves.toBeDefined()
      expect(err).toHaveBeenCalledWith('[closing] closing message failed for conv1:', 'down')
      expect(deps.csat.maybeCreateForResolvedConversation).toHaveBeenCalledTimes(2)
    })
  })

  it.each(['OPEN', 'PENDING'] as const)(
    'refuses RESOLVED→%s with 409 conversation_closed and changes nothing',
    async (next) => {
      deps.prisma.conversation.findFirst.mockResolvedValue({
        ...SAMPLE_CONVERSATION,
        status: 'RESOLVED',
        resolvedAt: new Date('2026-05-01T00:00:00Z'),
      })
      const attempt = svc.update('u1', 'acc1', 'conv1', { status: next } as never)
      await expect(attempt).rejects.toBeInstanceOf(ConflictException)
      await expect(attempt).rejects.toMatchObject({
        response: { code: 'conversation_closed' },
      })
      expect(deps.prisma.conversation.update).not.toHaveBeenCalled()
      expect(deps.realtime.publish).not.toHaveBeenCalled()
      expect(deps.webhooks.dispatch).not.toHaveBeenCalled()
      expect(deps.csat.maybeCreateForResolvedConversation).not.toHaveBeenCalled()
    },
  )

  it('still lets a closed conversation be edited in ways that do not reopen it', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      resolvedAt: new Date('2026-05-01T00:00:00Z'),
    })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, status: 'RESOLVED' })
    // Same status again, and a field that has nothing to do with status.
    await expect(
      svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED', priority: 'HIGH' } as never),
    ).resolves.toBeDefined()
    await expect(
      svc.update('u1', 'acc1', 'conv1', { priority: 'LOW' } as never),
    ).resolves.toBeDefined()
  })

  it('does NOT publish realtime nor dispatch resolved/reopened when status is unchanged', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { status: 'OPEN' } as never)
    expect(deps.realtime.publish).not.toHaveBeenCalled()
    expect(deps.webhooks.dispatch).not.toHaveBeenCalled()
  })

  it('does NOT dispatch resolved/reopened on status changes other than to/from RESOLVED', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'OPEN',
    })
    deps.prisma.conversation.update.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'PENDING',
    })
    await svc.update('u1', 'acc1', 'conv1', { status: 'PENDING' } as never)
    expect(deps.realtime.publish).toHaveBeenCalled() // status DID change
    expect(deps.webhooks.dispatch).not.toHaveBeenCalled() // but not RESOLVED related
    expect(deps.csat.maybeCreateForResolvedConversation).not.toHaveBeenCalled()
  })

  it('swallows webhook dispatch errors on status change', async () => {
    deps.prisma.conversation.update.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
    })
    deps.webhooks.dispatch.mockRejectedValue(new Error('queue down'))
    deps.csat.maybeCreateForResolvedConversation.mockRejectedValue(
      new Error('csat svc down'),
    )
    await expect(
      svc.update('u1', 'acc1', 'conv1', { status: 'RESOLVED' } as never),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })

  it('disconnects assignee when assigneeId=null', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: null } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.assignee).toEqual({ disconnect: true })
  })

  it('connects assignee when assigneeId is a valid account member', async () => {
    // Re-mock accountMember for the ensureAccountMember check
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR')) // getMembership
      .mockResolvedValueOnce({ id: 'm2', userId: 'u2', isActive: true }) // ensureAccountMember
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.assignee).toEqual({ connect: { id: 'u2' } })
  })

  it('404s when assignee is not an account member', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce(null)
    await expect(
      svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never),
    ).rejects.toThrow(/User is not a member/)
  })

  it('404s when assignee membership is inactive', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce({ userId: 'u2', isActive: false })
    await expect(
      svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never),
    ).rejects.toThrow(/User is not a member/)
  })

  it('sets controlMode explicitly (hand back to bot)', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { controlMode: 'BOT' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.controlMode).toBe('BOT')
  })

  it('writes conversation customAttributes without triggering automation', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', {
      customAttributes: { plan: 'enterprise' },
    } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.customAttributes).toEqual({ plan: 'enterprise' })
    expect(deps.automation.evaluate).not.toHaveBeenCalled()
  })

  it('assigning a human flips controlMode to HUMAN', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR')) // getMembership
      .mockResolvedValueOnce({ id: 'm2', userId: 'u2', isActive: true }) // ensureAccountMember
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.controlMode).toBe('HUMAN')
  })

  it('a manual assignment tells the person who received it', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce({ id: 'm2', userId: 'u2', isActive: true })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })

    await svc.update('u1', 'acc1', 'conv1', { assigneeId: 'u2' } as never)

    expect(deps.notifications.createAssignment).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'conv1',
      assigneeId: 'u2',
      // A person did this one, so the bell can name them.
      assignedByUserId: 'u1',
      previousAssigneeId: null,
    })
  })

  it('unassigning still runs, so the old owner stops being nagged', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValueOnce(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      assigneeId: 'u9',
    })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })

    await svc.update('u1', 'acc1', 'conv1', { assigneeId: null } as never)

    expect(deps.notifications.createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: null, previousAssigneeId: 'u9' }),
    )
  })

  it('assigning a human respects an explicit controlMode in the same request', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce({ id: 'm2', userId: 'u2', isActive: true })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', {
      assigneeId: 'u2',
      controlMode: 'BOT',
    } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.controlMode).toBe('BOT')
  })

  it('disconnects team when teamId=null', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { teamId: null } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.team).toEqual({ disconnect: true })
  })

  it('connects team when teamId belongs to account', async () => {
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.team).toEqual({ connect: { id: 't1' } })
  })

  it('a new team distributes the conversation and returns the routed assignee', async () => {
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Suporte' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't1' })
    deps.assignment.route.mockResolvedValue({ assigneeId: 'u5', pickedId: 'u5' })
    const out = await svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never)
    expect(deps.assignment.route).toHaveBeenCalledWith('conv1', 'team_changed')
    expect(out.assigneeId).toBe('u5')
  })

  it('keeps the saved assignee when the routing outcome is unknown', async () => {
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Suporte' })
    deps.prisma.conversation.update.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      teamId: 't1',
      assigneeId: 'u3',
    })
    deps.assignment.route.mockResolvedValue(null)
    const out = await svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never)
    expect(out.assigneeId).toBe('u3')
  })

  it('does not route when the same request picks the assignee', async () => {
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Suporte' })
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { teamId: 't1', assigneeId: 'u1' } as never)
    expect(deps.assignment.route).not.toHaveBeenCalled()
  })

  it('does not route when the team did not change', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't1' })
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1', name: 'Suporte' })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION, teamId: 't1' })
    await svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never)
    expect(deps.assignment.route).not.toHaveBeenCalled()
  })

  it('404s on unknown team', async () => {
    deps.prisma.team.findUnique.mockResolvedValue(null)
    await expect(
      svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never),
    ).rejects.toThrow(/Team not found/)
  })

  it('404s on cross-account team', async () => {
    deps.prisma.team.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(
      svc.update('u1', 'acc1', 'conv1', { teamId: 't1' } as never),
    ).rejects.toThrow(/Team not found/)
  })

  it('triggers automation on teamId change', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { teamId: null } as never)
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONVERSATION_UPDATED' }),
    )
  })

  it('does NOT trigger automation when only ai* fields changed', async () => {
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', {
      aiTags: ['tag'],
    } as never)
    expect(deps.automation.evaluate).not.toHaveBeenCalled()
  })

  it('logs automation errors but does not propagate', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.automation.evaluate.mockRejectedValue(new Error('rule blew up'))
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await expect(
      svc.update('u1', 'acc1', 'conv1', { priority: 'HIGH' } as never),
    ).resolves.toBeDefined()
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('logs automation non-Error rejections (string thrown)', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.automation.evaluate.mockRejectedValue('plain string error')
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { priority: 'HIGH' } as never)
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })
})

// ─── bulk ──────────────────────────────────────────────────────────

describe('ConversationsService.bulk', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    mockTransactionPassthrough(deps.prisma)
  })

  it('returns updated=0 when no conversations are visible', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([])
    const out = await svc.bulk('u1', 'acc1', ['c1'], {
      type: 'STATUS',
      status: 'RESOLVED',
    } as never)
    expect(out.updated).toBe(0)
  })

  it('STATUS: updates visible rows and publishes realtime for status transitions', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'a', status: 'OPEN', resolvedAt: null, reopenedAt: null },
      { id: 'b', status: 'RESOLVED', resolvedAt: new Date(), reopenedAt: null },
    ])
    deps.prisma.conversation.update.mockResolvedValue({})
    const out = await svc.bulk('u1', 'acc1', ['a', 'b'], {
      type: 'STATUS',
      status: 'RESOLVED',
    } as never)
    expect(out.updated).toBe(2)
    // Only one publish: 'a' (open→resolved). 'b' is already resolved.
    expect(deps.realtime.publish).toHaveBeenCalledTimes(1)
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'a', status: 'RESOLVED' }),
    )
  })

  it('STATUS RESOLVED sends the closing message to each conversation it actually closed', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'a', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1' },
      { id: 'b', status: 'RESOLVED', resolvedAt: new Date(), reopenedAt: null, inboxId: 'inb1' },
    ])
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.conversation.findUnique.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      id: 'a',
      inbox: { name: 'Financeiro', closingMessage: 'Encerrado por {{agent.name}}.' },
      contact: null,
    })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'API' })
    deps.prisma.message.create.mockResolvedValue({ id: 'm1', createdAt: new Date() })
    await svc.bulk('u1', 'acc1', ['a', 'b'], { type: 'STATUS', status: 'RESOLVED' } as never)
    // Sent in the background, after the response; only 'a' changed, 'b' was
    // already closed and hears nothing again.
    await vi.waitFor(() =>
      expect(deps.prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ conversationId: 'a', content: 'Encerrado por Ana Agent.' }),
      }),
    )
    expect(deps.prisma.conversation.findUnique).toHaveBeenCalledTimes(1)
  })

  it('STATUS PENDING in bulk sends no closing message', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'a', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1' },
    ])
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.bulk('u1', 'acc1', ['a'], { type: 'STATUS', status: 'PENDING' } as never)
    expect(deps.prisma.conversation.findUnique).not.toHaveBeenCalled()
  })

  it('PRIORITY: bulk-updates and returns count from updateMany result', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 1 })
    const out = await svc.bulk('u1', 'acc1', ['a'], {
      type: 'PRIORITY',
      priority: 'URGENT',
    } as never)
    expect(out.updated).toBe(1)
    expect(deps.prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
      data: { priority: 'URGENT' },
    })
  })

  it('ASSIGN(null): clears assignee on visible rows', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 1 })
    const out = await svc.bulk('u1', 'acc1', ['a'], {
      type: 'ASSIGN',
      assigneeId: null,
    } as never)
    expect(out.updated).toBe(1)
    expect(deps.prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a'] } },
      data: { assigneeId: null },
    })
  })

  it('ASSIGN(uid): asserts account member then assigns', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce({ id: 'm2', userId: 'u2', isActive: true })
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 1 })
    const out = await svc.bulk('u1', 'acc1', ['a'], {
      type: 'ASSIGN',
      assigneeId: 'u2',
    } as never)
    expect(out.updated).toBe(1)
  })

  it('ASSIGN in bulk notifies once per conversation', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'a', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: null, priority: 'NORMAL' },
      { id: 'b', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: 'u9', priority: 'NORMAL' },
      // Already theirs: no change, so nothing to announce.
      { id: 'c', status: 'OPEN', resolvedAt: null, reopenedAt: null, inboxId: 'inb1', assigneeId: 'u2', priority: 'NORMAL' },
    ])
    deps.prisma.accountMember.findUnique.mockResolvedValue({
      ...priv('ADMINISTRATOR'),
      isActive: true,
    })
    deps.prisma.conversation.updateMany.mockResolvedValue({ count: 3 })

    await svc.bulk('u1', 'acc1', ['a', 'b', 'c'], {
      type: 'ASSIGN',
      assigneeId: 'u2',
    } as never)

    // Assigning 50 threads to someone really is 50 things they now own.
    const calls = deps.notifications.createAssignment.mock.calls.map((c) => c[0])
    expect(calls).toEqual([
      expect.objectContaining({ conversationId: 'a', assigneeId: 'u2', previousAssigneeId: null }),
      expect.objectContaining({ conversationId: 'b', assigneeId: 'u2', previousAssigneeId: 'u9' }),
    ])
  })

  it('ASSIGN(uid): rejects when user is not member', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce(null)
    await expect(
      svc.bulk('u1', 'acc1', ['a'], {
        type: 'ASSIGN',
        assigneeId: 'u2',
      } as never),
    ).rejects.toThrow(/User is not a member/)
  })

  it('APPLY_LABEL: 404 when label not found', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.label.findUnique.mockResolvedValue(null)
    await expect(
      svc.bulk('u1', 'acc1', ['a'], {
        type: 'APPLY_LABEL',
        labelId: 'l1',
      } as never),
    ).rejects.toThrow(/Label not found/)
  })

  it('APPLY_LABEL: 404 when label belongs to another account', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.label.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(
      svc.bulk('u1', 'acc1', ['a'], {
        type: 'APPLY_LABEL',
        labelId: 'l1',
      } as never),
    ).rejects.toThrow(/Label not found/)
  })

  it('APPLY_LABEL: creates label rows via createMany with skipDuplicates', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    deps.prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    deps.prisma.conversationLabel.createMany.mockResolvedValue({ count: 2 })
    const out = await svc.bulk('u1', 'acc1', ['a', 'b'], {
      type: 'APPLY_LABEL',
      labelId: 'l1',
    } as never)
    expect(out.updated).toBe(2)
    expect(deps.prisma.conversationLabel.createMany).toHaveBeenCalledWith({
      data: [
        { conversationId: 'a', labelId: 'l1' },
        { conversationId: 'b', labelId: 'l1' },
      ],
      skipDuplicates: true,
    })
  })

  it('REMOVE_LABEL: deletes ConversationLabel rows', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([{ id: 'a' }])
    deps.prisma.conversationLabel.deleteMany.mockResolvedValue({ count: 1 })
    const out = await svc.bulk('u1', 'acc1', ['a'], {
      type: 'REMOVE_LABEL',
      labelId: 'l1',
    } as never)
    expect(out.updated).toBe(1)
  })

  it('STATUS: skips realtime publish if status didn\'t change for any row', async () => {
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'a', status: 'OPEN', resolvedAt: null, reopenedAt: null },
    ])
    await svc.bulk('u1', 'acc1', ['a'], {
      type: 'STATUS',
      status: 'OPEN',
    } as never)
    expect(deps.realtime.publish).not.toHaveBeenCalled()
  })
})

// ─── deriveResolvedAt / deriveReopenedAt (via update) ───────────────

describe('ConversationsService — status timestamp derivation (via update)', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
  })

  it('PENDING→PENDING leaves resolvedAt unchanged', async () => {
    const existing = new Date('2026-05-01T00:00:00Z')
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'PENDING',
      resolvedAt: existing,
    })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { status: 'PENDING' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(data.resolvedAt).toBe(existing)
    expect(data).not.toHaveProperty('reopenedAt')
  })

  it('a status update never writes reopenedAt', async () => {
    const existing = new Date('2026-04-01T00:00:00Z')
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'OPEN',
      reopenedAt: existing,
    })
    deps.prisma.conversation.update.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    await svc.update('u1', 'acc1', 'conv1', { status: 'OPEN' } as never)
    const data = deps.prisma.conversation.update.mock.calls[0]![0].data
    // Whatever history the row carries stays as it is.
    expect(data).not.toHaveProperty('reopenedAt')
  })
})

// ─── autoAssign ────────────────────────────────────────────────────
// The rules live in AssignmentService (see assignment.service.test.ts); the
// endpoint only checks access and asks for a forced re-pick.

describe('ConversationsService.autoAssign', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('forces a re-pick through routing and returns the agent picked', async () => {
    deps.assignment.route.mockResolvedValue({ assigneeId: 'u2', pickedId: 'u2' })
    const out = await svc.autoAssign('u1', 'acc1', 'conv1')
    expect(out.assigneeId).toBe('u2')
    expect(deps.assignment.route).toHaveBeenCalledWith('conv1', 'manual', {
      force: true,
    })
  })

  it('returns null when nobody is available (the assignee is left alone)', async () => {
    deps.assignment.route.mockResolvedValue({ assigneeId: 'u7', pickedId: null })
    const out = await svc.autoAssign('u1', 'acc1', 'conv1')
    expect(out.assigneeId).toBeNull()
  })

  it('returns null when the routing outcome is unknown', async () => {
    deps.assignment.route.mockResolvedValue(null)
    const out = await svc.autoAssign('u1', 'acc1', 'conv1')
    expect(out.assigneeId).toBeNull()
  })

  it('does not route a conversation the caller cannot access', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue(null)
    await expect(svc.autoAssign('u1', 'acc1', 'conv1')).rejects.toThrow()
    expect(deps.assignment.route).not.toHaveBeenCalled()
  })
})

// ─── forwardToInbox ────────────────────────────────────────────────

describe('ConversationsService.forwardToInbox', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    mockTransactionPassthrough(deps.prisma)
  })

  it('404s on unknown target inbox', async () => {
    deps.prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      svc.forwardToInbox('u1', 'acc1', 'conv1', { targetInboxId: 'inb2' }),
    ).rejects.toThrow(/Target inbox not found/)
  })

  it('404s on cross-account target inbox', async () => {
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb2',
      accountId: 'other',
    })
    await expect(
      svc.forwardToInbox('u1', 'acc1', 'conv1', { targetInboxId: 'inb2' }),
    ).rejects.toThrow(/Target inbox not found/)
  })

  it('forbids non-privileged user who is not target inbox member', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.inboxMember.findUnique.mockResolvedValue(null)
    await expect(
      svc.forwardToInbox('u1', 'acc1', 'conv1', { targetInboxId: 'inb2' }),
    ).rejects.toThrow(/Not a member of the target inbox/)
  })

  it('forwards with copyAssignee=true (assignee copied) and reuses existing ContactInbox', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      assigneeId: 'u9',
    })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci2' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 99,
    })
    deps.prisma.message.findMany.mockResolvedValue([
      {
        senderType: 'CONTACT',
        content: 'hi',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
      {
        senderType: 'AGENT_BOT',
        content: 'bot reply',
        createdAt: new Date('2026-05-01T00:01:00Z'),
      },
      {
        senderType: 'USER',
        content: 'agent reply',
        createdAt: new Date('2026-05-01T00:02:00Z'),
      },
    ])
    deps.prisma.message.create.mockResolvedValue({})
    const out = await svc.forwardToInbox('u1', 'acc1', 'conv1', {
      targetInboxId: 'inb2',
      copyAssignee: true,
      note: 'check this out',
    })
    expect(out.conversationId).toBe('conv2')
    expect(out.displayId).toBe(99)
    // assignee was copied
    const createCall = deps.prisma.conversation.create.mock.calls[0]![0].data
    expect(createCall.assigneeId).toBe('u9')
    expect(createCall.forwardedFromConversationId).toBe('conv1')
    // transcript message includes the note header
    const msgData = deps.prisma.message.create.mock.calls[0]![0].data
    expect(msgData.content).toContain('Forwarded from conversation #42')
    expect(msgData.content).toContain('Note: check this out')
    expect(msgData.content).toContain('Contact: hi')
    expect(msgData.content).toContain('Bot: bot reply')
    expect(msgData.content).toContain('Agent: agent reply')
    expect(msgData.isPrivate).toBe(true)
  })

  it('forwards without note, no assignee copy, no existing ContactInbox', async () => {
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue(null)
    deps.prisma.contactInbox.create.mockResolvedValue({ id: 'ci-new' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 100,
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    deps.prisma.message.create.mockResolvedValue({})
    const out = await svc.forwardToInbox('u1', 'acc1', 'conv1', {
      targetInboxId: 'inb2',
    })
    expect(out.conversationId).toBe('conv2')
    const createCall = deps.prisma.conversation.create.mock.calls[0]![0].data
    expect(createCall.assigneeId).toBeNull()
    // no note in transcript header
    const msgData = deps.prisma.message.create.mock.calls[0]![0].data
    expect(msgData.content).not.toContain('Note:')
  })

  it('handles copyAssignee=true when source has NO assignee', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      assigneeId: null,
    })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci2' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 100,
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    deps.prisma.message.create.mockResolvedValue({})
    await svc.forwardToInbox('u1', 'acc1', 'conv1', {
      targetInboxId: 'inb2',
      copyAssignee: true,
    })
    const createCall = deps.prisma.conversation.create.mock.calls[0]![0].data
    expect(createCall.assigneeId).toBeNull()
  })

  it('dispatches conversation.created webhook with source=forward', async () => {
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci2' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 100,
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    deps.prisma.message.create.mockResolvedValue({})
    await svc.forwardToInbox('u1', 'acc1', 'conv1', { targetInboxId: 'inb2' })
    expect(deps.webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'conversation.created',
      expect.objectContaining({ source: 'forward', conversationId: 'conv2' }),
    )
  })

  it('swallows webhook dispatch errors on forward', async () => {
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci2' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 100,
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    deps.prisma.message.create.mockResolvedValue({})
    deps.webhooks.dispatch.mockRejectedValue(new Error('queue down'))
    await expect(
      svc.forwardToInbox('u1', 'acc1', 'conv1', { targetInboxId: 'inb2' }),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })

  it('allows non-privileged users who are target-inbox members', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb2', accountId: 'acc1' })
    deps.prisma.inboxMember.findUnique.mockResolvedValue({ id: 'im1' })
    deps.prisma.contactInbox.findUnique.mockResolvedValue({ id: 'ci2' })
    deps.prisma.conversation.create.mockResolvedValue({
      id: 'conv2',
      displayId: 100,
    })
    deps.prisma.message.findMany.mockResolvedValue([])
    deps.prisma.message.create.mockResolvedValue({})
    const out = await svc.forwardToInbox('u1', 'acc1', 'conv1', {
      targetInboxId: 'inb2',
    })
    expect(out.conversationId).toBe('conv2')
  })
})

// ─── participants ──────────────────────────────────────────────────

describe('ConversationsService.addParticipant', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('agents cannot add OTHER users', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    await expect(
      svc.addParticipant('u1', 'acc1', 'conv1', { userId: 'u2' }),
    ).rejects.toThrow(/Agents can only add themselves/)
  })

  it('agents can add themselves', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('AGENT')) // assertConversationAccess
      .mockResolvedValueOnce({ userId: 'u1', isActive: true }) // ensureAccountMember
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue(null)
    deps.prisma.conversationParticipant.create.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      conversationId: 'conv1',
      user: { id: 'u1' },
    })
    const out = await svc.addParticipant('u1', 'acc1', 'conv1', { userId: 'u1' })
    expect(out.id).toBe('p1')
  })

  it('privileged users can add anyone', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('SUPERVISOR'))
      .mockResolvedValueOnce({ userId: 'u2', isActive: true })
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue(null)
    deps.prisma.conversationParticipant.create.mockResolvedValue({
      id: 'p2',
      userId: 'u2',
      conversationId: 'conv1',
      user: { id: 'u2' },
    })
    const out = await svc.addParticipant('u1', 'acc1', 'conv1', { userId: 'u2' })
    expect(out.id).toBe('p2')
  })

  it('409s on duplicate participant', async () => {
    deps.prisma.accountMember.findUnique
      .mockResolvedValueOnce(priv('ADMINISTRATOR'))
      .mockResolvedValueOnce({ userId: 'u2', isActive: true })
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p-x' })
    await expect(
      svc.addParticipant('u1', 'acc1', 'conv1', { userId: 'u2' }),
    ).rejects.toThrow(ConflictException)
  })
})

describe('ConversationsService.removeParticipant', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('agents cannot remove OTHER users', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    await expect(
      svc.removeParticipant('u1', 'acc1', 'conv1', 'u2'),
    ).rejects.toThrow(/Agents can only remove themselves/)
  })

  it('agents can remove themselves', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p1' })
    deps.prisma.conversationParticipant.delete.mockResolvedValue({})
    await svc.removeParticipant('u1', 'acc1', 'conv1', 'u1')
    expect(deps.prisma.conversationParticipant.delete).toHaveBeenCalled()
  })

  it('privileged users can remove anyone', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue({ id: 'p1' })
    deps.prisma.conversationParticipant.delete.mockResolvedValue({})
    await svc.removeParticipant('u1', 'acc1', 'conv1', 'u2')
    expect(deps.prisma.conversationParticipant.delete).toHaveBeenCalled()
  })

  it('404s when participant does not exist', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversationParticipant.findUnique.mockResolvedValue(null)
    await expect(
      svc.removeParticipant('u1', 'acc1', 'conv1', 'u2'),
    ).rejects.toThrow(NotFoundException)
  })
})

// ─── listMessages ──────────────────────────────────────────────────

describe('ConversationsService.listMessages', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
  })

  it('returns rows with nextCursor=null when no more', async () => {
    deps.prisma.message.findMany.mockResolvedValue([])
    const out = await svc.listMessages('u1', 'acc1', 'conv1')
    expect(out.data).toEqual([])
    expect(out.nextCursor).toBeNull()
  })

  it('emits a nextCursor when more rows than limit', async () => {
    deps.prisma.message.findMany.mockResolvedValue([
      { id: 'm1' },
      { id: 'm2' },
    ])
    const out = await svc.listMessages('u1', 'acc1', 'conv1', undefined, 1)
    expect(out.data).toHaveLength(1)
    expect(out.nextCursor).toBe('m2')
  })

  it('handles undefined pop result for messages', async () => {
    const arr: Array<{ id: string }> = []
    Object.defineProperty(arr, 'length', { value: 99 })
    arr.pop = () => undefined as never
    deps.prisma.message.findMany.mockResolvedValue(arr as never)
    const out = await svc.listMessages('u1', 'acc1', 'conv1', undefined, 1)
    expect(out.nextCursor).toBeNull()
  })

  it('caps limit at MAX_MESSAGES_PAGE', async () => {
    deps.prisma.message.findMany.mockResolvedValue([])
    await svc.listMessages('u1', 'acc1', 'conv1', undefined, 9999)
    const call = deps.prisma.message.findMany.mock.calls[0]![0]
    expect(call.take).toBe(201) // MAX_MESSAGES_PAGE + 1
  })

  it('uses cursor when provided', async () => {
    deps.prisma.message.findMany.mockResolvedValue([])
    await svc.listMessages('u1', 'acc1', 'conv1', 'mX', 10)
    const call = deps.prisma.message.findMany.mock.calls[0]![0]
    expect(call.cursor).toEqual({ id: 'mX' })
    expect(call.skip).toBe(1)
  })
})

// ─── sendAgentMessage ──────────────────────────────────────────────

describe('ConversationsService.sendAgentMessage', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    mockTransactionPassthrough(deps.prisma)
  })

  it('404s on unknown inReplyToId', async () => {
    deps.prisma.message.findUnique.mockResolvedValue(null)
    await expect(
      svc.sendAgentMessage('u1', 'acc1', 'conv1', {
        content: 'hi',
        contentType: 'TEXT',
        isPrivate: false,
        inReplyToId: 'mX',
        attachmentIds: [],
      }),
    ).rejects.toThrow(/inReplyToId not found/)
  })

  it('404s on inReplyToId from a DIFFERENT conversation', async () => {
    deps.prisma.message.findUnique.mockResolvedValue({ conversationId: 'OTHER' })
    await expect(
      svc.sendAgentMessage('u1', 'acc1', 'conv1', {
        content: 'hi',
        contentType: 'TEXT',
        isPrivate: false,
        inReplyToId: 'm1',
        attachmentIds: [],
      }),
    ).rejects.toThrow(/inReplyToId not found/)
  })

  it('happy path with valid inReplyToId — public, no attachments, no mentions, non-whatsapp inbox', async () => {
    deps.prisma.message.findUnique.mockResolvedValue({ conversationId: 'conv1' })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    const out = await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
      inReplyToId: 'm1',
    })
    expect(out.id).toBe('m1')
    // realtime + webhook (public) fired
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageCreated' }),
    )
    expect(deps.webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'message.created',
      expect.any(Object),
    )
    // contentAttributes defaults to {}
    const createData = deps.prisma.message.create.mock.calls[0]![0].data
    expect(createData.contentAttributes).toEqual({})
  })

  it('first reply updates firstReplyAt when conversation.firstReplyAt is null and public', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.firstReplyAt).toBeInstanceOf(Date)
  })

  it('public reply on a BOT-controlled conversation flips control to HUMAN', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      controlMode: 'BOT',
    })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'WEB_WIDGET' })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.controlMode).toBe('HUMAN')
  })

  it('private note on a BOT-controlled conversation does NOT flip control', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      controlMode: 'BOT',
    })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'note',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'note',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.controlMode).toBeUndefined()
  })

  it('does NOT set firstReplyAt when private message', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'note',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'note',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.firstReplyAt).toBeUndefined()
    // no webhook for private messages
    expect(deps.webhooks.dispatch).not.toHaveBeenCalled()
  })

  it('refuses a reply to the contact in a closed conversation, without sending anything', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      resolvedAt: new Date(),
    })
    await expect(
      svc.sendAgentMessage('u1', 'acc1', 'conv1', {
        content: 'follow-up',
        contentType: 'TEXT',
        isPrivate: false,
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({ response: { code: 'conversation_closed' } })
    expect(deps.prisma.message.create).not.toHaveBeenCalled()
    expect(deps.prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('still takes an internal note on a closed conversation, and leaves it closed', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      resolvedAt: new Date(),
    })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'ligou depois, tudo certo',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'ligou depois, tudo certo',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData).not.toHaveProperty('status')
    expect(updateData).not.toHaveProperty('reopenedAt')
    expect(updateData).not.toHaveProperty('resolvedAt')
  })

  it('attaches attachments when ids provided', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: ['att1', 'att2'],
    })
    expect(deps.attachments.attachToMessage).toHaveBeenCalledWith(
      'acc1',
      'm1',
      ['att1', 'att2'],
    )
  })

  it('processes @-mentions on private messages and notifies', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hey @alice please look',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-alice', email: 'alice@example.com' } },
      { user: { id: 'u-bob', email: 'bob@example.com' } },
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hey @alice please look',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'conv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u-alice'],
    })
  })

  it('does not call createMentions when no usernames matched', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'just a note no mentions',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'just a note no mentions',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).not.toHaveBeenCalled()
    // findMany never called because parseMentionUsernames returns []
    expect(deps.prisma.accountMember.findMany).not.toHaveBeenCalled()
  })

  it('logs mention-parse errors but does not propagate', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi @alice',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockRejectedValue(new Error('db down'))
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi @alice',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('logs mention-parse non-Error rejections', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi @alice',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockRejectedValue('a string')
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi @alice',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('pushes outbound to WhatsApp when inbox is WHATSAPP-typed', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+1234' })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+1234',
      'hi',
    )
  })

  it('skips WhatsApp push when the contact is unreachable', async () => {
    // Reachability is the resolver's call now, not the contact row's.
    deps.whatsapp.recipientForConversation.mockResolvedValue(null)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: null })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips WhatsApp push when contact lookup returns null', async () => {
    // Reachability is the resolver's call now, not the contact row's.
    deps.whatsapp.recipientForConversation.mockResolvedValue(null)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue(null)
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips WhatsApp push when inbox lookup returns null', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue(null)
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('logs WhatsApp errors but does not propagate', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+1234' })
    deps.whatsapp.sendOutbound.mockRejectedValue(new Error('wa down'))
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('logs WhatsApp non-Error rejection', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+1234' })
    deps.whatsapp.sendOutbound.mockRejectedValue('a string')
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('uses provided contentAttributes', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
      contentAttributes: { foo: 'bar' },
    })
    const createData = deps.prisma.message.create.mock.calls[0]![0].data
    expect(createData.contentAttributes).toEqual({ foo: 'bar' })
  })

  it('does not push to WhatsApp when message is private (even if inbox is WHATSAPP)', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'private note',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'private note',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips WhatsApp push when message content is empty/null', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips mention-parsing on empty private content', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).not.toHaveBeenCalled()
  })

  it('does not call attachToMessage when attachmentIds is empty array', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: [],
    })
    expect(deps.attachments.attachToMessage).not.toHaveBeenCalled()
  })

  it('does not call attachToMessage when attachmentIds is undefined', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
      isPrivate: false,
    } as never)
    expect(deps.attachments.attachToMessage).not.toHaveBeenCalled()
  })
})

// ─── sendAgentMessage → outbound attachments ───────────────────────

describe('ConversationsService.sendAgentMessage — WhatsApp attachments', () => {
  let deps: Deps
  let svc: ConversationsService

  function attachment(over: Record<string, unknown> = {}) {
    return {
      id: 'att1',
      accountId: 'acc1',
      messageId: 'm1',
      storageKey: 'acc1/att1-photo.png',
      fileType: 'IMAGE',
      fileUrl: 'https://cdn.example.com/a.png',
      fileName: 'photo.png',
      mimeType: 'image/png',
      ...over,
    }
  }

  /** Persist `content` and hand `attached` back from attachToMessage. */
  function stubSend(content: string, attached: Array<Record<string, unknown>>) {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content,
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+1234' })
    deps.attachments.attachToMessage.mockResolvedValue(attached)
    return svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content,
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: attached.map((a) => a.id as string),
    })
  }

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    mockTransactionPassthrough(deps.prisma)
  })

  it('pushes an attachment-only message — the regression this fixes', async () => {
    await stubSend('', [attachment()])
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendMedia).toHaveBeenCalledTimes(1)
    expect(deps.whatsapp.sendMedia).toHaveBeenCalledWith('inb1', '+1234', {
      kind: 'image',
      source: { link: 'https://cdn.example.com/a.png' },
      fileName: 'photo.png',
    })
  })

  it('carries the text as the caption of the first attachment', async () => {
    await stubSend('here you go', [attachment(), attachment({ id: 'att2' })])
    // One message on the contact's phone, not a text plus a photo.
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendMedia).toHaveBeenCalledTimes(2)
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2].caption).toBe('here you go')
    expect(deps.whatsapp.sendMedia.mock.calls[1]![2].caption).toBeUndefined()
  })

  it('sends the text on its own when it is past the caption limit', async () => {
    const long = 'x'.repeat(1025)
    await stubSend(long, [attachment()])
    expect(deps.whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+1234', long)
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2].caption).toBeUndefined()
  })

  it('sends the text on its own when every attachment is audio', async () => {
    await stubSend('have a listen', [
      attachment({ fileType: 'AUDIO', mimeType: 'audio/ogg', fileName: 'v.ogg' }),
    ])
    expect(deps.whatsapp.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+1234',
      'have a listen',
    )
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2].kind).toBe('audio')
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2]).not.toHaveProperty('caption')
  })

  it('captions the first non-audio attachment when audio comes first', async () => {
    await stubSend('see the photo', [
      attachment({ id: 'att1', fileType: 'AUDIO', mimeType: 'audio/ogg' }),
      attachment({ id: 'att2' }),
    ])
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2].caption).toBeUndefined()
    expect(deps.whatsapp.sendMedia.mock.calls[1]![2].caption).toBe('see the photo')
  })

  it('passes bytes through when storage has no publicly fetchable URL', async () => {
    deps.attachments.resolveOutboundMedia.mockResolvedValue({
      kind: 'bytes',
      buffer: Buffer.from('png-bytes'),
      mimeType: 'image/png',
      fileName: 'photo.png',
    })
    await stubSend('', [attachment()])
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2].source).toEqual({
      buffer: Buffer.from('png-bytes'),
      mimeType: 'image/png',
      fileName: 'photo.png',
    })
  })

  it('downgrades an attachment Meta cannot take as rich media', async () => {
    await stubSend('', [
      attachment({ fileType: 'IMAGE', mimeType: 'image/svg+xml', fileName: 'd.svg' }),
    ])
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2]).toMatchObject({
      kind: 'document',
      fileName: 'd.svg',
    })
  })

  it('omits fileName when the attachment has none', async () => {
    await stubSend('', [attachment({ fileName: null })])
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2]).not.toHaveProperty('fileName')
  })

  it('sends nothing for a private message carrying attachments', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.attachments.attachToMessage.mockResolvedValue([attachment()])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: ['att1'],
    })
    expect(deps.whatsapp.sendMedia).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('sends no media for a non-WhatsApp inbox', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WEB_WIDGET',
    })
    deps.attachments.attachToMessage.mockResolvedValue([attachment()])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: ['att1'],
    })
    expect(deps.whatsapp.sendMedia).not.toHaveBeenCalled()
    expect(deps.attachments.resolveOutboundMedia).not.toHaveBeenCalled()
  })

  it('addresses a BSUID-only contact', async () => {
    deps.whatsapp.recipientForConversation.mockResolvedValue('BR.13491208655302741918')
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: null })
    deps.attachments.attachToMessage.mockResolvedValue([attachment()])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: ['att1'],
    })
    expect(deps.whatsapp.sendMedia.mock.calls[0]![1]).toBe('BR.13491208655302741918')
  })

  it('logs a media failure without failing the send', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.whatsapp.sendMedia.mockRejectedValue(new Error('media too large'))
    await expect(stubSend('', [attachment()])).resolves.toBeDefined()
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('treats a null persisted content as empty rather than crashing', async () => {
    // Message.content is nullable in the schema, so the push has to cope with
    // a row that came back with no content at all.
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: null,
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.inbox.findUnique.mockResolvedValue({
      id: 'inb1',
      channelType: 'WHATSAPP',
    })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+1234' })
    deps.attachments.attachToMessage.mockResolvedValue([attachment()])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '',
      contentType: 'TEXT',
      isPrivate: false,
      attachmentIds: ['att1'],
    })
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2]).not.toHaveProperty('caption')
  })

  it('names an unnamed oversized attachment by id in the failure', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.update.mockResolvedValue({ id: 'm1', status: 'FAILED' })
    await stubSend('', [
      attachment({ fileName: null, fileSize: 200 * 1024 * 1024, fileType: 'FILE' }),
    ])
    expect(logSpy.mock.calls[0]!.join(' ')).toMatch(/attachment att1 is \d+ bytes/)
    logSpy.mockRestore()
  })

  it('sends an oversized photo as a document instead of dropping it', async () => {
    await stubSend('', [attachment({ fileSize: 6 * 1024 * 1024 })])
    expect(deps.whatsapp.sendMedia.mock.calls[0]![2]).toMatchObject({
      kind: 'document',
      fileName: 'photo.png',
    })
  })

  it('marks the message FAILED when an attachment is too big for any type', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.message.update.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '',
      status: 'FAILED',
      isPrivate: false,
      createdAt: new Date(),
    })
    const out = await stubSend('', [
      attachment({ fileSize: 200 * 1024 * 1024, fileName: 'huge.zip', fileType: 'FILE' }),
    ])
    expect(deps.whatsapp.sendMedia).not.toHaveBeenCalled()
    expect(deps.prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'FAILED' },
    })
    // The caller gets the failed message back, not an optimistic SENT.
    expect(out.status).toBe('FAILED')
    expect(logSpy.mock.calls[0]!.join(' ')).toMatch(/huge\.zip .*bytes/)
    logSpy.mockRestore()
  })

  it('marks the message FAILED when the Cloud API rejects the send', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.whatsapp.sendMedia.mockRejectedValue(new Error('unsupported media'))
    deps.prisma.message.update.mockResolvedValue({ id: 'm1', status: 'FAILED' })
    const out = await stubSend('', [attachment()])
    expect(out.status).toBe('FAILED')
    logSpy.mockRestore()
  })

  it('keeps the message SENT when the push succeeds', async () => {
    const out = await stubSend('', [attachment()])
    expect(out.status).toBeUndefined() // message.create stub carries no status
    expect(deps.prisma.message.update).not.toHaveBeenCalled()
  })

  it('stamps the row with the wamids the push produced', async () => {
    await stubSend('', [attachment()])
    // Delivery receipts can only match a stamped message — an unstamped send
    // recreates the frozen-at-SENT blindness this feature removed.
    expect(deps.whatsapp.stampOutbound).toHaveBeenCalledWith('m1', ['wamid-media'])
  })

  it('survives a failed status write and still returns the message', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.whatsapp.sendMedia.mockRejectedValue(new Error('wa down'))
    deps.prisma.message.update.mockRejectedValue(new Error('db down'))
    await expect(stubSend('', [attachment()])).resolves.toMatchObject({ id: 'm1' })
    logSpy.mockRestore()
  })
})

// ─── createInboundMessage / ingestExternalInbound ──────────────────

describe('ConversationsService.createInboundMessage', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    mockTransactionPassthrough(deps.prisma)
  })

  it('403s for non-privileged users', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    await expect(
      svc.createInboundMessage('u1', 'acc1', 'conv1', {
        content: 'hi',
        contentType: 'TEXT',
      } as never),
    ).rejects.toThrow(/Administrator or Supervisor/)
  })

  it('forwards to ingestExternalInbound for privileged users', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    const out = await svc.createInboundMessage('u1', 'acc1', 'conv1', {
      content: 'hi',
      contentType: 'TEXT',
    } as never)
    expect(out.id).toBe('m1')
  })

  it('409s when the named conversation is closed, recording nothing', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ status: 'RESOLVED' })
    await expect(
      svc.createInboundMessage('u1', 'acc1', 'conv1', {
        content: 'hi',
        contentType: 'TEXT',
      } as never),
    ).rejects.toMatchObject({ response: { code: 'conversation_closed' } })
    expect(deps.prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv1', accountId: 'acc1' },
      select: { status: true },
    })
    expect(deps.prisma.message.create).not.toHaveBeenCalled()
  })

  it('leaves a missing conversation to be reported as not found', async () => {
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue(null)
    await expect(
      svc.createInboundMessage('u1', 'acc1', 'ghost', {
        content: 'hi',
        contentType: 'TEXT',
      } as never),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('ConversationsService.ingestExternalInbound', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    mockTransactionPassthrough(deps.prisma)
  })

  it('404s when conversation not found', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue(null)
    await expect(
      svc.ingestExternalInbound({
        accountId: 'acc1',
        conversationId: 'conv1',
        content: 'hi',
      }),
    ).rejects.toThrow(NotFoundException)
  })

  it('links the channel attachment inside the message transaction', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(1)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'Formulario.docx',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'Formulario.docx',
      contentType: 'FILE',
      attachmentIds: ['att1'],
    })
    // Scoped to this account's unlinked drafts, so a forged id can't steal
    // another account's file or re-home one already attached.
    expect(deps.prisma.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['att1'] }, accountId: 'acc1', messageId: null },
      data: { messageId: 'm1' },
    })
  })

  it("stamps a broadcast conversation billable on the contact's first reply", async () => {
    // A campaign to 10.000 numbers is 10.000 rows and zero billable
    // conversations until someone answers. This is the moment one of them
    // becomes a new conversation the customer is charged for (decision 16).
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      origin: 'BROADCAST',
      billableAt: null,
    })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'oi',
      isPrivate: false, createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'oi',
    })
    expect(deps.prisma.conversation.update.mock.calls[0]![0].data.billableAt).toBeInstanceOf(Date)
  })

  it('does not re-stamp a broadcast conversation that was already billed', async () => {
    // A second reply must not move the date into a later month and bill the
    // same conversation twice.
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      origin: 'BROADCAST',
      billableAt: new Date('2026-08-01T12:00:00Z'),
    })
    deps.prisma.message.count.mockResolvedValue(3)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'oi',
      isPrivate: false, createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'oi',
    })
    expect(deps.prisma.conversation.update.mock.calls[0]![0].data).not.toHaveProperty(
      'billableAt',
    )
  })

  it('never stamps a forwarded conversation, however many times the contact writes', async () => {
    // It was billed once already, as the conversation it was forwarded from.
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      origin: 'FORWARD',
      billableAt: null,
    })
    deps.prisma.message.count.mockResolvedValue(1)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'oi',
      isPrivate: false, createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'oi',
    })
    expect(deps.prisma.conversation.update.mock.calls[0]![0].data).not.toHaveProperty(
      'billableAt',
    )
  })

  it('first inbound message triggers isFirstMessage=true automation', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'hi',
    })
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'MESSAGE_CREATED',
        isFirstMessage: true,
      }),
    )
    expect(deps.orchestrator.handleInbound).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })
    // A brand-new conversation is distributed once the bot had its turn.
    expect(deps.assignment.route).toHaveBeenCalledWith('conv1', 'conversation_created')
    expect(deps.assignment.route.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.orchestrator.handleInbound.mock.invocationCallOrder[0]!,
    )
  })

  it('when a flow handles the turn, the AI orchestrator is skipped', async () => {
    const flowRunner = makeFlowRunner()
    flowRunner.handleInbound.mockResolvedValue(true) // flow owns the turn
    const made = makeService({ flowRunner })
    mockTransactionPassthrough(made.deps.prisma)
    made.deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    made.deps.prisma.message.count.mockResolvedValue(0)
    made.deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'hi', isPrivate: false, createdAt: new Date(),
    })
    made.deps.prisma.conversation.update.mockResolvedValue({})
    made.deps.prisma.contact.update.mockResolvedValue({})

    await made.svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'A',
      contentAttributes: { interactiveReplyId: 'edge_7' },
    })

    // flow runner saw the selected option id...
    expect(made.deps.flowRunner.handleInbound).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'A',
      interactiveReplyId: 'edge_7',
    })
    // ...and the AI agent did NOT run.
    expect(made.deps.orchestrator.handleInbound).not.toHaveBeenCalled()
  })

  it.each([
    ['Error', new Error('flow boom')],
    ['non-Error', 'flow boom string'],
  ])('a flow-runner %s rejection is swallowed and the AI agent still runs', async (_label, rejection) => {
    const flowRunner = makeFlowRunner()
    flowRunner.handleInbound.mockRejectedValue(rejection)
    const made = makeService({ flowRunner })
    mockTransactionPassthrough(made.deps.prisma)
    made.deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    made.deps.prisma.message.count.mockResolvedValue(0)
    made.deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'hi', isPrivate: false, createdAt: new Date(),
    })
    made.deps.prisma.conversation.update.mockResolvedValue({})
    made.deps.prisma.contact.update.mockResolvedValue({})

    await made.svc.ingestExternalInbound({ accountId: 'acc1', conversationId: 'conv1', content: 'hi' })
    // error swallowed → flowHandled stays false → orchestrator runs
    expect(made.deps.orchestrator.handleInbound).toHaveBeenCalled()
  })

  it('subsequent inbound flips isFirstMessage to false', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(3)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'follow up',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'follow up',
    })
    expect(deps.automation.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ isFirstMessage: false }),
    )
  })

  it('reopens RESOLVED conversation', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      resolvedAt: new Date(),
    })
    deps.prisma.message.count.mockResolvedValue(2)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'still here',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'still here',
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.status).toBe('OPEN')
    expect(updateData.reopenedAt).toBeInstanceOf(Date)
    expect(updateData.resolvedAt).toBeNull()
    expect(deps.assignment.route).toHaveBeenCalledWith('conv1', 'conversation_reopened')
  })

  it('does not route a later message of an ongoing conversation', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(3)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'more',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'more',
    })
    expect(deps.assignment.route).not.toHaveBeenCalled()
  })

  it('does NOT reopen non-RESOLVED conversation', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'hi',
    })
    const updateData = deps.prisma.conversation.update.mock.calls[0]![0].data
    expect(updateData.status).toBeUndefined()
  })

  it('logs orchestrator errors but does not propagate', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    deps.orchestrator.handleInbound.mockRejectedValue(new Error('ai down'))
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'hi',
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('logs orchestrator non-Error rejections', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    deps.orchestrator.handleInbound.mockRejectedValue('a string error')
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'hi',
    })
    expect(logSpy).toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('uses default contentType=TEXT and {} for contentAttributes', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'hi',
    })
    const data = deps.prisma.message.create.mock.calls[0]![0].data
    expect(data.contentType).toBe('TEXT')
    expect(data.contentAttributes).toEqual({})
  })

  it('respects explicit contentType + contentAttributes + externalSourceId + inReplyToId', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'img',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    await svc.ingestExternalInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      content: 'img',
      contentType: 'IMAGE',
      contentAttributes: { url: 'https://x.test/y.png' },
      externalSourceId: 'wamid:abc',
      inReplyToId: 'm-parent',
    })
    const data = deps.prisma.message.create.mock.calls[0]![0].data
    expect(data.contentType).toBe('IMAGE')
    expect(data.contentAttributes).toEqual({ url: 'https://x.test/y.png' })
    expect(data.externalSourceId).toBe('wamid:abc')
    expect(data.inReplyToId).toBe('m-parent')
  })

  it('swallows webhook dispatch errors on inbound', async () => {
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.message.count.mockResolvedValue(0)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'CONTACT',
      content: 'hi',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.contact.update.mockResolvedValue({})
    deps.webhooks.dispatch.mockRejectedValue(new Error('queue down'))
    await expect(
      svc.ingestExternalInbound({
        accountId: 'acc1',
        conversationId: 'conv1',
        content: 'hi',
      }),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })
})

// ─── DTO mappers ────────────────────────────────────────────────────

describe('ConversationsService DTOs', () => {
  let svc: ConversationsService
  let deps: Deps

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
  })

  it('toSummaryDTO emits ISO timestamps + null handling for nulls', () => {
    const dto = svc.toSummaryDTO({
      ...SAMPLE_CONVERSATION,
      agentLastSeenAt: null,
      contactLastSeenAt: null,
      firstReplyAt: null,
      resolvedAt: null,
      reopenedAt: null,
    } as never)
    expect(dto.id).toBe('conv1')
    expect(dto.agentLastSeenAt).toBeNull()
    expect(dto.contactLastSeenAt).toBeNull()
    expect(dto.firstReplyAt).toBeNull()
    expect(dto.resolvedAt).toBeNull()
    expect(dto.reopenedAt).toBeNull()
    expect(dto.contact).toBeNull()
    expect(dto.inbox).toBeNull()
    expect(dto.lastMessage).toBeNull()
    expect(dto.lastActivityAt).toBe(SAMPLE_CONVERSATION.updatedAt.toISOString())
    expect(dto.labels).toEqual([])
  })

  it('toSummaryDTO emits hydrated contact/inbox/lastMessage/labels with timestamps', () => {
    const date = new Date('2026-05-03T00:00:00Z')
    const dto = svc.toSummaryDTO({
      ...SAMPLE_CONVERSATION,
      agentLastSeenAt: date,
      contactLastSeenAt: date,
      firstReplyAt: date,
      resolvedAt: date,
      reopenedAt: date,
      contact: {
        id: 'cnt1',
        name: 'Alice',
        email: 'a@b.com',
        phoneNumber: '+1',
        customAttributes: { tier: 'gold' },
      },
      inbox: {
        id: 'inb1',
        name: 'Web',
        channelType: 'WEB_WIDGET',
        slaPolicy: null,
      },
      messages: [
        {
          content: 'last',
          senderType: 'CONTACT',
          isPrivate: false,
          createdAt: date,
        },
      ],
      conversationLabels: [
        { label: { id: 'l1', title: 'urgent', color: '#f00' } },
      ],
    } as never)
    expect(dto.agentLastSeenAt).toBe(date.toISOString())
    expect(dto.contact?.name).toBe('Alice')
    expect(dto.inbox?.name).toBe('Web')
    expect(dto.lastMessage?.content).toBe('last')
    expect(dto.lastActivityAt).toBe(date.toISOString())
    expect(dto.labels).toEqual([
      { id: 'l1', title: 'urgent', color: '#f00' },
    ])
    expect(deps.sla.computeStatus).toHaveBeenCalled()
  })

  it('toSummaryDTO handles missing contact fields with null fallbacks', () => {
    const dto = svc.toSummaryDTO({
      ...SAMPLE_CONVERSATION,
      contact: {
        id: 'cnt1',
        name: null,
        email: null,
        phoneNumber: null,
        customAttributes: undefined,
      },
    } as never)
    expect(dto.contact).toEqual({
      id: 'cnt1',
      name: null,
      email: null,
      phoneNumber: null,
      customAttributes: undefined,
    })
  })

  it('toSummaryDTO returns lastActivityAt as ISO string when lastMessage has Date createdAt', () => {
    // Exercise the truthy branch of `lastActivity instanceof Date` via the
    // hydrated lastMessage path (the lastMessage block calls .toISOString
    // itself, so this also locks in the happy path of the branch).
    const date = new Date('2026-05-03T00:00:00Z')
    const dto = svc.toSummaryDTO({
      ...SAMPLE_CONVERSATION,
      messages: [
        {
          content: 'x',
          senderType: 'CONTACT',
          isPrivate: false,
          createdAt: date,
        },
      ],
    } as never)
    expect(dto.lastActivityAt).toBe('2026-05-03T00:00:00.000Z')
  })

  it('toSummaryDTO falls back to {} when customAttributes is missing', () => {
    const dto = svc.toSummaryDTO({
      ...SAMPLE_CONVERSATION,
      customAttributes: null,
    } as never)
    expect(dto.customAttributes).toEqual({})
  })

  it('toDetailDTO embeds participants + forwardedFrom + sets messageCount', () => {
    const dto = svc.toDetailDTO(
      {
        ...SAMPLE_CONVERSATION,
        contact: {
          id: 'c',
          name: 'X',
          email: null,
          phoneNumber: null,
          identifier: 'wa:1',
          blockedAt: new Date('2026-05-05T00:00:00Z'),
          customAttributes: { tier: 'vip' },
        },
        inbox: { id: 'i', name: 'I', channelType: 'WEB_WIDGET', slaPolicy: null },
        assignee: { id: 'u', email: 'u@e', fullName: 'U' },
        participants: [
          {
            id: 'p1',
            userId: 'u1',
            createdAt: new Date('2026-05-01T00:00:00Z'),
            user: { id: 'u1', email: 'u1@e', fullName: 'One' },
          },
        ],
      } as never,
      3,
      new Date('2026-05-04T00:00:00Z'),
      { id: 'src', displayId: 9 },
    )
    expect(dto.assignee).toEqual({ id: 'u', email: 'u@e', fullName: 'U' })
    expect(dto.contact.identifier).toBe('wa:1')
    expect(dto.contact.blockedAt).toBe('2026-05-05T00:00:00.000Z')
    expect(dto.contact.customAttributes).toEqual({ tier: 'vip' })
    expect(dto.participants).toHaveLength(1)
    expect(dto.participants[0].user.fullName).toBe('One')
    expect(dto.messageCount).toBe(3)
    expect(dto.lastMessageAt).toBe('2026-05-04T00:00:00.000Z')
    expect(dto.forwardedFrom).toEqual({ id: 'src', displayId: 9 })
  })

  it('toDetailDTO handles null assignee + null lastMessageAt + null forwardedFrom', () => {
    const dto = svc.toDetailDTO(
      {
        ...SAMPLE_CONVERSATION,
        contact: { id: 'c', name: null, email: null, phoneNumber: null },
        inbox: { id: 'i', name: 'I', channelType: 'WEB_WIDGET', slaPolicy: null },
        assignee: null,
        participants: [],
      } as never,
      0,
      null,
      null,
    )
    expect(dto.assignee).toBeNull()
    expect(dto.lastMessageAt).toBeNull()
    expect(dto.forwardedFrom).toBeNull()
    expect(dto.participants).toEqual([])
  })

  it('toMessageDTO emits attachments and ISO timestamps', () => {
    const dto = svc.toMessageDTO({
      id: 'm1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      accountId: 'acc1',
      senderType: 'USER',
      senderUserId: 'u1',
      senderAgentBotId: null,
      senderContactId: null,
      content: 'hello',
      contentType: 'TEXT',
      contentAttributes: { mark: 1 },
      status: 'SENT',
      isPrivate: false,
      externalSourceId: null,
      inReplyToId: null,
      attachments: [
        {
          id: 'a1',
          fileType: 'IMAGE',
          fileUrl: 'https://x',
          fileName: 'x.png',
          fileSize: 100,
          mimeType: 'image/png',
        },
      ],
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-05-02T00:00:00Z'),
    } as never)
    expect(dto.createdAt).toBe('2026-05-01T00:00:00.000Z')
    expect(dto.attachments).toHaveLength(1)
    expect(dto.attachments[0].id).toBe('a1')
    expect(dto.contentAttributes).toEqual({ mark: 1 })
  })

  it('toMessageDTO falls back when contentAttributes is null and attachments missing', () => {
    const dto = svc.toMessageDTO({
      id: 'm1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      accountId: 'acc1',
      senderType: 'USER',
      senderUserId: null,
      senderAgentBotId: null,
      senderContactId: null,
      content: 'hi',
      contentType: 'TEXT',
      contentAttributes: null,
      status: 'SENT',
      isPrivate: false,
      externalSourceId: null,
      inReplyToId: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      updatedAt: new Date('2026-05-01T00:00:00Z'),
    } as never)
    expect(dto.contentAttributes).toEqual({})
    expect(dto.attachments).toEqual([])
  })

  it('toParticipantDTO maps fields', () => {
    const dto = svc.toParticipantDTO({
      id: 'p1',
      userId: 'u1',
      conversationId: 'conv1',
      createdAt: new Date('2026-05-01T00:00:00Z'),
      user: {
        id: 'u1',
        email: 'u1@e.test',
        fullName: 'Person',
      },
    } as never)
    expect(dto.id).toBe('p1')
    expect(dto.userId).toBe('u1')
    expect(dto.user.email).toBe('u1@e.test')
    expect(dto.createdAt).toBe('2026-05-01T00:00:00.000Z')
  })
})

// ─── parseMentionUsernames (via resolveMentionTargets) ──────────────

describe('ConversationsService — mention parsing edge cases', () => {
  let deps: Deps
  let svc: ConversationsService

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    mockTransactionPassthrough(deps.prisma)
  })

  it('matches multiple mentions, deduplicates, lowercases', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '@Alice and @ALICE and @bob.smith',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-alice', email: 'alice@e.com' } },
      { user: { id: 'u-bob', email: 'bob.smith@e.com' } },
      { user: { id: 'u-carl', email: 'carl@e.com' } }, // not mentioned
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '@Alice and @ALICE and @bob.smith',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    const call = deps.notifications.createMentions.mock.calls[0]![0]
    expect(call.targetUserIds.sort()).toEqual(['u-alice', 'u-bob'])
  })

  it('does not match email-like patterns where @ is preceded by non-whitespace', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'reach alice@example.com please',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: 'reach alice@example.com please',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).not.toHaveBeenCalled()
    // No member lookup either, since usernames returned [].
    expect(deps.prisma.accountMember.findMany).not.toHaveBeenCalled()
  })

  it('matches mention at start of content', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '@alice please review',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-alice', email: 'alice@e.com' } },
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '@alice please review',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).toHaveBeenCalled()
  })

  it('ignores members whose email local-part has no match', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '@alice',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-bob', email: 'bob@e.com' } }, // not matching @alice
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '@alice',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).not.toHaveBeenCalled()
  })

  it('handles member with empty email local-part (defensive)', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '@alice',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    // Bizarre member entry — email without local part. Tests the
    // `m.user.email.split('@')[0] ?? ''` fallback.
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-x', email: '@nodomain.com' } },
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '@alice',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).not.toHaveBeenCalled()
  })

  it('matches a username with trailing dot or hyphen via local-part chars', async () => {
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: '@alice.smith hi',
      isPrivate: true,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.prisma.accountMember.findMany.mockResolvedValue([
      { user: { id: 'u-alice', email: 'alice.smith@e.com' } },
    ])
    await svc.sendAgentMessage('u1', 'acc1', 'conv1', {
      content: '@alice.smith hi',
      contentType: 'TEXT',
      isPrivate: true,
      attachmentIds: [],
    })
    expect(deps.notifications.createMentions).toHaveBeenCalled()
  })
})

// ─── initialControlMode ─────────────────────────────────────────────

describe('initialControlMode', () => {
  it('returns BOT when an agent bot is set and autoreply is AUTO_SAFE', () => {
    expect(initialControlMode({ agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_SAFE', flowMode: 'OFF' })).toBe('BOT')
  })

  it('returns BOT when an agent bot is set and autoreply is AUTO_FULL', () => {
    expect(initialControlMode({ agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_FULL', flowMode: 'OFF' })).toBe('BOT')
  })

  it('returns HUMAN in DRAFT mode even with an agent bot (bot only suggests)', () => {
    expect(initialControlMode({ agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT', flowMode: 'OFF' })).toBe('HUMAN')
  })

  it('returns HUMAN when no agent bot is configured', () => {
    expect(initialControlMode({ agentBotId: null, aiAutoreplyMode: 'AUTO_FULL', flowMode: 'OFF' })).toBe('HUMAN')
  })

  it('returns BOT when a flow drives the inbox (STRICT/GUIDED), even with no AI bot', () => {
    expect(initialControlMode({ agentBotId: null, aiAutoreplyMode: 'DRAFT', flowMode: 'STRICT' })).toBe('BOT')
    expect(initialControlMode({ agentBotId: null, aiAutoreplyMode: 'DRAFT', flowMode: 'GUIDED' })).toBe('BOT')
  })
})

// ─── renderTemplateBody ──────────────────────────────────────────────

describe('renderTemplateBody', () => {
  it('substitutes 1-indexed {{n}} placeholders', () => {
    expect(renderTemplateBody('Olá {{1}}, em {{2}}.', ['Ana', '10h'])).toBe(
      'Olá Ana, em 10h.',
    )
  })
  it('leaves unmatched placeholders untouched', () => {
    expect(renderTemplateBody('Hi {{1}} {{2}}', ['X'])).toBe('Hi X {{2}}')
  })
  it('returns the body unchanged when there are no placeholders', () => {
    expect(renderTemplateBody('plain text', ['ignored'])).toBe('plain text')
  })
})

// ─── sendTemplateMessage ─────────────────────────────────────────────

describe('ConversationsService.sendTemplateMessage', () => {
  let deps: Deps
  let svc: ConversationsService

  const TEMPLATE = {
    id: 'tmpl1',
    inboxId: 'inb1',
    name: 'appt',
    language: 'pt_BR',
    status: 'APPROVED',
    body: 'Olá {{1}}, em {{2}}.',
    variableCount: 2,
  }

  beforeEach(() => {
    const made = makeService()
    svc = made.svc
    deps = made.deps
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: '+5511999' })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'WHATSAPP' })
    mockTransactionPassthrough(deps.prisma)
  })

  it('404s when the template is not found for this conversation', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(null)
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', { templateId: 'x', variables: [] }),
    ).rejects.toThrow(/Template not found/)
  })

  it('404s when the template belongs to a different inbox', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue({ ...TEMPLATE, inboxId: 'OTHER' })
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', { templateId: 'tmpl1', variables: ['a', 'b'] }),
    ).rejects.toThrow(/Template not found/)
  })

  it('400s when the template is not APPROVED', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue({ ...TEMPLATE, status: 'PENDING' })
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', { templateId: 'tmpl1', variables: ['a', 'b'] }),
    ).rejects.toThrow(/not approved/)
  })

  it('400s when the variable count does not match', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', { templateId: 'tmpl1', variables: ['only-one'] }),
    ).rejects.toThrow(/expects 2 variable/)
  })

  it('renders the body, records the message, flips control to HUMAN, and sends the template', async () => {
    deps.whatsapp.recipientForConversation.mockResolvedValue('+5511999')
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      controlMode: 'BOT',
    })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'Olá Ana, em 10h.',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    const out = await svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
      templateId: 'tmpl1',
      variables: ['Ana', '10h'],
    })
    expect(out.id).toBe('m1')
    // message content is the rendered body
    const createData = deps.prisma.message.create.mock.calls[0]![0].data
    expect(createData.content).toBe('Olá Ana, em 10h.')
    expect(createData.contentAttributes.whatsappTemplate).toEqual({
      name: 'appt',
      language: 'pt_BR',
      variables: ['Ana', '10h'],
    })
    // BOT → HUMAN takeover
    expect(deps.prisma.conversation.update.mock.calls[0]![0].data.controlMode).toBe('HUMAN')
    // realtime + the Cloud API template send
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageCreated' }),
    )
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      'inb1',
      '+5511999',
      'appt',
      'pt_BR',
      ['Ana', '10h'],
    )
  })

  it('falls back to the BSUID recipient when the contact has no phone (Meta 2026)', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.contact.findUnique.mockResolvedValue({ phoneNumber: null })
    deps.whatsapp.recipientForConversation.mockResolvedValue('BR.13491208655302741918')
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'Olá Ana, em 10h.',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
      templateId: 'tmpl1',
      variables: ['Ana', '10h'],
    })
    expect(deps.whatsapp.recipientForConversation).toHaveBeenCalledWith('conv1')
    expect(deps.whatsapp.sendTemplate).toHaveBeenCalledWith(
      'inb1',
      'BR.13491208655302741918',
      'appt',
      'pt_BR',
      ['Ana', '10h'],
    )
  })

  it('does NOT call the Cloud API for a non-WhatsApp inbox', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'WEB_WIDGET' })
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'Olá Ana, em 10h.',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    await svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
      templateId: 'tmpl1',
      variables: ['Ana', '10h'],
    })
    expect(deps.whatsapp.sendTemplate).not.toHaveBeenCalled()
  })

  it('swallows a Cloud API template-send failure', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'Olá Ana, em 10h.',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.whatsapp.sendTemplate.mockRejectedValue('a string') // non-Error → String(err)
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
        templateId: 'tmpl1',
        variables: ['Ana', '10h'],
      }),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })

  it('swallows an Error-typed Cloud API failure (err.message branch)', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.message.create.mockResolvedValue({
      id: 'm1',
      inboxId: 'inb1',
      senderType: 'USER',
      content: 'Olá Ana, em 10h.',
      isPrivate: false,
      createdAt: new Date(),
    })
    deps.prisma.conversation.update.mockResolvedValue({})
    deps.whatsapp.sendTemplate.mockRejectedValue(new Error('wa down'))
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
        templateId: 'tmpl1',
        variables: ['Ana', '10h'],
      }),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })

  it('refuses a template on a closed conversation, without sending anything', async () => {
    deps.prisma.whatsappTemplate.findUnique.mockResolvedValue(TEMPLATE)
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION,
      status: 'RESOLVED',
      firstReplyAt: new Date('2026-05-01T00:00:00Z'),
    })
    await expect(
      svc.sendTemplateMessage('u1', 'acc1', 'conv1', {
        templateId: 'tmpl1',
        variables: ['Ana', '10h'],
      }),
    ).rejects.toMatchObject({ response: { code: 'conversation_closed' } })
    expect(deps.prisma.message.create).not.toHaveBeenCalled()
    expect(deps.prisma.conversation.update).not.toHaveBeenCalled()
  })
})

describe('ConversationsService.discardAgentDraft', () => {
  it('deletes the draft and tells open threads to drop it', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1', accountId: 'acc1' })
    deps.prisma.message.findFirst.mockResolvedValue({ id: 'm-draft' })
    deps.prisma.message.delete.mockResolvedValue({})
    await svc.discardAgentDraft('u1', 'acc1', 'conv1', 'm-draft')
    expect(deps.prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm-draft' } })
    expect(deps.realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageDeleted', messageId: 'm-draft' }),
    )
  })

  it('only matches a private, pending AGENT_BOT message in this conversation', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1', accountId: 'acc1' })
    deps.prisma.message.findFirst.mockResolvedValue({ id: 'm-draft' })
    deps.prisma.message.delete.mockResolvedValue({})
    await svc.discardAgentDraft('u1', 'acc1', 'conv1', 'm-draft')
    expect(deps.prisma.message.findFirst.mock.calls[0][0].where).toEqual({
      id: 'm-draft',
      conversationId: 'conv1',
      accountId: 'acc1',
      senderType: 'AGENT_BOT',
      isPrivate: true,
      status: 'PENDING',
    })
  })

  it('refuses anything that is not a draft, and deletes nothing', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1', accountId: 'acc1' })
    // A customer message, a sent reply, another account's row — all land here.
    deps.prisma.message.findFirst.mockResolvedValue(null)
    await expect(
      svc.discardAgentDraft('u1', 'acc1', 'conv1', 'm-customer'),
    ).rejects.toThrow(NotFoundException)
    expect(deps.prisma.message.delete).not.toHaveBeenCalled()
  })
})

// ---------- retryMessage ----------
// The client supplies a message id, so the guard that only a FAILED, public,
// outbound message can be re-sent is the security boundary.

describe('ConversationsService.retryMessage', () => {
  const failed = {
    id: 'm-failed', inboxId: 'inb1', conversationId: 'conv1', accountId: 'acc1',
    senderType: 'USER', content: 'oi', isPrivate: false, status: 'FAILED',
    attachments: [], createdAt: new Date(),
  }

  function setup() {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv1', accountId: 'acc1', inboxId: 'inb1', contactId: 'ct1',
    })
    deps.prisma.inbox.findUnique.mockResolvedValue({ id: 'inb1', channelType: 'WHATSAPP' })
    return { svc, deps }
  }

  it('re-pushes to the channel and flips the row to SENT', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(failed)
    deps.prisma.message.update.mockResolvedValue({ ...failed, status: 'SENT' })
    const out = await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    expect(deps.whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+1234', 'oi')
    expect(deps.prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm-failed' }, data: { status: 'SENT' },
    })
    expect(out.status).toBe('SENT')
  })

  it('reuses the row instead of adding a copy to the thread', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(failed)
    deps.prisma.message.update.mockResolvedValue({ ...failed, status: 'SENT' })
    await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    expect(deps.prisma.message.create).not.toHaveBeenCalled()
  })

  it('only ever matches a FAILED, public, outbound message', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(failed)
    deps.prisma.message.update.mockResolvedValue({ ...failed, status: 'SENT' })
    await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    expect(deps.prisma.message.findFirst.mock.calls[0][0].where).toEqual({
      id: 'm-failed',
      conversationId: 'conv1',
      accountId: 'acc1',
      status: 'FAILED',
      isPrivate: false,
      senderType: { in: ['USER', 'AGENT_BOT'] },
    })
  })

  it('retries an attachment-only message, which has no text', async () => {
    const { svc, deps } = setup()
    const att = { id: 'att1', fileType: 'IMAGE', mimeType: 'image/png', fileSize: 10, fileName: 'a.png' }
    deps.prisma.message.findFirst.mockResolvedValue({
      ...failed, content: null, attachments: [att],
    })
    deps.prisma.message.update.mockResolvedValue({ ...failed, content: null, status: 'SENT' })
    deps.attachments.resolveOutboundMedia.mockResolvedValue({
      kind: 'link', url: 'https://cdn.example/a.png',
    })
    const out = await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    // No text to send, so only the media goes out — and no empty text bubble.
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(deps.whatsapp.sendMedia).toHaveBeenCalled()
    expect(out.status).toBe('SENT')
  })

  it('refuses a message that is not a failed outbound', async () => {
    const { svc, deps } = setup()
    // A customer's message, a delivered reply, a private note — all land here.
    deps.prisma.message.findFirst.mockResolvedValue(null)
    await expect(
      svc.retryMessage('u1', 'acc1', 'conv1', 'm-inbound'),
    ).rejects.toThrow(NotFoundException)
    expect(deps.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('stays FAILED when the channel rejects it again', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(failed)
    deps.whatsapp.sendOutbound.mockRejectedValue(new Error('Meta down'))
    const out = await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    // No optimistic tick: the agent must be able to try again.
    expect(out.status).toBe('FAILED')
    expect(deps.prisma.message.update).not.toHaveBeenCalled()
  })

  it('reports a non-Error channel throw as still failed', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(failed)
    deps.whatsapp.sendOutbound.mockRejectedValue('boom')
    const out = await svc.retryMessage('u1', 'acc1', 'conv1', 'm-failed')
    expect(out.status).toBe('FAILED')
  })
})

describe('pickPreviewMessage', () => {
  const real = { content: 'oi', contentAttributes: {} }
  const note = { content: 'Label X added by Ana', contentAttributes: { activity: { type: 'label' } } }

  it('skips activity notes in favour of the newest real message', () => {
    expect(pickPreviewMessage([note, real])).toBe(real)
  })

  it('falls back to the newest message when everything is an activity note', () => {
    const older = { content: 'Conversation resolved', contentAttributes: { activity: {} } }
    expect(pickPreviewMessage([note, older])).toBe(note)
  })

  // Conversation 8741: the AI draft hid the customer's "?" in the list.
  it('skips a private message (AI draft, internal note) in favour of what the customer saw', () => {
    const draft = { content: '[draft] Olá! Como posso ajudar?', contentAttributes: {}, isPrivate: true }
    const customer = { content: '?', contentAttributes: {}, isPrivate: false }
    expect(pickPreviewMessage([draft, note, customer])).toBe(customer)
  })

  it('shows a private message when the thread has nothing else but activity', () => {
    const internal = { content: 'liguei para o cliente', contentAttributes: {}, isPrivate: true }
    expect(pickPreviewMessage([note, internal])).toBe(internal)
  })

  it('handles empty, missing, and attribute-less messages', () => {
    expect(pickPreviewMessage([])).toBeUndefined()
    expect(pickPreviewMessage(undefined)).toBeUndefined()
    const bare = { content: 'hi' }
    expect(pickPreviewMessage([bare])).toBe(bare)
    const nullAttrs = { content: 'hi', contentAttributes: null }
    expect(pickPreviewMessage([nullAttrs])).toBe(nullAttrs)
  })
})

// The customer wrote, the bot had the conversation, and nothing came back.
// Conversation 8739 (2026-09-23) sat exactly like that for seven hours.
describe('ConversationsService — a silent bot turn is handed to a human', () => {
  function bot(inbox: Record<string, unknown>) {
    return { controlMode: 'BOT', inbox }
  }
  const WITH_FLOW = { flowMode: 'GUIDED', defaultFlowId: 'f1', agentBotId: null }

  function arrange(over: { conv?: unknown; answered?: number } = {}) {
    const made = makeService()
    mockTransactionPassthrough(made.deps.prisma)
    made.deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION })
    made.deps.prisma.message.create.mockResolvedValue({
      id: 'm1', inboxId: 'inb1', senderType: 'CONTACT', content: 'oi',
      isPrivate: false, createdAt: new Date(),
    })
    made.deps.prisma.conversation.update.mockResolvedValue({})
    made.deps.prisma.contact.update.mockResolvedValue({})
    made.deps.prisma.conversation.findUnique.mockResolvedValue(
      'conv' in over ? over.conv : bot(WITH_FLOW),
    )
    // `count` also answers the isFirstMessage probe; both want 0 here unless
    // the case is specifically "the bot did reply".
    made.deps.prisma.message.count.mockResolvedValue(over.answered ?? 0)
    return made
  }

  const inbound = { accountId: 'acc1', conversationId: 'conv1', content: 'oi' }

  it('hands over when the bot produced nothing', async () => {
    const made = arrange()
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'conv1',
    })
  })

  it('stays out of the way when the bot did answer', async () => {
    const made = arrange({ answered: 1 })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).not.toHaveBeenCalled()
  })

  it('stays out of the way once a human is already in charge', async () => {
    const made = arrange({ conv: { controlMode: 'HUMAN', inbox: WITH_FLOW } })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).not.toHaveBeenCalled()
  })

  it('stays out of the way when the conversation is gone', async () => {
    const made = arrange({ conv: null })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).not.toHaveBeenCalled()
  })

  it('an inbox with an AI agent but no flow still counts as having a bot', async () => {
    const made = arrange({
      conv: bot({ flowMode: 'OFF', defaultFlowId: null, agentBotId: 'bot1' }),
    })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).toHaveBeenCalled()
  })

  it('an inbox with a flow switched off and no agent is a plain human queue', async () => {
    const made = arrange({
      conv: bot({ flowMode: 'OFF', defaultFlowId: 'f1', agentBotId: null }),
    })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).not.toHaveBeenCalled()
  })

  it('an inbox in flow mode but with no flow attached is a plain human queue', async () => {
    const made = arrange({
      conv: bot({ flowMode: 'GUIDED', defaultFlowId: null, agentBotId: null }),
    })
    await made.svc.ingestExternalInbound(inbound)
    expect(made.deps.orchestrator.handOffSilentTurn).not.toHaveBeenCalled()
  })

  it.each([
    ['Error', new Error('route boom')],
    ['non-Error', 'route boom string'],
  ])('a %s from the handoff never breaks ingestion', async (_label, rejection) => {
    const made = arrange()
    made.deps.orchestrator.handOffSilentTurn.mockRejectedValue(rejection)
    await expect(made.svc.ingestExternalInbound(inbound)).resolves.toBeDefined()
  })
})


describe('ConversationsService.protocolHistory', () => {
  it('joins every conversation of the protocol the member can see, public messages only', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      ...SAMPLE_CONVERSATION, id: 'cv-wa', protocol: '20261016-000123', contactId: 'ct1',
    })
    deps.prisma.conversation.findMany.mockResolvedValue([
      { id: 'cv-web', displayId: 7, status: 'RESOLVED', createdAt: new Date('2026-10-16T10:00:00Z'), inbox: { name: 'Site', channelType: 'WEB_WIDGET' } },
      { id: 'cv-wa', displayId: 8, status: 'OPEN', createdAt: new Date('2026-10-16T11:00:00Z'), inbox: { name: 'WhatsApp', channelType: 'WHATSAPP' } },
    ])
    deps.prisma.message.findMany.mockResolvedValue([
      { id: 'm1', conversationId: 'cv-web', senderType: 'CONTACT', content: 'Quero a 2ª via', contentType: 'TEXT', createdAt: new Date('2026-10-16T10:00:01Z'), contentAttributes: {} },
      { id: 'm2', conversationId: 'cv-web', senderType: 'SYSTEM', content: 'resolved by Ana', contentType: 'TEXT', createdAt: new Date('2026-10-16T10:05:00Z'), contentAttributes: { activity: { type: 'status' } } },
      { id: 'm3', conversationId: 'cv-wa', senderType: 'CONTACT', content: 'Voltei', contentType: 'TEXT', createdAt: new Date('2026-10-16T11:00:01Z'), contentAttributes: null },
    ])
    const out = await svc.protocolHistory('u1', 'acc1', 'cv-wa')
    expect(out.protocol).toBe('20261016-000123')
    expect(out.conversations.map((c) => [c.displayId, c.channelType])).toEqual([[7, 'WEB_WIDGET'], [8, 'WHATSAPP']])
    expect(out.messages.map((m) => [m.id, m.channelType])).toEqual([['m1', 'WEB_WIDGET'], ['m3', 'WHATSAPP']])
    const where = deps.prisma.conversation.findMany.mock.calls[0]![0].where
    expect(where.AND).toEqual([{ protocol: '20261016-000123', contactId: 'ct1' }])
    expect(deps.prisma.message.findMany.mock.calls[0]![0].where).toEqual({
      conversationId: { in: ['cv-web', 'cv-wa'] },
      isPrivate: false,
    })
  })

  it('falls back to the conversation alone when it has no protocol yet', async () => {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('ADMINISTRATOR'))
    deps.prisma.conversation.findFirst.mockResolvedValue({ ...SAMPLE_CONVERSATION, protocol: null })
    ;(deps.prisma.inbox as unknown as { findUniqueOrThrow: ReturnType<typeof vi.fn> }).findUniqueOrThrow = vi
      .fn()
      .mockResolvedValue({ name: 'Site', channelType: 'WEB_WIDGET' })
    deps.prisma.message.findMany.mockResolvedValue([])
    const out = await svc.protocolHistory('u1', 'acc1', 'conv1')
    expect(out).toMatchObject({ protocol: null, conversations: [{ id: 'conv1', inboxName: 'Site' }], messages: [] })
    expect(deps.prisma.conversation.findMany).not.toHaveBeenCalled()
  })
})

// ---------- reactToMessage ----------
describe('ConversationsService.reactToMessage', () => {
  const contactMsg = {
    id: 'm-in', conversationId: 'conv1', accountId: 'acc1', inboxId: 'inb1',
    isPrivate: false, externalSourceId: 'wamid.in1', contentAttributes: {},
  }

  function setup(conv: Record<string, unknown> = {}) {
    const { svc, deps } = makeService()
    deps.prisma.accountMember.findUnique.mockResolvedValue(priv('AGENT'))
    deps.prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv1', accountId: 'acc1', inboxId: 'inb1', status: 'OPEN', ...conv,
    })
    return { svc, deps }
  }

  it('sends the reaction to WhatsApp and records it as ours', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(contactMsg)
    await svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '❤️')
    expect(deps.prisma.message.findFirst).toHaveBeenCalledWith({
      where: { id: 'm-in', conversationId: 'conv1', accountId: 'acc1', isPrivate: false },
    })
    expect(deps.whatsapp.sendReaction).toHaveBeenCalledWith('inb1', '+1234', 'wamid.in1', '❤️')
    expect(deps.whatsapp.setReaction).toHaveBeenCalledWith(
      contactMsg,
      'business',
      '❤️',
      expect.objectContaining({ userId: 'u1', at: expect.any(String) }),
    )
  })

  it('refuses in a closed conversation', async () => {
    const { svc, deps } = setup({ status: 'RESOLVED' })
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toThrow(
      ConflictException,
    )
    expect(deps.whatsapp.sendReaction).not.toHaveBeenCalled()
  })

  it('refuses a message that never went through WhatsApp, or is not here', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValueOnce({ ...contactMsg, externalSourceId: null })
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toThrow(
      NotFoundException,
    )
    deps.prisma.message.findFirst.mockResolvedValueOnce(null)
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-x', '👍')).rejects.toThrow(
      NotFoundException,
    )
    expect(deps.whatsapp.sendReaction).not.toHaveBeenCalled()
  })

  it('refuses when the conversation has no WhatsApp recipient', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(contactMsg)
    deps.whatsapp.recipientForConversation.mockResolvedValue(null)
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toThrow(
      BadRequestException,
    )
  })

  it('says WhatsApp refused, and records nothing', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(contactMsg)
    deps.whatsapp.sendReaction.mockRejectedValueOnce(new Error('WhatsApp reaction failed (400)'))
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toMatchObject({
      response: { code: 'reaction_failed', message: 'WhatsApp reaction failed (400)' },
    })
    deps.whatsapp.sendReaction.mockRejectedValueOnce('boom')
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toMatchObject({
      response: { code: 'reaction_failed', message: 'boom' },
    })
    expect(deps.whatsapp.setReaction).not.toHaveBeenCalled()
  })

  it('passes a missing-credentials error through as it is', async () => {
    const { svc, deps } = setup()
    deps.prisma.message.findFirst.mockResolvedValue(contactMsg)
    deps.whatsapp.sendReaction.mockRejectedValueOnce(new BadRequestException('missing credentials'))
    await expect(svc.reactToMessage('u1', 'acc1', 'conv1', 'm-in', '👍')).rejects.toThrow(
      'missing credentials',
    )
  })
})
