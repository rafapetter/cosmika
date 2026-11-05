import { randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decryptSecret,
  encryptSecretsIn,
  isEncryptedSecret,
} from '../../common/secret-crypto'

import { InboxesService } from './inboxes.service'

// ---------- Prisma mock factory ----------

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    inbox: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inboxMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    agentBot: { findUnique: vi.fn() },
    flow: { findUnique: vi.fn() },
    conversation: { count: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): InboxesService {
  return new InboxesService(prisma as never)
}

// ---------- fixtures ----------

const ADMIN = {
  id: 'm1',
  userId: 'u1',
  accountId: 'acc1',
  role: 'ADMINISTRATOR' as const,
  isActive: true,
}
const SUPERVISOR = { ...ADMIN, id: 'm2', role: 'SUPERVISOR' as const }
const AGENT = { ...ADMIN, id: 'm3', role: 'AGENT' as const }

const ACCOUNT = { id: 'acc1', slug: 'cosmobots' }

const NOW = new Date('2026-05-25T00:00:00.000Z')

function makeInbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inb1',
    accountId: 'acc1',
    name: 'Main',
    channelType: 'WEB_WIDGET',
    channelConfig: { websiteName: 'cosmobots.io', widgetHash: 'abcdef' },
    greetingEnabled: false,
    greetingMessage: null,
    outOfOfficeMessage: null,
    closingMessage: null,
    aiAutoreplyMode: 'DRAFT',
    autoResolveMinutes: 10080,
    agentBotId: null,
    csatEnabled: false,
    slaPolicyId: null,
    defaultFlowId: null,
    flowMode: 'OFF',
    deviationPolicy: 'answer_and_return',
    maxDeviations: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---------- getMembership (private, via list/etc) ----------

describe('InboxesService.list — membership gate', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 when user is not a member of the account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 when membership is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('admin sees all account inboxes', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const inboxes = [makeInbox(), makeInbox({ id: 'inb2' })]
    prisma.inbox.findMany.mockResolvedValue(inboxes)
    const out = await makeService(prisma).list('u1', 'acc1')
    expect(out).toBe(inboxes)
    expect(prisma.inbox.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('supervisor sees all account inboxes (mutator role)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPERVISOR)
    prisma.inbox.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1')
    expect(prisma.inbox.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('agent sees only inboxes they are a member of', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1')
    expect(prisma.inbox.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', members: { some: { userId: 'u1' } } },
      orderBy: { createdAt: 'asc' },
    })
  })
})

// ---------- getWithMembers ----------

describe('InboxesService.getWithMembers', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('404 when inbox does not exist', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).getWithMembers('u1', 'acc1', 'inb1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 when inbox belongs to a different account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox({ accountId: 'acc-OTHER' }))
    await expect(
      makeService(prisma).getWithMembers('u1', 'acc1', 'inb1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 for agent who is not a member of the inbox', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
    prisma.inboxMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).getWithMembers('u1', 'acc1', 'inb1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('returns inbox-with-members for admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const inboxBare = makeInbox()
    const inboxWith = { ...inboxBare, members: [] }
    // First findUnique: assertInboxVisible.  Second: full include.
    prisma.inbox.findUnique
      .mockResolvedValueOnce(inboxBare)
      .mockResolvedValueOnce(inboxWith)
    const out = await makeService(prisma).getWithMembers('u1', 'acc1', 'inb1')
    expect(out).toBe(inboxWith)
  })

  it('returns inbox-with-members for agent who IS a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const inboxBare = makeInbox()
    const inboxWith = { ...inboxBare, members: [{ id: 'im1', userId: 'u1' }] }
    prisma.inbox.findUnique
      .mockResolvedValueOnce(inboxBare)
      .mockResolvedValueOnce(inboxWith)
    prisma.inboxMember.findUnique.mockResolvedValue({ id: 'im1', userId: 'u1' })
    const out = await makeService(prisma).getWithMembers('u1', 'acc1', 'inb1')
    expect(out).toBe(inboxWith)
  })

  it('404 when the second findUnique (full include) returns null — defensive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique
      .mockResolvedValueOnce(makeInbox())
      .mockResolvedValueOnce(null)
    await expect(
      makeService(prisma).getWithMembers('u1', 'acc1', 'inb1'),
    ).rejects.toThrow(NotFoundException)
  })
})

// ---------- create — channel type branches ----------

describe('InboxesService.create — role + account guards', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 when caller is not a mutator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'API',
        channelConfig: {},
      } as never),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('404 when account row disappears mid-call', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'API',
        channelConfig: {},
      } as never),
    ).rejects.toThrow(NotFoundException)
  })
})

describe('InboxesService.create — WEB_WIDGET', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('adds widgetHash + persists fields with defaults applied', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })

    await makeService(prisma).create('u1', 'acc1', {
      name: 'Site Widget',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'cosmobots.io' },
    } as never)

    expect(captured!.accountId).toBe('acc1')
    expect(captured!.name).toBe('Site Widget')
    expect(captured!.channelType).toBe('WEB_WIDGET')
    const cfg = captured!.channelConfig as { widgetHash: string; websiteName: string }
    expect(cfg.websiteName).toBe('cosmobots.io')
    expect(cfg.widgetHash).toMatch(/^[a-f0-9]{32}$/) // 16 bytes hex
    // Defaults
    expect(captured!.greetingEnabled).toBe(false)
    expect(captured!.aiAutoreplyMode).toBe('DRAFT')
    expect(captured!.autoResolveMinutes).toBe(10080)
    expect(captured!.csatEnabled).toBe(false)
    // No agentBotId provided → no agentBotId key spread
    expect(captured!.agentBotId).toBeUndefined()
  })

  it('persists explicit greeting + csat + autoReply overrides', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })

    await makeService(prisma).create('u1', 'acc1', {
      name: 'X',
      channelType: 'WEB_WIDGET',
      channelConfig: { websiteName: 'x.com' },
      greetingEnabled: true,
      greetingMessage: 'hi',
      outOfOfficeMessage: 'closed',
      aiAutoreplyMode: 'AUTO_SAFE',
      autoResolveMinutes: 60,
      csatEnabled: true,
    } as never)

    expect(captured!.greetingEnabled).toBe(true)
    expect(captured!.greetingMessage).toBe('hi')
    expect(captured!.outOfOfficeMessage).toBe('closed')
    expect(captured!.aiAutoreplyMode).toBe('AUTO_SAFE')
    expect(captured!.autoResolveMinutes).toBe(60)
    expect(captured!.csatEnabled).toBe(true)
  })

  it('400s with structured issues when channelConfig is invalid Zod input', async () => {
    try {
      await makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'WEB_WIDGET',
        channelConfig: { websiteName: '' }, // min(1) violation
      } as never)
      throw new Error('expected BadRequestException')
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException)
      const body = (err as BadRequestException).getResponse() as {
        message: string
        issues: Array<{ path: string; message: string }>
      }
      expect(body.message).toBe('Invalid channel config')
      expect(body.issues.length).toBeGreaterThan(0)
      expect(body.issues[0]!.path).toBe('websiteName')
    }
  })
})

describe('InboxesService.create — EMAIL', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('generates a forwarding address when none provided', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Support Mail',
      channelType: 'EMAIL',
      channelConfig: {},
    } as never)
    const cfg = captured!.channelConfig as { forwardingAddress: string }
    expect(cfg.forwardingAddress).toMatch(
      /^inbox-cosmobots-[a-f0-9]{8}@cosmika\.app$/,
    )
  })

  it('keeps a caller-supplied forwarding address verbatim', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Support Mail',
      channelType: 'EMAIL',
      channelConfig: {
        forwardingAddress: 'custom@cosmika.app',
        replyToAddress: 'reply@x.com',
        signature: '-- cosmika',
      },
    } as never)
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg.forwardingAddress).toBe('custom@cosmika.app')
    expect(cfg.replyToAddress).toBe('reply@x.com')
    expect(cfg.signature).toBe('-- cosmika')
  })

  it('400s when replyToAddress is not an email', async () => {
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'EMAIL',
        channelConfig: { replyToAddress: 'not-an-email' },
      } as never),
    ).rejects.toThrow(BadRequestException)
  })
})

describe('InboxesService.create — WHATSAPP', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('persists all required WhatsApp credentials', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'WA Sales',
      channelType: 'WHATSAPP',
      channelConfig: {
        phoneNumberId: '111222333',
        businessAccountId: '444555666',
        accessToken: 'EAA-token-here-long',
        appSecret: 'meta-app-secret-xxxxx',
        webhookVerifyToken: 'verify-string',
      },
    } as never)
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg.phoneNumberId).toBe('111222333')
    expect(cfg.businessAccountId).toBe('444555666')
    expect(cfg.accessToken).toBe('EAA-token-here-long')
    expect(cfg.appSecret).toBe('meta-app-secret-xxxxx')
    expect(cfg.webhookVerifyToken).toBe('verify-string')
  })

  it('400s when phoneNumberId is missing', async () => {
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'WHATSAPP',
        channelConfig: {
          businessAccountId: '444555666',
        },
      } as never),
    ).rejects.toThrow(BadRequestException)
  })

  it('400s when businessAccountId is missing', async () => {
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'WHATSAPP',
        channelConfig: {
          phoneNumberId: '111',
        },
      } as never),
    ).rejects.toThrow(BadRequestException)
  })
})

describe('InboxesService.create — TELEGRAM', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('keeps only the token and generates the webhook secret', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Telegram',
      channelType: 'TELEGRAM',
      channelConfig: { botToken: ' 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_-12 ', extra: 'dropped' },
    } as never)
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(Object.keys(cfg).sort()).toEqual(['botToken', 'webhookSecret'])
    expect(cfg.botToken).toBe('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_-12')
    expect(cfg.webhookSecret).toMatch(/^[0-9a-f]{48}$/)
  })

  it('400s on something that is not a BotFather token', async () => {
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'TELEGRAM',
        channelConfig: { botToken: 'not-a-token' },
      } as never),
    ).rejects.toThrow(BadRequestException)
  })
})

describe('InboxesService.createMetaInbox', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('stores a Messenger inbox with the checked config', async () => {
    prisma.inbox.create.mockImplementation(async ({ data }) => ({ id: 'inb1', ...data }))
    await makeService(prisma).createMetaInbox('u1', 'acc1', {
      name: 'Messenger',
      channelType: 'FACEBOOK',
      channelConfig: { pageId: '111', pageAccessToken: 'EAAG-token', pageName: 'P' },
    })
    expect(prisma.inbox.create.mock.calls[0]![0].data).toEqual({
      accountId: 'acc1',
      name: 'Messenger',
      channelType: 'FACEBOOK',
      channelConfig: { pageId: '111', pageAccessToken: 'EAAG-token', pageName: 'P' },
      aiAutoreplyMode: 'DRAFT',
      autoResolveMinutes: 10080,
    })
  })

  it('needs an administrator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, role: 'AGENT' })
    await expect(
      makeService(prisma).createMetaInbox('u1', 'acc1', {
        name: 'X',
        channelType: 'INSTAGRAM',
        channelConfig: {},
      }),
    ).rejects.toThrow()
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })
})

describe('InboxesService.create — API channel', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('passes channelConfig through unchanged for API channel', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Programmatic',
      channelType: 'API',
      channelConfig: { webhookUrl: 'https://example.com/hook', anything: 'goes' },
    } as never)
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg).toEqual({ webhookUrl: 'https://example.com/hook', anything: 'goes' })
  })
})

// ---------- create — F7: agentBotId attach-at-create ----------

describe('InboxesService.create — F7: agentBotId attach-at-create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
  })

  it('attaches the bot when it exists and belongs to the same account', async () => {
    prisma.agentBot.findUnique.mockResolvedValue({ id: 'bot1', accountId: 'acc1' })
    let captured: Record<string, unknown> | null = null
    prisma.inbox.create.mockImplementation(async ({ data }) => {
      captured = data
      return { id: 'inb1', ...data }
    })

    await makeService(prisma).create('u1', 'acc1', {
      name: 'X',
      channelType: 'API',
      channelConfig: {},
      agentBotId: 'bot1',
    } as never)

    expect(captured!.agentBotId).toBe('bot1')
    expect(prisma.agentBot.findUnique).toHaveBeenCalledWith({
      where: { id: 'bot1' },
      select: { id: true, accountId: true },
    })
  })

  it('404 when the agent bot does not exist', async () => {
    prisma.agentBot.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'API',
        channelConfig: {},
        agentBotId: 'bot-bogus',
      } as never),
    ).rejects.toThrow('Agent bot not found')
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })

  it('404 when the agent bot belongs to a DIFFERENT account (IDOR guard)', async () => {
    prisma.agentBot.findUnique.mockResolvedValue({
      id: 'bot-other',
      accountId: 'acc-OTHER',
    })
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        name: 'X',
        channelType: 'API',
        channelConfig: {},
        agentBotId: 'bot-other',
      } as never),
    ).rejects.toThrow('Agent bot not found')
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })

  it('does NOT touch agentBot lookup when agentBotId is omitted', async () => {
    prisma.inbox.create.mockResolvedValue(makeInbox())
    await makeService(prisma).create('u1', 'acc1', {
      name: 'X',
      channelType: 'API',
      channelConfig: {},
    } as never)
    expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
  })

  it('does NOT touch agentBot lookup when agentBotId is explicitly null', async () => {
    prisma.inbox.create.mockResolvedValue(makeInbox())
    await makeService(prisma).create('u1', 'acc1', {
      name: 'X',
      channelType: 'API',
      channelConfig: {},
      agentBotId: null,
    } as never)
    expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
  })
})

// ---------- update ----------

describe('InboxesService.update — guards', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 when caller is not a mutator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { name: 'x' }),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('404 when inbox does not belong to the account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox({ accountId: 'acc-OTHER' }))
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { name: 'x' }),
    ).rejects.toThrow(NotFoundException)
  })
})

describe('InboxesService.update — scalar fields', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('omits keys that are not provided (sparse update)', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox(data)
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {})
    expect(captured).toEqual({})
  })

  it('updates every scalar field when all are provided', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox(data)
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      name: 'Renamed',
      greetingEnabled: true,
      greetingMessage: 'hello',
      outOfOfficeMessage: 'closed',
      aiAutoreplyMode: 'AUTO_FULL',
      autoResolveMinutes: 60,
      csatEnabled: true,
    })
    expect(captured).toEqual({
      name: 'Renamed',
      greetingEnabled: true,
      greetingMessage: 'hello',
      outOfOfficeMessage: 'closed',
      aiAutoreplyMode: 'AUTO_FULL',
      autoResolveMinutes: 60,
      csatEnabled: true,
    })
  })

  it('accepts null greetingMessage + outOfOfficeMessage (nullable)', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox(data)
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      greetingMessage: null,
      outOfOfficeMessage: null,
    })
    expect(captured).toEqual({ greetingMessage: null, outOfOfficeMessage: null })
  })

  it('closingMessage: trimmed text is stored, blank or null turns it off', async () => {
    const captured: Array<Record<string, unknown>> = []
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured.push(data)
      return makeInbox(data)
    })
    const svc = makeService(prisma)
    await svc.update('u1', 'acc1', 'inb1', { closingMessage: '  Obrigado, {{contact.first_name}}!  ' })
    await svc.update('u1', 'acc1', 'inb1', { closingMessage: '   ' })
    await svc.update('u1', 'acc1', 'inb1', { closingMessage: null })
    expect(captured.map((d) => d.closingMessage)).toEqual(['Obrigado, {{contact.first_name}}!', null, null])
  })
})

describe('InboxesService.update — slaPolicy connect/disconnect', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('disconnects slaPolicy when slaPolicyId is null', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { slaPolicyId: null })
    expect(captured!.slaPolicy).toEqual({ disconnect: true })
  })

  it('connects slaPolicy by id when slaPolicyId is a string', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { slaPolicyId: 'sla-1' })
    expect(captured!.slaPolicy).toEqual({ connect: { id: 'sla-1' } })
  })
})

describe('InboxesService.update — agentBot connect/disconnect', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('disconnects agentBot when agentBotId is null', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { agentBotId: null })
    expect(captured!.agentBot).toEqual({ disconnect: true })
    expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
  })

  it('connects agentBot by id when bot exists in the same account', async () => {
    prisma.agentBot.findUnique.mockResolvedValue({ id: 'bot1', accountId: 'acc1' })
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { agentBotId: 'bot1' })
    expect(captured!.agentBot).toEqual({ connect: { id: 'bot1' } })
  })

  it('404 when target bot does not exist', async () => {
    prisma.agentBot.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { agentBotId: 'bot-bogus' }),
    ).rejects.toThrow('Agent bot not found')
  })

  it('404 when target bot belongs to another account', async () => {
    prisma.agentBot.findUnique.mockResolvedValue({
      id: 'bot-other',
      accountId: 'acc-OTHER',
    })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { agentBotId: 'bot-other' }),
    ).rejects.toThrow('Agent bot not found')
  })
})

describe('InboxesService.update — flow config', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('passes flowMode / deviationPolicy / maxDeviations through', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      flowMode: 'GUIDED',
      deviationPolicy: 'answer_and_advance',
      maxDeviations: 5,
    })
    expect(captured!.flowMode).toBe('GUIDED')
    expect(captured!.deviationPolicy).toBe('answer_and_advance')
    expect(captured!.maxDeviations).toBe(5)
  })

  it('connects defaultFlow by id when the flow is in the account', async () => {
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1' })
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { defaultFlowId: 'f1' })
    expect(captured!.defaultFlow).toEqual({ connect: { id: 'f1' } })
  })

  it('disconnects defaultFlow when null (no flow lookup)', async () => {
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', { defaultFlowId: null })
    expect(captured!.defaultFlow).toEqual({ disconnect: true })
    expect(prisma.flow.findUnique).not.toHaveBeenCalled()
  })

  it('404 when the flow is missing or cross-account', async () => {
    prisma.flow.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { defaultFlowId: 'fX' }),
    ).rejects.toThrow('Flow not found')
    prisma.flow.findUnique.mockResolvedValue({ id: 'fX', accountId: 'other' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', { defaultFlowId: 'fX' }),
    ).rejects.toThrow('Flow not found')
  })
})

describe('InboxesService.update — channelConfig merge', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('a generic PATCH never rewrites a Telegram channel config', async () => {
    const stored = { botToken: 'T', webhookSecret: 'S', botUsername: 'support_bot' }
    prisma.inbox.findUnique.mockResolvedValue(makeInbox({ channelType: 'TELEGRAM', channelConfig: stored }))
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { botToken: 'plaintext-overwrite', webhookSecret: '' },
    })
    expect(captured!.channelConfig).toEqual(stored)
  })

  it('merges WEB_WIDGET incoming over existing + revalidates schema', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'WEB_WIDGET',
        channelConfig: {
          websiteName: 'old.com',
          widgetHash: 'h1',
          primaryColor: '#000000',
        },
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { websiteName: 'new.com' },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg.websiteName).toBe('new.com')
    expect(cfg.primaryColor).toBe('#000000') // merged from existing
  })

  it('400s when WEB_WIDGET merged result fails revalidation', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'WEB_WIDGET',
        channelConfig: { websiteName: 'old.com' },
      }),
    )
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', {
        channelConfig: { primaryColor: 'NOT-A-HEX-COLOR' },
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('merges EMAIL incoming over existing', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'EMAIL',
        channelConfig: {
          forwardingAddress: 'old@cosmika.app',
          signature: 'old sig',
        },
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { signature: 'new sig' },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg.forwardingAddress).toBe('old@cosmika.app')
    expect(cfg.signature).toBe('new sig')
  })

  it('lets a supervisor change a non-sensitive field, as before', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPERVISOR)
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'WEB_WIDGET',
        channelConfig: { websiteName: 'old.com', widgetHash: 'h1' },
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { websiteName: 'new.com', primaryColor: '#123456' },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg.websiteName).toBe('new.com')
    expect(cfg.primaryColor).toBe('#123456')
  })

  it('passes API channelConfig through merge with no schema validation', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'API',
        channelConfig: { foo: 'bar' },
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { baz: 'qux' },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg).toEqual({ foo: 'bar', baz: 'qux' })
  })

  it('treats null existing channelConfig as empty base', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'API',
        channelConfig: null, // total wipe / pre-migration row
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { webhookUrl: 'https://x.com/hook' },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg).toEqual({ webhookUrl: 'https://x.com/hook' })
  })

  it('treats an array existing channelConfig as empty base (defensive)', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({
        channelType: 'API',
        channelConfig: ['not', 'an', 'object'] as never,
      }),
    )
    let captured: Record<string, unknown> | null = null
    prisma.inbox.update.mockImplementation(async ({ data }) => {
      captured = data
      return makeInbox()
    })
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { ok: true },
    })
    const cfg = captured!.channelConfig as Record<string, unknown>
    expect(cfg).toEqual({ ok: true })
  })
})

// ---------- remove — F8: refuse with conversations attached ----------

describe('InboxesService.remove — F8: 409 when conversations attached', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('403 when caller is not a mutator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).remove('u1', 'acc1', 'inb1'),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('409 with the count when 1 conversation attached (singular grammar)', async () => {
    prisma.conversation.count.mockResolvedValue(1)
    let captured: ConflictException | null = null
    try {
      await makeService(prisma).remove('u1', 'acc1', 'inb1')
    } catch (err) {
      captured = err as ConflictException
    }
    expect(captured).toBeInstanceOf(ConflictException)
    expect(captured!.message).toContain('1 conversation attached')
    expect(prisma.inbox.delete).not.toHaveBeenCalled()
  })

  it('409 with the count when multiple conversations attached (plural grammar)', async () => {
    prisma.conversation.count.mockResolvedValue(42)
    let captured: ConflictException | null = null
    try {
      await makeService(prisma).remove('u1', 'acc1', 'inb1')
    } catch (err) {
      captured = err as ConflictException
    }
    expect(captured).toBeInstanceOf(ConflictException)
    expect(captured!.message).toContain('42 conversations attached')
    expect(prisma.inbox.delete).not.toHaveBeenCalled()
  })

  it('deletes the inbox when no conversations attached', async () => {
    prisma.conversation.count.mockResolvedValue(0)
    prisma.inbox.delete.mockResolvedValue(makeInbox())
    await makeService(prisma).remove('u1', 'acc1', 'inb1')
    expect(prisma.inbox.delete).toHaveBeenCalledWith({ where: { id: 'inb1' } })
  })
})

// ---------- addMember ----------

describe('InboxesService.addMember', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('403 when caller is not a mutator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'inb1', { userId: 'u2' }),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('404 when target user is not a member of the account', async () => {
    // First findUnique = caller's own membership (ADMIN). Second = the target.
    prisma.accountMember.findUnique
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce(null)
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'inb1', { userId: 'u-missing' }),
    ).rejects.toThrow('User is not a member of this account')
  })

  it('404 when target is a member but is inactive', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ...ADMIN, userId: 'u2', isActive: false })
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'inb1', { userId: 'u2' }),
    ).rejects.toThrow('User is not a member of this account')
  })

  it('409 when target is already a member of the inbox', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ...ADMIN, userId: 'u2' })
    prisma.inboxMember.findUnique.mockResolvedValue({ id: 'im-existing', userId: 'u2' })
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'inb1', { userId: 'u2' }),
    ).rejects.toThrow('User is already a member of this inbox')
  })

  it('creates the inbox member (happy path)', async () => {
    prisma.accountMember.findUnique
      .mockResolvedValueOnce(ADMIN)
      .mockResolvedValueOnce({ ...ADMIN, userId: 'u2' })
    prisma.inboxMember.findUnique.mockResolvedValue(null)
    const member = {
      id: 'im1',
      inboxId: 'inb1',
      userId: 'u2',
      createdAt: NOW,
      user: { id: 'u2', email: 'a@b.c', fullName: 'Two' },
    }
    prisma.inboxMember.create.mockResolvedValue(member)
    const out = await makeService(prisma).addMember('u1', 'acc1', 'inb1', {
      userId: 'u2',
    })
    expect(out).toBe(member)
    expect(prisma.inboxMember.create).toHaveBeenCalledWith({
      data: { inboxId: 'inb1', userId: 'u2' },
      include: { user: true },
    })
  })
})

// ---------- removeMember ----------

describe('InboxesService.removeMember', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
  })

  it('403 when caller is not a mutator', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'inb1', 'u2'),
    ).rejects.toThrow('Administrator or Supervisor role required')
  })

  it('404 when target is not actually a member of the inbox', async () => {
    prisma.inboxMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'inb1', 'u-missing'),
    ).rejects.toThrow(NotFoundException)
    expect(prisma.inboxMember.delete).not.toHaveBeenCalled()
  })

  it('deletes the membership when it exists', async () => {
    prisma.inboxMember.findUnique.mockResolvedValue({ id: 'im1' })
    prisma.inboxMember.delete.mockResolvedValue({ id: 'im1' })
    await makeService(prisma).removeMember('u1', 'acc1', 'inb1', 'u2')
    expect(prisma.inboxMember.delete).toHaveBeenCalledWith({
      where: { inboxId_userId: { inboxId: 'inb1', userId: 'u2' } },
    })
  })
})

// ---------- toInboxDTO / toInboxMemberDTO ----------

describe('InboxesService.toInboxDTO', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('redacts WhatsApp secrets', async () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'WHATSAPP',
        channelConfig: {
          phoneNumberId: '111',
          businessAccountId: '222',
          accessToken: 'SECRET-DO-NOT-LEAK',
          appSecret: 'APP-SECRET',
          webhookVerifyToken: 'verify',
        },
      }) as never,
    )
    expect(dto.channelConfig).toEqual({
      phoneNumberId: '111',
      businessAccountId: '222',
    })
    expect(dto.channelConfig).not.toHaveProperty('accessToken')
    expect(dto.channelConfig).not.toHaveProperty('appSecret')
    expect(dto.channelConfig).not.toHaveProperty('webhookVerifyToken')
  })

  it('never returns the Telegram bot token or webhook secret', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'TELEGRAM',
        channelConfig: { botToken: 'T', webhookSecret: 'S', botUsername: 'support_bot', botId: 9 },
      }) as never,
    )
    expect(dto.channelConfig).toEqual({ botUsername: 'support_bot', botId: 9 })
    expect(dto.whatsappSecrets).toBeNull()
  })

  it('never returns the Page token of a Messenger or Instagram inbox', () => {
    const svc = makeService(prisma)
    for (const channelType of ['FACEBOOK', 'INSTAGRAM']) {
      const dto = svc.toInboxDTO(
        makeInbox({ channelType, channelConfig: { pageId: '111', pageAccessToken: 'SECRET', instagramId: '17' } }) as never,
      )
      expect(dto.channelConfig).toEqual({ pageId: '111', instagramId: '17' })
    }
  })

  it('never returns the registration PIN of an Embedded Signup channel', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'WHATSAPP',
        channelConfig: {
          phoneNumberId: '111',
          businessAccountId: '222',
          registrationPin: '482913',
          onboarding: 'embedded_signup',
        },
      }) as never,
    )
    expect(dto.channelConfig).toEqual({
      phoneNumberId: '111',
      businessAccountId: '222',
      onboarding: 'embedded_signup',
    })
    expect(JSON.stringify(dto)).not.toContain('482913')
  })

  it('reports which WhatsApp secrets are stored, as booleans only', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'WHATSAPP',
        channelConfig: {
          phoneNumberId: '111',
          businessAccountId: '222',
          accessToken: 'SECRET-DO-NOT-LEAK',
          appSecret: '',
        },
      }) as never,
    )
    expect(dto.whatsappSecrets).toEqual({
      accessToken: true,
      appSecret: false,
      webhookVerifyToken: false,
    })
    expect(JSON.stringify(dto)).not.toContain('SECRET-DO-NOT-LEAK')
  })

  it('has no secrets status for other channels', () => {
    const dto = makeService(prisma).toInboxDTO(makeInbox() as never)
    expect(dto.whatsappSecrets).toBeNull()
  })

  it('does NOT redact for WEB_WIDGET inboxes', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'WEB_WIDGET',
        channelConfig: { websiteName: 'x.com', widgetHash: 'h1' },
      }) as never,
    )
    expect(dto.channelConfig).toEqual({ websiteName: 'x.com', widgetHash: 'h1' })
  })

  it('returns {} when channelConfig is null', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'WHATSAPP',
        channelConfig: null,
      }) as never,
    )
    expect(dto.channelConfig).toEqual({})
  })

  it('returns {} when channelConfig is an array (defensive)', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(
      makeInbox({
        channelType: 'API',
        channelConfig: ['x'] as never,
      }) as never,
    )
    expect(dto.channelConfig).toEqual({})
  })

  it('serializes dates as ISO strings', () => {
    const svc = makeService(prisma)
    const dto = svc.toInboxDTO(makeInbox() as never)
    expect(dto.createdAt).toBe(NOW.toISOString())
    expect(dto.updatedAt).toBe(NOW.toISOString())
  })
})

describe('InboxesService.toInboxMemberDTO', () => {
  it('flattens user fields + ISO-formats createdAt', () => {
    const svc = makeService(makePrisma())
    const dto = svc.toInboxMemberDTO({
      id: 'im1',
      userId: 'u1',
      createdAt: NOW,
      user: { id: 'u1', email: 'a@b.c', fullName: 'Anna' },
    } as never)
    expect(dto).toEqual({
      id: 'im1',
      userId: 'u1',
      user: { id: 'u1', email: 'a@b.c', fullName: 'Anna' },
      createdAt: NOW.toISOString(),
    })
  })
})

// ---------- updateWhatsappCredentials ----------

describe('InboxesService.updateWhatsappCredentials', () => {
  const STORED = {
    phoneNumberId: 'phone-old',
    businessAccountId: 'waba-old',
    accessToken: 'STORED-ACCESS-TOKEN',
    appSecret: 'STORED-APP-SECRET',
    webhookVerifyToken: 'STORED-VERIFY',
  }
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...STORED } }),
    )
    prisma.inbox.findFirst.mockResolvedValue(null)
    prisma.inbox.update.mockImplementation(async ({ data }) =>
      makeInbox({ channelType: 'WHATSAPP', channelConfig: data.channelConfig }),
    )
  })

  function savedConfig(): Record<string, unknown> {
    return prisma.inbox.update.mock.calls[0]![0].data.channelConfig
  }

  it('lets an administrator replace a secret and reports only the field name', async () => {
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    expect(res.changed).toEqual(['accessToken'])
    expect(prisma.inbox.update).toHaveBeenCalledWith({
      where: { id: 'inb1' },
      data: { channelConfig: { ...STORED, accessToken: 'NEW-ACCESS-TOKEN-123' } },
    })
  })

  it.each([SUPERVISOR, AGENT])('refuses a %s: credentials are administrator-only', async (member) => {
    prisma.accountMember.findUnique.mockResolvedValue(member)
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        accessToken: 'NEW-ACCESS-TOKEN-123',
      }),
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.inbox.findUnique).not.toHaveBeenCalled()
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('refuses a non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {}),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404s for an inbox in another account', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ accountId: 'other', channelType: 'WHATSAPP', channelConfig: STORED }),
    )
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        appSecret: 'NEW-APP-SECRET-123',
      }),
    ).rejects.toThrow(NotFoundException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('400s for a channel that is not WhatsApp', async () => {
    prisma.inbox.findUnique.mockResolvedValue(makeInbox())
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        appSecret: 'NEW-APP-SECRET-123',
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('keeps every stored value for fields that are absent', async () => {
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      businessAccountId: 'waba-new',
    })
    expect(res.changed).toEqual(['businessAccountId'])
    expect(savedConfig()).toEqual({ ...STORED, businessAccountId: 'waba-new' })
  })

  it('writes nothing and reports no change when nothing was sent', async () => {
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {})
    expect(res.changed).toEqual([])
    expect(res.inbox.channelConfig).toEqual(STORED)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('does not count a value identical to the stored one as a change', async () => {
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      appSecret: 'STORED-APP-SECRET',
      webhookVerifyToken: 'rotated-verify',
    })
    expect(res.changed).toEqual(['webhookVerifyToken'])
  })

  it('copies only the allowed fields, never extra keys smuggled into the input', async () => {
    await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
      widgetHash: 'evil',
      phoneNumberIdx: 'typo',
    } as never)
    expect(Object.keys(savedConfig()).sort()).toEqual(Object.keys(STORED).sort())
  })

  it('reports every changed field in a fixed order', async () => {
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      webhookVerifyToken: 'v2',
      phoneNumberId: 'phone-new',
      businessAccountId: 'waba-new',
      appSecret: 'NEW-APP-SECRET-123',
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    expect(res.changed).toEqual([
      'phoneNumberId',
      'businessAccountId',
      'accessToken',
      'appSecret',
      'webhookVerifyToken',
    ])
  })

  it('refuses a phone number ID already used by another WhatsApp channel of the account', async () => {
    prisma.inbox.findFirst.mockResolvedValue({ id: 'inb2' })
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        phoneNumberId: 'phone-taken',
      }),
    ).rejects.toThrow(ConflictException)
    expect(prisma.inbox.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: 'acc1',
        channelType: 'WHATSAPP',
        id: { not: 'inb1' },
        channelConfig: { path: ['phoneNumberId'], equals: 'phone-taken' },
      },
      select: { id: true },
    })
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('stores the new phone number ID so the webhook guard compares against it', async () => {
    await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      phoneNumberId: 'phone-new',
    })
    expect(savedConfig().phoneNumberId).toBe('phone-new')
  })

  it('skips the clash lookup when the phone number ID is unchanged', async () => {
    await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    expect(prisma.inbox.findFirst).not.toHaveBeenCalled()
  })

  it('400s when the stored config is incomplete, naming the field but no value', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: null }),
    )
    const err = await makeService(prisma)
      .updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        accessToken: 'NEW-ACCESS-TOKEN-123',
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BadRequestException)
    const body = JSON.stringify((err as BadRequestException).getResponse())
    expect(body).toContain('phoneNumberId')
    expect(body).not.toContain('NEW-ACCESS-TOKEN-123')
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('hides a database error that could echo the secrets, in the response and the log', async () => {
    const leaky = new Error('Invalid `prisma.inbox.update()` invocation: accessToken: "NEW-ACCESS-TOKEN-123"')
    prisma.inbox.update.mockRejectedValue(leaky)
    const svc = makeService(prisma)
    const logged: string[] = []
    ;(svc as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m: string) => logged.push(m),
    }
    const err = await svc
      .updateWhatsappCredentials('u1', 'acc1', 'inb1', { accessToken: 'NEW-ACCESS-TOKEN-123' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InternalServerErrorException)
    expect(JSON.stringify((err as InternalServerErrorException).getResponse())).not.toContain(
      'NEW-ACCESS-TOKEN-123',
    )
    expect(logged.join('\n')).not.toContain('NEW-ACCESS-TOKEN-123')
    expect(logged.join('\n')).toContain('inb1')
  })

  it('logs a generic label when the thrown value is not an Error', async () => {
    prisma.inbox.update.mockRejectedValue('boom')
    const svc = makeService(prisma)
    const logged: string[] = []
    ;(svc as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m: string) => logged.push(m),
    }
    await expect(
      svc.updateWhatsappCredentials('u1', 'acc1', 'inb1', { appSecret: 'NEW-APP-SECRET-123' }),
    ).rejects.toThrow(InternalServerErrorException)
    expect(logged[0]).toContain('unknown error')
  })

  it('returns a DTO that says which secrets are set without any of their values', async () => {
    const svc = makeService(prisma)
    const { inbox } = await svc.updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    const json = JSON.stringify(svc.toInboxDTO(inbox as never))
    for (const secret of ['NEW-ACCESS-TOKEN-123', 'STORED-APP-SECRET', 'STORED-VERIFY']) {
      expect(json).not.toContain(secret)
    }
    expect(svc.toInboxDTO(inbox as never).whatsappSecrets).toEqual({
      accessToken: true,
      appSecret: true,
      webhookVerifyToken: true,
    })
  })
})

// ---------- PATCH :id with a WhatsApp channelConfig ----------
//
// This path was closed with a 400 while the dedicated endpoint was built. It
// is open again, and these tests are what keeps it from being the hole it
// would be if it simply merged the incoming config.

describe('InboxesService.update: WhatsApp channelConfig', () => {
  const STORED = {
    phoneNumberId: 'phone-old',
    businessAccountId: 'waba-old',
    accessToken: 'STORED-ACCESS-TOKEN',
    appSecret: 'STORED-APP-SECRET',
    webhookVerifyToken: 'STORED-VERIFY',
  }
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...STORED } }),
    )
    prisma.inbox.findFirst.mockResolvedValue(null)
    prisma.inbox.update.mockImplementation(async ({ data }) =>
      makeInbox({ channelType: 'WHATSAPP', channelConfig: data.channelConfig }),
    )
  })

  it('lets an administrator replace a secret and reports the field name', async () => {
    const res = await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123' },
    })
    expect(res.whatsappCredentialsChanged).toEqual(['accessToken'])
    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig).toEqual({
      ...STORED,
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
  })

  it.each([SUPERVISOR, AGENT])(
    'refuses a %s who sends a credential, before any write',
    async (member) => {
      prisma.accountMember.findUnique.mockResolvedValue(member)
      await expect(
        makeService(prisma).update('u1', 'acc1', 'inb1', {
          channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123' },
        }),
      ).rejects.toThrow(ForbiddenException)
      expect(prisma.inbox.update).not.toHaveBeenCalled()
    },
  )

  it('refuses a supervisor who sends the phone number, not only the write-only secrets', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPERVISOR)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', {
        channelConfig: { phoneNumberId: 'phone-new' },
      }),
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('treats a blank field as "keep" and does not demand the administrator role for it', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPERVISOR)
    const res = await makeService(prisma).update('u1', 'acc1', 'inb1', {
      channelConfig: { accessToken: '', appSecret: '  ' },
    })
    expect(res.whatsappCredentialsChanged).toEqual([])
    expect(res.inbox.channelConfig).toEqual(STORED)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('refuses an unknown field instead of merging it into the stored config', async () => {
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', {
        channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123', widgetHash: 'evil' },
      }),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('applies the same duplicate-number guard as the dedicated route', async () => {
    prisma.inbox.findFirst.mockResolvedValue({ id: 'inb2' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'inb1', {
        channelConfig: { phoneNumberId: 'phone-taken' },
      }),
    ).rejects.toThrow(ConflictException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('writes the credential and the rest of the PATCH in one statement', async () => {
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      name: 'Renamed',
      csatEnabled: true,
      channelConfig: { appSecret: 'NEW-APP-SECRET-123' },
    })
    expect(prisma.inbox.update).toHaveBeenCalledTimes(1)
    const data = prisma.inbox.update.mock.calls[0]![0].data
    expect(data.name).toBe('Renamed')
    expect(data.csatEnabled).toBe(true)
    expect(data.channelConfig).toEqual({ ...STORED, appSecret: 'NEW-APP-SECRET-123' })
  })

  it('still writes the rest of the PATCH when no credential changed', async () => {
    await makeService(prisma).update('u1', 'acc1', 'inb1', {
      name: 'Renamed',
      channelConfig: { accessToken: '' },
    })
    const data = prisma.inbox.update.mock.calls[0]![0].data
    expect(data.name).toBe('Renamed')
    expect(data.channelConfig).toEqual(STORED)
  })

  it('reports no credential change for a PATCH that does not carry a channelConfig', async () => {
    const res = await makeService(prisma).update('u1', 'acc1', 'inb1', { name: 'Renamed' })
    expect(res.whatsappCredentialsChanged).toEqual([])
  })
})

// ---------- Encryption at rest ----------

describe('InboxesService: channel secrets encrypted at rest', () => {
  const KEY = randomBytes(32).toString('base64')
  const PLAIN = {
    phoneNumberId: 'phone-1',
    businessAccountId: 'waba-1',
    accessToken: 'EAAG-STORED-ACCESS',
    appSecret: 'STORED-APP-SECRET',
    webhookVerifyToken: 'STORED-VERIFY',
  }
  let prisma: Prisma
  beforeEach(() => {
    process.env.COSMIKA_SECRETS_KEY = KEY
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.account.findUnique.mockResolvedValue(ACCOUNT)
    prisma.inbox.findFirst.mockResolvedValue(null)
    prisma.inbox.create.mockImplementation(async ({ data }) => makeInbox(data))
    prisma.inbox.update.mockImplementation(async ({ data }) =>
      makeInbox({ channelType: 'WHATSAPP', channelConfig: data.channelConfig }),
    )
  })
  afterEach(() => {
    delete process.env.COSMIKA_SECRETS_KEY
  })

  function savedConfig(): Record<string, string> {
    return prisma.inbox.update.mock.calls[0]![0].data.channelConfig
  }

  it('never writes a plaintext secret on create, and keeps the ids readable', async () => {
    await makeService(prisma).create('u1', 'acc1', {
      name: 'WhatsApp',
      channelType: 'WHATSAPP',
      channelConfig: { ...PLAIN },
    } as never)
    const cfg = prisma.inbox.create.mock.calls[0]![0].data.channelConfig as Record<string, string>
    expect(cfg.phoneNumberId).toBe('phone-1')
    expect(cfg.businessAccountId).toBe('waba-1')
    for (const field of ['accessToken', 'appSecret', 'webhookVerifyToken']) {
      expect(isEncryptedSecret(cfg[field])).toBe(true)
      expect(decryptSecret(cfg[field]!)).toBe(PLAIN[field as keyof typeof PLAIN])
    }
    expect(JSON.stringify(cfg)).not.toContain('EAAG-STORED-ACCESS')
  })

  it('stores a replaced secret encrypted', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...PLAIN } }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    expect(res.changed).toEqual(['accessToken'])
    expect(isEncryptedSecret(savedConfig().accessToken)).toBe(true)
    expect(decryptSecret(savedConfig().accessToken!)).toBe('NEW-ACCESS-TOKEN-123')
    expect(JSON.stringify(savedConfig())).not.toContain('NEW-ACCESS-TOKEN-123')
  })

  it('re-encrypts the secrets of a channel that predates encryption on the next save', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...PLAIN } }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      businessAccountId: 'waba-2',
    })
    // Only the field the operator actually changed is audited, even though
    // all three secrets were rewritten.
    expect(res.changed).toEqual(['businessAccountId'])
    for (const field of ['accessToken', 'appSecret', 'webhookVerifyToken']) {
      expect(isEncryptedSecret(savedConfig()[field])).toBe(true)
    }
  })

  it('upgrades plaintext secrets even when the operator changed nothing', async () => {
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...PLAIN } }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {})
    expect(res.changed).toEqual([])
    expect(prisma.inbox.update).toHaveBeenCalledTimes(1)
    expect(decryptSecret(savedConfig().accessToken!)).toBe('EAAG-STORED-ACCESS')
  })

  it('does not rewrite a channel that is already encrypted and unchanged', async () => {
    const stored = encryptSecretsIn({ ...PLAIN }, [
      'accessToken',
      'appSecret',
      'webhookVerifyToken',
    ])
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: stored }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {})
    expect(res.changed).toEqual([])
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('compares an encrypted secret against its plaintext, so re-typing the same value is not a change', async () => {
    const stored = encryptSecretsIn({ ...PLAIN }, [
      'accessToken',
      'appSecret',
      'webhookVerifyToken',
    ])
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: stored }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'EAAG-STORED-ACCESS',
      appSecret: 'ROTATED-APP-SECRET',
    })
    expect(res.changed).toEqual(['appSecret'])
  })

  it('reports which secrets are set from the encrypted values, without decrypting them', async () => {
    const stored = encryptSecretsIn({ ...PLAIN }, [
      'accessToken',
      'appSecret',
      'webhookVerifyToken',
    ])
    const dto = makeService(prisma).toInboxDTO(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: stored }) as never,
    )
    expect(dto.whatsappSecrets).toEqual({
      accessToken: true,
      appSecret: true,
      webhookVerifyToken: true,
    })
    // The redaction drops the secret keys altogether, encrypted or not.
    expect(dto.channelConfig).toEqual({
      phoneNumberId: 'phone-1',
      businessAccountId: 'waba-1',
    })
  })

  it('leaves everything in plaintext when no key is configured', async () => {
    delete process.env.COSMIKA_SECRETS_KEY
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: { ...PLAIN } }),
    )
    const res = await makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
      accessToken: 'NEW-ACCESS-TOKEN-123',
    })
    expect(res.changed).toEqual(['accessToken'])
    expect(savedConfig().accessToken).toBe('NEW-ACCESS-TOKEN-123')
  })

  it('surfaces an unreadable stored secret instead of overwriting the channel with a guess', async () => {
    const stored = encryptSecretsIn({ ...PLAIN }, ['accessToken'])
    process.env.COSMIKA_SECRETS_KEY = randomBytes(32).toString('base64')
    prisma.inbox.findUnique.mockResolvedValue(
      makeInbox({ channelType: 'WHATSAPP', channelConfig: stored }),
    )
    await expect(
      makeService(prisma).updateWhatsappCredentials('u1', 'acc1', 'inb1', {
        appSecret: 'NEW-APP-SECRET-123',
      }),
    ).rejects.toThrow(/could not be decrypted/)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })
})
