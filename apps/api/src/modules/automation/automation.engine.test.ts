import { channelsOver } from '../channels/channels.testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationEngine } from './automation.engine'

// ─── Mock factories ─────────────────────────────────────────────────

function makePrisma() {
  return {
    automationRule: {
      findMany: vi.fn(),
    },
    automationRuleRun: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
    },
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    message: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inbox: {
      findUnique: vi.fn().mockResolvedValue({ channelType: 'API' }),
    },
    team: {
      findUnique: vi.fn(),
    },
    accountMember: {
      findUnique: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeRealtime() {
  return { publish: vi.fn().mockResolvedValue(undefined) }
}
type Realtime = ReturnType<typeof makeRealtime>

function makeWorkingHours() {
  return { isInboxOpenNow: vi.fn() }
}
type WorkingHours = ReturnType<typeof makeWorkingHours>

function makeAssignment() {
  return { route: vi.fn().mockResolvedValue({ assigneeId: null, pickedId: null }) }
}
type Assignment = ReturnType<typeof makeAssignment>

function makeWhatsapp() {
  return {
    recipientForConversation: vi.fn().mockResolvedValue('+5511999990000'),
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'wamid-auto' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
  }
}
type Whatsapp = ReturnType<typeof makeWhatsapp>

function makeEngine(
  prisma: Prisma = makePrisma(),
  realtime: Realtime = makeRealtime(),
  workingHours: WorkingHours = makeWorkingHours(),
  assignment: Assignment = makeAssignment(),
  whatsapp: Whatsapp = makeWhatsapp(),
) {
  const eng = new AutomationEngine(
    prisma as never,
    realtime as never,
    workingHours as never,
    assignment as never,
    channelsOver(whatsapp) as never,
  )
  return { eng, prisma, realtime, workingHours, assignment, whatsapp }
}

// ─── Fixtures ───────────────────────────────────────────────────────

const CONV = {
  id: 'cv1',
  accountId: 'acc1',
  inboxId: 'inb1',
  priority: 'NORMAL' as const,
  status: 'OPEN' as const,
  aiTags: ['existing'] as string[],
  contact: { email: 'user@acme.com' },
}

function rule(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
    accountId: 'acc1',
    triggerEvent: 'CONVERSATION_CREATED',
    isActive: true,
    runOncePerConversation: false,
    conditions: [],
    actions: [],
    createdAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  }
}

// ─── evaluate(): rule loader + outer flow ───────────────────────────

describe('AutomationEngine.evaluate — rule loader & outer flow', () => {
  let prisma: Prisma
  let realtime: Realtime
  let workingHours: WorkingHours
  let eng: AutomationEngine

  beforeEach(() => {
    ;({ eng, prisma, realtime, workingHours } = makeEngine())
  })

  it('returns [] when no active rules match the trigger', async () => {
    prisma.automationRule.findMany.mockResolvedValue([])
    const out = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(out).toEqual([])
    expect(prisma.automationRule.findMany).toHaveBeenCalledWith({
      where: {
        accountId: 'acc1',
        triggerEvent: 'CONVERSATION_CREATED',
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('runs each rule in order and aggregates results', async () => {
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ id: 'r1' }),
      rule({ id: 'r2' }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results.map((r) => r.ruleId)).toEqual(['r1', 'r2'])
    expect(results.every((r) => r.matched)).toBe(true)
  })

  it('catches per-rule exceptions and pushes an error result without breaking the loop', async () => {
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ id: 'r1' }),
      rule({ id: 'r2' }),
    ])
    // first rule throws (conversation.findUnique blows up only the first time)
    prisma.conversation.findUnique
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(CONV)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]).toEqual({
      ruleId: 'r1',
      matched: false,
      conditionResults: [],
      actionsExecuted: [],
      error: 'boom',
    })
    expect(results[1]?.matched).toBe(true)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    void realtime
    void workingHours
  })

  it('stringifies non-Error throws in the outer catch', async () => {
    prisma.automationRule.findMany.mockResolvedValue([rule({ id: 'r1' })])
    prisma.conversation.findUnique.mockRejectedValueOnce('plain-string-fail')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]?.error).toBe('plain-string-fail')
    errorSpy.mockRestore()
  })
})

// ─── runOncePerConversation guard ───────────────────────────────────

describe('AutomationEngine.evaluate — runOncePerConversation', () => {
  it('skips the rule when a prior matched run exists', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ id: 'r1', runOncePerConversation: true }),
    ])
    prisma.automationRuleRun.findUnique.mockResolvedValue({
      ruleId: 'r1',
      conversationId: 'cv1',
      matched: true,
    })
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]).toEqual({
      ruleId: 'r1',
      matched: false,
      conditionResults: [],
      actionsExecuted: [],
    })
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled()
    expect(prisma.automationRuleRun.upsert).not.toHaveBeenCalled()
  })

  it('proceeds when prior run was unmatched (matched=false)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ id: 'r1', runOncePerConversation: true }),
    ])
    prisma.automationRuleRun.findUnique.mockResolvedValue({
      ruleId: 'r1',
      conversationId: 'cv1',
      matched: false,
    })
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]?.matched).toBe(true)
    expect(prisma.automationRuleRun.upsert).toHaveBeenCalled()
  })

  it('proceeds when no prior run exists', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ id: 'r1', runOncePerConversation: true }),
    ])
    prisma.automationRuleRun.findUnique.mockResolvedValue(null)
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]?.matched).toBe(true)
  })
})

// ─── runRule conversation-load guard ────────────────────────────────

describe('AutomationEngine.evaluate — conversation guard', () => {
  it('returns matched=false when conversation does not exist', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([rule()])
    prisma.conversation.findUnique.mockResolvedValue(null)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]).toEqual({
      ruleId: 'r1',
      matched: false,
      conditionResults: [],
      actionsExecuted: [],
    })
    expect(prisma.automationRuleRun.upsert).not.toHaveBeenCalled()
  })

  it('returns matched=false on cross-account IDOR', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([rule()])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      accountId: 'other-acc',
    })
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]?.matched).toBe(false)
  })
})

// ─── parseConditions / parseActions defensive coercion ──────────────

describe('AutomationEngine.evaluate — defensive parsing', () => {
  it('treats non-array conditions JSON as []', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ conditions: { not: 'array' }, actions: [] }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    // No conditions -> matched=true vacuously
    expect(results[0]?.matched).toBe(true)
    expect(results[0]?.conditionResults).toEqual([])
  })

  it('treats non-array actions JSON as []', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({ conditions: [], actions: { also: 'not an array' } }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const results = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(results[0]?.matched).toBe(true)
    expect(results[0]?.actionsExecuted).toEqual([])
  })
})

// ─── Condition evaluation: every field × op ─────────────────────────

describe('AutomationEngine — INBOX_ID condition', () => {
  it('equals matches when inboxId is equal', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'equals', value: 'inb1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('equals fails when inboxId differs', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'equals', value: 'other' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('not_equals matches when inboxId differs', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'not_equals', value: 'other' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('not_equals with null value falls back to empty string', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'not_equals', value: null }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true) // 'inb1' !== ''
  })

  it('in matches when value is in array', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'INBOX_ID', op: 'in', value: ['inb1', 'inb2'] },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('in fails when value is not in array', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'INBOX_ID', op: 'in', value: ['x', 'y'] },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('in with non-array value falls back to equality compare', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'in', value: 'inb1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    // Falls through to equality on enum-like field => 'inb1' === 'inb1' => true
    expect(r[0]?.matched).toBe(true)
  })

  it('equals with null/undefined expected uses empty string', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'INBOX_ID', op: 'equals', value: null }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false) // 'inb1' !== ''
  })
})

describe('AutomationEngine — PRIORITY condition', () => {
  it('equals matches when priority matches', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'PRIORITY', op: 'equals', value: 'NORMAL' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })
})

describe('AutomationEngine — STATUS condition', () => {
  it('equals matches when status matches', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [{ field: 'STATUS', op: 'equals', value: 'OPEN' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })
})

describe('AutomationEngine — CONTENT_CONTAINS condition', () => {
  it('contains op matches case-insensitively', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'contains', value: 'Refund' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      latestMessage: {
        id: 'm1',
        content: 'I need a refund please',
        senderType: 'CONTACT',
      },
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('equals op behaves like contains (collapses)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'equals', value: 'refund' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      latestMessage: { id: 'm1', content: 'wanting refund', senderType: 'CONTACT' },
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('not_equals op inverts the contains check', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'not_equals', value: 'refund' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      latestMessage: { id: 'm1', content: 'just a hello', senderType: 'CONTACT' },
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('handles missing latestMessage gracefully (empty haystack)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'contains', value: 'hi' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('handles null/undefined value with empty needle', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'contains', value: null },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      latestMessage: { id: 'm1', content: 'whatever', senderType: 'CONTACT' },
    })
    // empty needle always "included" => matches
    expect(r[0]?.matched).toBe(true)
  })

  it('handles null content on message (uses empty haystack)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'CONTENT_CONTAINS', op: 'contains', value: 'hi' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      latestMessage: { id: 'm1', content: null, senderType: 'CONTACT' },
    })
    expect(r[0]?.matched).toBe(false)
  })
})

describe('AutomationEngine — CONTACT_EMAIL_DOMAIN condition', () => {
  it('equals matches the domain part', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'CONTACT_EMAIL_DOMAIN', op: 'equals', value: 'acme.com' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('domain extraction is case-insensitive', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'CONTACT_EMAIL_DOMAIN', op: 'equals', value: 'acme.com' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      contact: { email: 'USER@ACME.COM' },
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('null email -> empty domain (matches "")', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'CONTACT_EMAIL_DOMAIN', op: 'equals', value: '' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      contact: { email: null },
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('email without @ -> empty domain', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'CONTACT_EMAIL_DOMAIN', op: 'equals', value: 'acme.com' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      contact: { email: 'malformed' },
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })
})

describe('AutomationEngine — TAG_INCLUDES condition', () => {
  it('matches when tag is present (case-insensitive)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'TAG_INCLUDES', op: 'equals', value: 'EXISTING' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('fails when tag is absent', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'TAG_INCLUDES', op: 'equals', value: 'absent' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('not_equals inverts the inclusion check', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'TAG_INCLUDES', op: 'not_equals', value: 'absent' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('handles null aiTags gracefully (defaults to [])', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'TAG_INCLUDES', op: 'equals', value: 'any' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      aiTags: null,
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('handles null value (needle becomes "")', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'TAG_INCLUDES', op: 'equals', value: null },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
  })
})

describe('AutomationEngine — OUTSIDE_WORKING_HOURS condition', () => {
  it('matches when inbox is closed and value=true', async () => {
    const { eng, prisma, workingHours } = makeEngine()
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'OUTSIDE_WORKING_HOURS', op: 'is_true', value: true },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(r[0]?.conditionResults[0]?.detail).toBe('closed')
  })

  it('also accepts the string "true" as value', async () => {
    const { eng, prisma, workingHours } = makeEngine()
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'OUTSIDE_WORKING_HOURS', op: 'is_true', value: 'true' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('fails when inbox is open and value=true', async () => {
    const { eng, prisma, workingHours } = makeEngine()
    workingHours.isInboxOpenNow.mockResolvedValue(true)
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'OUTSIDE_WORKING_HOURS', op: 'is_true', value: true },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
    expect(r[0]?.conditionResults[0]?.detail).toBe('open')
  })

  it('inverts when value=false (matches open inbox)', async () => {
    const { eng, prisma, workingHours } = makeEngine()
    workingHours.isInboxOpenNow.mockResolvedValue(true)
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'OUTSIDE_WORKING_HOURS', op: 'is_true', value: false },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
  })
})

describe('AutomationEngine — IS_FIRST_MESSAGE condition', () => {
  it('matches when ctx.isFirstMessage=true and value=true', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'IS_FIRST_MESSAGE', op: 'is_true', value: true },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      isFirstMessage: true,
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('accepts string "true" as value', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'IS_FIRST_MESSAGE', op: 'is_true', value: 'true' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      isFirstMessage: true,
    })
    expect(r[0]?.matched).toBe(true)
  })

  it('fails when ctx.isFirstMessage=false and value=true', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'IS_FIRST_MESSAGE', op: 'is_true', value: true },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      isFirstMessage: false,
    })
    expect(r[0]?.matched).toBe(false)
  })

  it('inverts when value=false (matches non-first)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        triggerEvent: 'MESSAGE_CREATED',
        conditions: [
          { field: 'IS_FIRST_MESSAGE', op: 'is_true', value: false },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'MESSAGE_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
      isFirstMessage: false,
    })
    expect(r[0]?.matched).toBe(true)
  })
})

describe('AutomationEngine — unknown condition field', () => {
  it('returns matched=false with "unknown field" detail', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          // bogus field — passes the unknown-field default branch
          { field: 'NOT_A_FIELD', op: 'equals', value: 'x' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
    expect(r[0]?.conditionResults[0]?.detail).toBe('unknown field')
  })
})

// ─── Action execution: every kind ───────────────────────────────────

describe('AutomationEngine — ASSIGN_TEAM action', () => {
  it('happy path: assigns team after verifying account', async () => {
    const { eng, prisma, assignment } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_TEAM', value: 'team1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1' })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(r[0]?.actionsExecuted).toEqual([
      { kind: 'ASSIGN_TEAM', value: 'team1' },
    ])
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { teamId: 'team1' },
    })
    // A new team distributes the conversation among its available members.
    expect(assignment.route).toHaveBeenCalledWith('cv1', 'team_changed')
  })

  it('does not re-distribute when the conversation already has that team', async () => {
    const { eng, prisma, assignment } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_TEAM', value: 'team1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({ ...CONV, teamId: 'team1' })
    prisma.team.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await eng.evaluate({
      event: 'CONVERSATION_UPDATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(prisma.conversation.update).toHaveBeenCalled()
    expect(assignment.route).not.toHaveBeenCalled()
  })

  it('throws and records error when team is missing', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_TEAM', value: 'team1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.team.findUnique.mockResolvedValue(null)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('Team team1 not in account')
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('throws when team belongs to another account (cross-account guard)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_TEAM', value: 'team1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.team.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('Team team1 not in account')
  })
})

describe('AutomationEngine — ASSIGN_USER action', () => {
  it('happy path: assigns active member', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_USER', value: 'u9' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.accountMember.findUnique.mockResolvedValue({
      accountId: 'acc1',
      userId: 'u9',
      isActive: true,
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { assigneeId: 'u9' },
    })
  })

  it('throws when member is missing', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_USER', value: 'u9' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('User u9 not active in account')
  })

  it('throws when member is inactive', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_USER', value: 'u9' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.accountMember.findUnique.mockResolvedValue({
      accountId: 'acc1',
      userId: 'u9',
      isActive: false,
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('User u9 not active in account')
  })
})

describe('AutomationEngine — SET_PRIORITY action', () => {
  it('happy path: updates the priority', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_PRIORITY', value: 'HIGH' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { priority: 'HIGH' },
    })
  })

  it('throws on invalid priority value', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_PRIORITY', value: 'NOPE' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('Invalid priority NOPE')
  })
})

describe('AutomationEngine — ADD_TAG action', () => {
  it('happy path: appends a new tag', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: 'vip' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { aiTags: { set: ['existing', 'vip'] } },
    })
  })

  it('skips no-op when tag already present (dedupe)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: 'existing' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(r[0]?.actionsExecuted).toEqual([
      { kind: 'ADD_TAG', value: 'existing' },
    ])
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('handles null aiTags (starts from [])', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: 'first' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      aiTags: null,
    })
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'cv1' },
      data: { aiTags: { set: ['first'] } },
    })
  })

  it('skips no-op when value is whitespace only', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: '   ' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })
})

describe('AutomationEngine — SET_STATUS action', () => {
  it('happy path: sets status to OPEN (no resolvedAt change since not RESOLVED before/after)', async () => {
    const { eng, prisma, realtime } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_STATUS', value: 'OPEN' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    const arg = prisma.conversation.update.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: 'cv1' })
    expect(arg.data.status).toBe('OPEN')
    expect(arg.data.resolvedAt).toBeUndefined()
    expect(arg.data.reopenedAt).toBeUndefined()
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ConversationStatusChanged',
        accountId: 'acc1',
        conversationId: 'cv1',
        status: 'OPEN',
      }),
    )
  })

  it('sets resolvedAt when transitioning OPEN -> RESOLVED', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_STATUS', value: 'RESOLVED' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    const arg = prisma.conversation.update.mock.calls[0]![0]
    expect(arg.data.status).toBe('RESOLVED')
    expect(arg.data.resolvedAt).toBeInstanceOf(Date)
    expect(arg.data.reopenedAt).toBeUndefined()
  })

  it('does NOT touch resolvedAt when already RESOLVED and target is also RESOLVED', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_STATUS', value: 'RESOLVED' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      status: 'RESOLVED',
    })
    await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    const arg = prisma.conversation.update.mock.calls[0]![0]
    expect(arg.data.status).toBe('RESOLVED')
    expect(arg.data.resolvedAt).toBeUndefined()
    expect(arg.data.reopenedAt).toBeUndefined()
  })

  it.each(['OPEN', 'PENDING'])(
    'never reopens a closed conversation: a rule setting %s is skipped for it',
    async (value) => {
      const { eng, prisma } = makeEngine()
      prisma.automationRule.findMany.mockResolvedValue([
        rule({
          actions: [{ kind: 'SET_STATUS', value }],
        }),
      ])
      prisma.conversation.findUnique.mockResolvedValue({
        ...CONV,
        status: 'RESOLVED',
      })
      await eng.evaluate({
        event: 'CONVERSATION_CREATED',
        accountId: 'acc1',
        conversationId: 'cv1',
      })
      expect(prisma.conversation.update).not.toHaveBeenCalled()
    },
  )

  it('throws on invalid status value', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_STATUS', value: 'BOGUS' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('Invalid status BOGUS')
  })
})

describe('AutomationEngine — SEND_REPLY action', () => {
  it('happy path: creates system message and publishes MessageCreated', async () => {
    const { eng, prisma, realtime } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SEND_REPLY', value: 'Hi!' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const created = {
      id: 'm-new',
      createdAt: new Date('2026-05-25T12:00:00.000Z'),
    }
    prisma.message.create.mockResolvedValue(created)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(true)
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'cv1',
        inboxId: 'inb1',
        accountId: 'acc1',
        senderType: 'SYSTEM',
        content: 'Hi!',
        contentType: 'TEXT',
        status: 'PENDING',
      },
    })
    // A widget/API inbox reads the thread: nothing to push, and it is sent.
    // Settled only from PENDING, so a receipt that raced ahead is not undone.
    expect(prisma.message.updateMany).toHaveBeenCalledWith({ where: { id: 'm-new', status: 'PENDING' }, data: { status: 'SENT' } })
    expect(realtime.publish).toHaveBeenCalledWith({
      type: 'MessageCreated',
      accountId: 'acc1',
      conversationId: 'cv1',
      inboxId: 'inb1',
      messageId: 'm-new',
      senderType: 'SYSTEM',
      content: 'Hi!',
      isPrivate: false,
      createdAt: '2026-05-25T12:00:00.000Z',
    })
  })
})

describe('AutomationEngine: SEND_REPLY reaches the WhatsApp contact', () => {
  const run = async (setup: (m: ReturnType<typeof makeEngine>) => void = () => undefined) => {
    const m = makeEngine()
    m.prisma.automationRule.findMany.mockResolvedValue([rule({ actions: [{ kind: 'SEND_REPLY', value: 'Recebemos sua mensagem.' }] })])
    m.prisma.conversation.findUnique.mockResolvedValue(CONV)
    m.prisma.message.create.mockResolvedValue({ id: 'm-auto', createdAt: new Date() })
    m.prisma.inbox.findUnique.mockResolvedValue({ channelType: 'WHATSAPP' })
    setup(m)
    await m.eng.evaluate({ event: 'CONVERSATION_CREATED', accountId: 'acc1', conversationId: 'cv1' })
    return { ...m, status: m.prisma.message.updateMany.mock.calls[0]![0].data.status }
  }

  it('sends it, stamps the wamid and settles SENT', async () => {
    const m = await run()
    expect(m.whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511999990000', 'Recebemos sua mensagem.')
    expect(m.whatsapp.stampOutbound).toHaveBeenCalledWith('m-auto', ['wamid-auto'])
    expect(m.status).toBe('SENT')
    expect(m.realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'MessageCreated', messageId: 'm-auto' }))
  })

  it('no recipient, or a failed send, settles FAILED without failing the rule', async () => {
    expect((await run((m) => m.whatsapp.recipientForConversation.mockResolvedValue(null))).status).toBe('FAILED')
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await run((m) => m.whatsapp.sendOutbound.mockRejectedValue(new Error('131047')))
    expect(failed.status).toBe('FAILED')
    expect((await run((m) => m.whatsapp.sendOutbound.mockRejectedValue('boom'))).status).toBe('FAILED')
    expect(err).toHaveBeenCalledWith('[automation] SEND_REPLY delivery failed for cv1:', 'boom')
  })

  it('a vanished inbox has no channel to push to', async () => {
    const m = await run((mm) => mm.prisma.inbox.findUnique.mockResolvedValue(null))
    expect(m.whatsapp.sendOutbound).not.toHaveBeenCalled()
  })
})

describe('AutomationEngine — unknown action kind', () => {
  it('errors out via the default branch', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'NOT_A_KIND', value: 'x' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toContain('Unknown action kind NOT_A_KIND')
  })

  it('stringifies non-Error throws from action execution', async () => {
    // simulate prisma.team.findUnique rejecting with a non-Error to exercise
    // the inner String(err) path inside runRule.
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ASSIGN_TEAM', value: 'team1' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.team.findUnique.mockRejectedValue('plain-string-thrown')
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.error).toBe('plain-string-thrown')
  })
})

// ─── Multi-action: error short-circuit + actionsExecuted accuracy ───

describe('AutomationEngine — action loop semantics', () => {
  it('records successfully executed actions before failure, stops after error', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [
          { kind: 'ADD_TAG', value: 'first' },
          { kind: 'SET_PRIORITY', value: 'INVALID' },
          { kind: 'ADD_TAG', value: 'never-reached' },
        ],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.actionsExecuted).toEqual([
      { kind: 'ADD_TAG', value: 'first' },
    ])
    expect(r[0]?.error).toContain('Invalid priority INVALID')
  })

  it('does not execute actions when conditions are not all matched', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        conditions: [
          { field: 'INBOX_ID', op: 'equals', value: 'inb1' }, // ✓
          { field: 'PRIORITY', op: 'equals', value: 'URGENT' }, // ✗
        ],
        actions: [{ kind: 'ADD_TAG', value: 'never' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    const r = await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(r[0]?.matched).toBe(false)
    expect(r[0]?.actionsExecuted).toEqual([])
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })
})

// ─── upsert run record — both create and update paths ───────────────

describe('AutomationEngine — automationRuleRun.upsert', () => {
  it('writes run record on first match (create path)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: 'tag' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    expect(prisma.automationRuleRun.upsert).toHaveBeenCalled()
    const arg = prisma.automationRuleRun.upsert.mock.calls[0]![0]
    expect(arg.where.ruleId_conversationId).toEqual({
      ruleId: 'r1',
      conversationId: 'cv1',
    })
    expect(arg.create.matched).toBe(true)
    expect(arg.create.result.actions).toEqual([
      { kind: 'ADD_TAG', value: 'tag' },
    ])
    expect(arg.update.matched).toBe(true)
    expect(arg.update.ranAt).toBeInstanceOf(Date)
  })

  it('writes run record with error payload when action threw', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'SET_PRIORITY', value: 'NOPE' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    const arg = prisma.automationRuleRun.upsert.mock.calls[0]![0]
    expect(arg.create.result.error).toContain('Invalid priority NOPE')
    expect(arg.update.result.error).toContain('Invalid priority NOPE')
  })

  it('does not include error key when no action threw', async () => {
    const { eng, prisma } = makeEngine()
    prisma.automationRule.findMany.mockResolvedValue([
      rule({
        actions: [{ kind: 'ADD_TAG', value: 'tag' }],
      }),
    ])
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    await eng.evaluate({
      event: 'CONVERSATION_CREATED',
      accountId: 'acc1',
      conversationId: 'cv1',
    })
    const arg = prisma.automationRuleRun.upsert.mock.calls[0]![0]
    expect(arg.create.result).not.toHaveProperty('error')
    expect(arg.update.result).not.toHaveProperty('error')
  })
})

// ─── dryRun ──────────────────────────────────────────────────────────

describe('AutomationEngine.dryRun', () => {
  it('returns matched=false with empty arrays when conversation missing', async () => {
    const { eng, prisma } = makeEngine()
    prisma.conversation.findUnique.mockResolvedValue(null)
    const out = await eng.dryRun(rule() as never, 'cv1')
    expect(out).toEqual({
      matched: false,
      conditionResults: [],
      wouldExecute: [],
    })
  })

  it('returns matched=false on cross-account IDOR (conversation accountId mismatch)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.conversation.findUnique.mockResolvedValue({
      ...CONV,
      accountId: 'other',
    })
    const out = await eng.dryRun(rule() as never, 'cv1')
    expect(out.matched).toBe(false)
    expect(out.wouldExecute).toEqual([])
  })

  it('evaluates conditions and returns wouldExecute on match (no Prisma writes)', async () => {
    const { eng, prisma } = makeEngine()
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.message.findFirst.mockResolvedValue({
      id: 'm-latest',
      content: 'wants refund',
      senderType: 'CONTACT',
    })
    const r = rule({
      conditions: [
        { field: 'CONTENT_CONTAINS', op: 'contains', value: 'refund' },
      ],
      actions: [{ kind: 'ADD_TAG', value: 'refund-request' }],
    })
    const out = await eng.dryRun(r as never, 'cv1')
    expect(out.matched).toBe(true)
    expect(out.wouldExecute).toEqual([
      { kind: 'ADD_TAG', value: 'refund-request' },
    ])
    // Critically: NO writes
    expect(prisma.conversation.update).not.toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
    expect(prisma.automationRuleRun.upsert).not.toHaveBeenCalled()
  })

  it('returns matched=false + wouldExecute=[] when a condition fails', async () => {
    const { eng, prisma } = makeEngine()
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.message.findFirst.mockResolvedValue(null)
    const r = rule({
      conditions: [
        { field: 'PRIORITY', op: 'equals', value: 'URGENT' },
      ],
      actions: [{ kind: 'ADD_TAG', value: 'x' }],
    })
    const out = await eng.dryRun(r as never, 'cv1')
    expect(out.matched).toBe(false)
    expect(out.wouldExecute).toEqual([])
    expect(out.conditionResults).toHaveLength(1)
  })

  it('passes a null latestMessage through to evaluateCondition when no messages exist', async () => {
    const { eng, prisma } = makeEngine()
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    prisma.message.findFirst.mockResolvedValue(null)
    const r = rule({
      conditions: [
        { field: 'CONTENT_CONTAINS', op: 'contains', value: 'anything' },
      ],
      actions: [{ kind: 'ADD_TAG', value: 'x' }],
    })
    const out = await eng.dryRun(r as never, 'cv1')
    expect(out.matched).toBe(false) // empty haystack doesn't include 'anything'
  })
})
