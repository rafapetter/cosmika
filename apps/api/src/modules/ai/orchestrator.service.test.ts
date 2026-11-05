import { channelsOver } from '../channels/channels.testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SSRF guard resolves DNS; its rules have their own tests in
// src/common/safe-fetch.test.ts. Only the custom-tool tests below reach it.
vi.mock('../../common/safe-fetch', () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
}))

import { AiTools } from './ai-tools'
import {
  allowanceNotice,
  approvalNotice,
  AWAITING_APPROVAL_RESULT,
  botUnavailableNotice,
  dailyBudgetNotice,
  handoffMessage,
  monthlyBudgetNotice,
  OrchestratorService,
  sanitizeHistory,
  scoreConfidence,
  silentTurnNotice,
} from './orchestrator.service'

// ---------- shared helpers ----------

function makePrisma() {
  return {
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      // The handoff picks an assignee by current load.
      groupBy: vi.fn().mockResolvedValue([]),
    },
    agentBot: {
      findUnique: vi.fn(),
    },
    // The auto-send path resolves the channel + recipient before pushing.
    inbox: { findUnique: vi.fn().mockResolvedValue({ channelType: 'WHATSAPP' }) },
    contact: { findUnique: vi.fn().mockResolvedValue({ phoneNumber: '+5511' }) },
    // Assignee picking on handoff: no inbox members by default.
    inboxMember: { findMany: vi.fn().mockResolvedValue([]) },
    account: { findUnique: vi.fn().mockResolvedValue({ defaultTimezone: 'UTC' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ fullName: 'Ana' }) },
    aiAgentSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentToolCall: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    message: {
      // Unseen conversation messages read before each agent turn.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({
        id: 'msg-new', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
        isPrivate: false, createdAt: new Date(), ...data,
      })),
      // The auto-send path settles the row's status after the channel push.
      update: vi.fn().mockImplementation(({ data }) => Promise.resolve({
        id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
        senderType: 'AGENT_BOT', content: 'x', isPrivate: false,
        createdAt: new Date(), ...data,
      })),
    },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeAnthropic() {
  return {
    isAvailable: vi.fn().mockReturnValue(true),
    createMessage: vi.fn(),
  }
}

type Anthropic = ReturnType<typeof makeAnthropic>

function makeTools(): {
  all: ReturnType<typeof vi.fn>
  byName: ReturnType<typeof vi.fn>
  customToolsForBot: ReturnType<typeof vi.fn>
} {
  // Default: an empty registry. Each test installs concrete tools as needed.
  return {
    all: vi.fn().mockReturnValue([]),
    byName: vi.fn().mockReturnValue(null),
    customToolsForBot: vi.fn().mockReturnValue([]),
  }
}

type Tools = ReturnType<typeof makeTools>

function makeAgentBots() {
  return {
    costLast24h: vi.fn().mockResolvedValue(0),
    monthlyBudgetExceeded: vi
      .fn()
      .mockResolvedValue({ exceeded: false, used: 0, cap: 15 }),
  }
}

type AgentBots = ReturnType<typeof makeAgentBots>

function makeRealtime() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  }
}

type Realtime = ReturnType<typeof makeRealtime>

/** Routing picks (and announces) the assignee now; see AssignmentService. */
function makeAssignment(assigneeId: string | null = 'agent1') {
  return {
    route: vi.fn().mockResolvedValue({ assigneeId, pickedId: assigneeId }),
  }
}
type Assignment = ReturnType<typeof makeAssignment>

function makeWhatsapp() {
  return {
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'w1' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
    resolveRecipient: vi.fn().mockResolvedValue(null),
    recipientForConversation: vi.fn().mockResolvedValue('+5511'),
    messagingWindowFor: vi.fn().mockResolvedValue({
      open: true, lastInboundAt: '2026-08-06T00:00:00.000Z',
      expiresAt: '2026-08-07T00:00:00.000Z',
    }),
  }
}
type Whatsapp = ReturnType<typeof makeWhatsapp>

function makeAiUsage() {
  return { record: vi.fn().mockResolvedValue(0.01) }
}

type AiUsage = ReturnType<typeof makeAiUsage>

/** Default: the allowance never blocks, so existing tests are unaffected. */
function makeAiAllowance() {
  return {
    check: vi.fn().mockResolvedValue({
      allowed: true,
      reason: 'included',
      used: 1,
      included: 300,
      remainingPaid: null,
      enforced: false,
    }),
  }
}

type AiAllowance = ReturnType<typeof makeAiAllowance>

function makeService(
  prisma: Prisma = makePrisma(),
  anthropic: Anthropic = makeAnthropic(),
  tools: Tools = makeTools(),
  agentBots: AgentBots = makeAgentBots(),
  realtime: Realtime = makeRealtime(),
  whatsapp: Whatsapp = makeWhatsapp(),
  assignment: Assignment = makeAssignment(),
  aiUsage: AiUsage = makeAiUsage(),
  aiAllowance: AiAllowance = makeAiAllowance(),
): {
  svc: OrchestratorService
  prisma: Prisma
  anthropic: Anthropic
  tools: Tools
  agentBots: AgentBots
  realtime: Realtime
  whatsapp: Whatsapp
  assignment: Assignment
  aiUsage: AiUsage
  aiAllowance: AiAllowance
} {
  const svc = new OrchestratorService(
    prisma as never,
    anthropic as never,
    tools as never,
    agentBots as never,
    realtime as never,
    channelsOver(whatsapp) as never,
    assignment as never,
    aiUsage as never,
    aiAllowance as never,
  )
  return {
    svc,
    prisma,
    anthropic,
    tools,
    agentBots,
    realtime,
    whatsapp,
    assignment,
    aiUsage,
    aiAllowance,
  }
}

// Default fixtures
const baseBot = {
  id: 'bot1',
  accountId: 'acc1',
  name: 'TestBot',
  model: 'claude-sonnet-4-5',
  systemPrompt: 'You are a helper.',
  temperature: 0.7,
  dailyBudgetUsd: '5.00',
  isActive: true,
  toolsEnabled: null,
  customTools: null,
  autoSafeConfidenceThreshold: 70,
}

function makeBot(overrides: Partial<typeof baseBot> = {}) {
  return { ...baseBot, ...overrides }
}

function makeConversation(
  overrides: Partial<{
    id: string
    contactId: string
    inboxId: string
    controlMode: string
    inbox: { id: string; agentBotId: string | null; aiAutoreplyMode: string }
  }> = {},
) {
  return {
    id: 'conv1',
    contactId: 'contact1',
    inboxId: 'inb1',
    controlMode: 'BOT',
    inbox: {
      id: 'inb1',
      agentBotId: 'bot1',
      aiAutoreplyMode: 'DRAFT',
    },
    ...overrides,
  }
}

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sess1',
    accountId: 'acc1',
    conversationId: 'conv1',
    agentBotId: 'bot1',
    state: { messages: [] },
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: '0',
    lastActiveAt: new Date('2026-05-01T00:00:00Z'),
    createdAt: new Date('2026-04-30T00:00:00Z'),
    ...overrides,
  }
}

function textResponse(text = 'Hello there.') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn' as const,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  }
}

function toolUseResponse(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
) {
  return {
    content: toolUses.map((tu) => ({
      type: 'tool_use' as const,
      id: tu.id,
      name: tu.name,
      input: tu.input,
    })),
    stop_reason: 'tool_use' as const,
    usage: {
      inputTokens: 12,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  }
}

// ---------- handleInbound: early exits ----------

describe('OrchestratorService.handleInbound — early exits', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns silently if the conversation is missing', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    const { svc, anthropic } = makeService(prisma)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv-missing',
      inboundMessageContent: 'hi',
    })
    expect(anthropic.createMessage).not.toHaveBeenCalled()
    expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
  })

  it('returns silently if the inbox has no agentBotId', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({ inbox: { id: 'inb1', agentBotId: null, aiAutoreplyMode: 'DRAFT' } }),
    )
    const { svc, anthropic } = makeService(prisma)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })
    expect(anthropic.createMessage).not.toHaveBeenCalled()
    expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
  })

  it('returns silently if the bot row is missing', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(null)
    const { svc, anthropic } = makeService(prisma)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })
    expect(anthropic.createMessage).not.toHaveBeenCalled()
  })

  it('returns silently if the bot is inactive', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ isActive: false }))
    const { svc, anthropic } = makeService(prisma)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })
    expect(anthropic.createMessage).not.toHaveBeenCalled()
  })

  it('logs a warning and returns when Anthropic client is unavailable', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    const anthropic = makeAnthropic()
    anthropic.isAvailable.mockReturnValue(false)
    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })
    expect(anthropic.createMessage).not.toHaveBeenCalled()
  })
})

// ---------- handleInbound: AI hard stop hands the conversation over ----------

// The bug this suite exists for: the budget guards used to write a SYSTEM
// notice, CLEAR the assignee, and leave controlMode on BOT. The contact got
// silence, the desk's bot filters kept hiding the conversation, and the one
// human who might have seen it was removed from it.
describe('OrchestratorService.handleInbound: AI hard stop', () => {
  let prisma: Prisma
  let agentBots: AgentBots
  let realtime: Realtime

  beforeEach(() => {
    prisma = makePrisma()
    agentBots = makeAgentBots()
    realtime = makeRealtime()
  })

  function overDailyBudget() {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1',
        contactId: 'contact1',
        assigneeId: null,
        controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ dailyBudgetUsd: '1.00' }))
    agentBots.costLast24h.mockResolvedValue(1.5)
  }

  it('moves control to HUMAN and assigns an available agent', async () => {
    overDailyBudget()

    const { svc, anthropic, assignment } = makeService(
      prisma, undefined, undefined, agentBots, realtime,
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(anthropic.createMessage).not.toHaveBeenCalled()
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    // Routing picks who takes it, under the same availability rules as the
    // rest of the app, and writes the assignee entry itself.
    expect(assignment.route).toHaveBeenCalledWith('conv1', 'bot_handoff')
  })

  it('writes the internal note first, then a handoff line to the contact', async () => {
    overDailyBudget()

    const { svc, whatsapp } = makeService(
      prisma, undefined, undefined, agentBots, realtime,
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.message.create).toHaveBeenCalledTimes(2)
    const note = prisma.message.create.mock.calls[0][0].data
    expect(note.senderType).toBe('SYSTEM')
    expect(note.content).toContain('Orçamento diário')

    const toContact = prisma.message.create.mock.calls[1][0].data
    expect(toContact.senderType).toBe('AGENT_BOT')
    expect(toContact.status).toBe('PENDING')
    // Account default locale (pt-BR), matching Nebula's handoff template.
    expect(toContact.content).toBe(
      'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.',
    )
    // It actually goes out on the channel; a row alone is not a reply.
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith(
      'inb1',
      '+5511',
      'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.',
    )
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg-new' },
      data: { status: 'SENT' },
    })
  })

  it('marks the handoff line FAILED when the channel push fails', async () => {
    overDailyBudget()
    const whatsapp = makeWhatsapp()
    whatsapp.recipientForConversation.mockResolvedValue(null)

    const { svc } = makeService(
      prisma, undefined, undefined, agentBots, realtime, whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg-new' },
      data: { status: 'FAILED' },
    })
  })

  it('keeps an assignee who already has the conversation', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1',
        contactId: 'contact1',
        assigneeId: 'user1',
        controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ dailyBudgetUsd: '1.00' }))
    agentBots.costLast24h.mockResolvedValue(1.5)

    const { svc, assignment } = makeService(
      prisma, undefined, undefined, agentBots, realtime, makeWhatsapp(),
      makeAssignment('user1'),
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    // Routing keeps an eligible assignee, so nobody changes hands.
    expect(assignment.route).toHaveBeenCalledWith('conv1', 'bot_handoff')
  })

  it('still moves to HUMAN when the inbox has nobody to assign', async () => {
    overDailyBudget()

    const { svc } = makeService(
      prisma, undefined, undefined, agentBots, realtime, makeWhatsapp(),
      makeAssignment(null),
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    // The contact still hears something.
    expect(prisma.message.create).toHaveBeenCalledTimes(2)
  })

  it('does not repeat the handoff once a human already has it', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1',
        contactId: 'contact1',
        assigneeId: 'user1',
        controlMode: 'HUMAN',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ dailyBudgetUsd: '1.00' }))
    agentBots.costLast24h.mockResolvedValue(1.5)

    const { svc } = makeService(prisma, undefined, undefined, agentBots, realtime)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.conversation.update).not.toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalled()
  })

  it('bails when the conversation vanished between the two reads', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce(null)
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ dailyBudgetUsd: '1.00' }))
    agentBots.costLast24h.mockResolvedValue(2.0)

    const { svc } = makeService(prisma, undefined, undefined, agentBots, realtime)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.message.create).not.toHaveBeenCalled()
    expect(realtime.publish).not.toHaveBeenCalled()
  })

  it('publishes the handoff line even when settling its status throws', async () => {
    overDailyBudget()
    prisma.message.update.mockRejectedValue(new Error('db gone'))

    const { svc } = makeService(prisma, undefined, undefined, agentBots, realtime)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(realtime.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ senderType: 'AGENT_BOT' }),
    )
  })

  it('hands off when the bot row is gone', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1', contactId: 'contact1', assigneeId: null, controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(null)

    const { svc } = makeService(prisma, undefined, undefined, agentBots, realtime)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    expect(prisma.message.create.mock.calls[0][0].data.content).toContain(
      'indisponível',
    )
  })

  it('hands off when the bot is switched off', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1', contactId: 'contact1', assigneeId: null, controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ isActive: false }))

    const { svc, anthropic } = makeService(
      prisma, undefined, undefined, agentBots, realtime,
    )
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(anthropic.createMessage).not.toHaveBeenCalled()
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
  })

  it('hands off when no AI client is configured for the bot model', async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1', contactId: 'contact1', assigneeId: null, controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    const anthropic = makeAnthropic()
    anthropic.isAvailable.mockReturnValue(false)

    const { svc } = makeService(prisma, anthropic, undefined, agentBots, realtime)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi',
    })

    expect(anthropic.createMessage).not.toHaveBeenCalled()
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
  })
})

describe('handoffMessage', () => {
  it('speaks the account language, and never mentions budgets to the contact', () => {
    expect(handoffMessage('en')).toBe(
      "I'm transferring you to our team, who will reply shortly.",
    )
    expect(handoffMessage('es')).toContain('nuestro equipo')
    expect(handoffMessage('pt-BR')).toContain('nossa equipe')
    for (const l of ['en', 'es', 'pt-BR']) {
      expect(handoffMessage(l)).not.toMatch(/budget|orçamento|presupuesto|\$/i)
    }
  })
})

describe('botUnavailableNotice', () => {
  it('covers the three account languages', () => {
    expect(botUnavailableNotice('en')).toContain('unavailable')
    expect(botUnavailableNotice('es')).toContain('no está disponible')
    expect(botUnavailableNotice('pt-BR')).toContain('indisponível')
  })
})

describe('OrchestratorService: session ownership', () => {
  it('claims a session a flow opened before any bot was attached', async () => {
    const prisma = makePrisma()
    const anthropic = makeAnthropic()
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    // A flow's AI block wrote this row first, so it carries spend but no bot.
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({ agentBotId: null, totalCostUsd: '0.42' }),
    )
    prisma.aiAgentSession.update.mockResolvedValue(makeSession())
    anthropic.createMessage.mockResolvedValue(textResponse('Hi'))

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'oi',
    })

    // From now on the bot's daily cap sees what the flow already spent here.
    expect(prisma.aiAgentSession.update).toHaveBeenCalledWith({
      where: { id: 'sess1' },
      data: { agentBotId: 'bot1' },
    })
    expect(prisma.aiAgentSession.create).not.toHaveBeenCalled()
  })
})

// ---------- handleInbound: happy path text reply ----------

describe('OrchestratorService.handleInbound — happy path text', () => {
  let prisma: Prisma
  let anthropic: Anthropic

  beforeEach(() => {
    prisma = makePrisma()
    anthropic = makeAnthropic()
  })

  it('AUTO_FULL auto-sends the AGENT_BOT message', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_FULL' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('Auto reply'))
    const created = {
      id: 'msg1',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'Auto reply',
      isPrivate: false,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    }
    prisma.message.create.mockResolvedValue(created)

    const { svc, realtime } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'hi there',
    })

    expect(prisma.message.create).toHaveBeenCalledTimes(1)
    const args = prisma.message.create.mock.calls[0][0]
    expect(args.data.senderType).toBe('AGENT_BOT')
    // The row starts PENDING and only becomes SENT once the channel
    // push comes back — see the delivery tests below.
    expect(args.data.status).toBe('PENDING')
    expect(args.data.isPrivate).toBeUndefined()
    expect(args.data.content).toBe('Auto reply')
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg1', senderType: 'AGENT_BOT' }),
    )
    expect(prisma.aiAgentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess1' },
        data: expect.objectContaining({
          totalTokensIn: { increment: 10 },
          totalTokensOut: { increment: 5 },
        }),
      }),
    )
  })

  it('AUTO_SAFE above-threshold auto-sends', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_SAFE' },
      }),
    )
    // confident reply: no tools, short text, no uncertainty → 100 ≥ 70 threshold
    prisma.agentBot.findUnique.mockResolvedValue(makeBot({ autoSafeConfidenceThreshold: 70 }))
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('Sure thing.'))
    prisma.message.create.mockResolvedValue({
      id: 'msg1',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'Sure thing.',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    const args = prisma.message.create.mock.calls[0][0]
    expect(args.data.senderType).toBe('AGENT_BOT')
    // The row starts PENDING and only becomes SENT once the channel
    // push comes back — see the delivery tests below.
    expect(args.data.status).toBe('PENDING')
  })

  it('AUTO_SAFE below-threshold falls back to draft', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_SAFE' },
      }),
    )
    // threshold 90 vs uncertain reply scoring < 90
    prisma.agentBot.findUnique.mockResolvedValue(
      makeBot({ autoSafeConfidenceThreshold: 90 }),
    )
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(
      textResponse('Maybe I should check on this for you.'),
    )
    prisma.message.create.mockResolvedValue({
      id: 'msg-draft',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: '[draft] Maybe I should check on this for you.',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    const args = prisma.message.create.mock.calls[0][0]
    expect(args.data.status).toBe('PENDING')
    expect(args.data.isPrivate).toBe(true)
    expect(args.data.content).toMatch(/^\[draft\] /)
  })

  it('keeps prose the model wrote before a tool call, not just the last turn', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    // Answer the documented half, then escalate the rest — the answer rides
    // along with the tool call and used to be thrown away.
    anthropic.createMessage
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'A janela de 24h abre quando o cliente escreve.' },
          { type: 'tool_use', id: 'tu1', name: 'attach_tag', input: { tag: 'financeiro' } },
        ],
        stop_reason: 'tool_use' as const,
        usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      .mockResolvedValueOnce(textResponse('Valores quem responde é o financeiro.'))
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: true, createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'regra 24h? tem custo?',
    })

    expect(prisma.message.create.mock.calls[0][0].data.content).toBe(
      '[draft] A janela de 24h abre quando o cliente escreve.\n\nValores quem responde é o financeiro.',
    )
  })

  it('does not repeat a closing line the model restates in its final turn', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Já encaminhei para o time.' },
          { type: 'tool_use', id: 'tu1', name: 'attach_tag', input: { tag: 'suporte' } },
        ],
        stop_reason: 'tool_use' as const,
        usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      .mockResolvedValueOnce(textResponse('Já encaminhei para o time.'))
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: true, createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    expect(prisma.message.create.mock.calls[0][0].data.content).toBe(
      '[draft] Já encaminhei para o time.',
    )
  })

  it('stands down when the account has spent its monthly AI budget', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    const { svc, agentBots } = makeService(prisma, anthropic)
    agentBots.monthlyBudgetExceeded.mockResolvedValue({
      exceeded: true, used: 15.4, cap: 15,
    })
    prisma.message.create.mockResolvedValue({
      id: 'm1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'SYSTEM', content: 'x', isPrivate: false, createdAt: new Date(),
    })

    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'oi',
    })

    // The model is never called, and the reason names both numbers.
    expect(anthropic.createMessage).not.toHaveBeenCalled()
expect(prisma.message.create.mock.calls[0][0].data.content).toContain(
      '$15.40 de $15.00',
    )
    // The daily check is skipped entirely once the month is spent.
    expect(agentBots.costLast24h).not.toHaveBeenCalled()
  })

  // These are the tests that were missing: the old suite asserted a Message
  // row existed and called that "sent". The orchestrator had no channel
  // dependency at all, so every auto-reply was written to the thread and
  // never delivered to the contact.
  const autoSendSetup = () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_FULL' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('Olá!'))
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'Olá!', isPrivate: false, createdAt: new Date(),
    })
  }

  it('pushes the auto-sent reply to the contact channel', async () => {
    autoSendSetup()
    const { svc, whatsapp } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511', 'Olá!')
  })

  it('falls back to the BSUID when the contact has no phone number', async () => {
    autoSendSetup()
    const whatsapp = makeWhatsapp()
    whatsapp.recipientForConversation.mockResolvedValue('bsuid-123')
    const { svc } = makeService(
      prisma, anthropic, makeTools(), makeAgentBots(), makeRealtime(), whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', 'bsuid-123', 'Olá!')
  })

  it('marks FAILED when there is no recipient at all', async () => {
    autoSendSetup()
    const { svc, whatsapp } = makeService(prisma, anthropic)
    whatsapp.recipientForConversation.mockResolvedValue(null)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('treats a pull-based channel as delivered without pushing', async () => {
    autoSendSetup()
    prisma.inbox.findUnique.mockResolvedValue({ channelType: 'WEB_WIDGET' })
    const { svc, whatsapp } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'SENT' },
    })
  })

  it('marks FAILED when the inbox has vanished', async () => {
    autoSendSetup()
    prisma.inbox.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('settles the row to SENT once the channel accepts it', async () => {
    autoSendSetup()
    const { svc, prisma: p, realtime } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(p.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'SENT' },
    })
    // The thread only ever sees the settled status, never the optimistic one.
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg1' }),
    )
  })

  it('marks the reply FAILED when the channel rejects it', async () => {
    autoSendSetup()
    const whatsapp = makeWhatsapp()
    whatsapp.sendOutbound.mockRejectedValue(new Error('Meta down'))
    const { svc } = makeService(
      prisma, anthropic, makeTools(), makeAgentBots(), makeRealtime(), whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('reports a non-Error channel throw as a failure too', async () => {
    autoSendSetup()
    const whatsapp = makeWhatsapp()
    whatsapp.sendOutbound.mockRejectedValue('boom')
    const { svc } = makeService(
      prisma, anthropic, makeTools(), makeAgentBots(), makeRealtime(), whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('still publishes the reply when settling the status fails', async () => {
    autoSendSetup()
    prisma.message.update.mockRejectedValue(new Error('db down'))
    const { svc, realtime } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg1', senderType: 'AGENT_BOT' }),
    )
  })

  it('keeps the reply but does not send it once the 24h window has closed', async () => {
    autoSendSetup()
    const whatsapp = makeWhatsapp()
    whatsapp.messagingWindowFor.mockResolvedValue({
      open: false,
      lastInboundAt: '2026-08-04T00:00:00.000Z',
      expiresAt: '2026-08-05T00:00:00.000Z',
    })
    const { svc } = makeService(
      prisma, anthropic, makeTools(), makeAgentBots(), makeRealtime(), whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    // Outside the window only a template may be sent, so we don't spend a
    // Cloud API call to be rejected...
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    // ...but the answer stays in the thread for a human to send via template.
    expect(prisma.message.create).toHaveBeenCalled()
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('treats a conversation the customer never wrote to as no window at all', async () => {
    autoSendSetup()
    const whatsapp = makeWhatsapp()
    // No inbound ever → no window was opened, so there is nothing to send into.
    whatsapp.messagingWindowFor.mockResolvedValue({
      open: false, lastInboundAt: null, expiresAt: null,
    })
    const { svc } = makeService(
      prisma, anthropic, makeTools(), makeAgentBots(), makeRealtime(), whatsapp,
    )
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg1' }, data: { status: 'FAILED' },
    })
  })

  it('does not push a draft to the channel', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('Sugestão.'))
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: '[draft] Sugestão.', isPrivate: true,
      createdAt: new Date(),
    })
    const { svc, whatsapp } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: 'oi',
    })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('never auto-sends once the conversation is under human control', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        controlMode: 'HUMAN',
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_FULL' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('Sure thing.'))
    prisma.message.create.mockResolvedValue({
      id: 'msg-draft',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: '[draft] Sure thing.',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    // The human owns the channel — the bot only leaves a private suggestion.
    const args = prisma.message.create.mock.calls[0][0]
    expect(args.data.isPrivate).toBe(true)
    expect(args.data.status).toBe('PENDING')
  })

  it('DRAFT mode always saves a draft message', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'DRAFT' },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('A reply'))
    prisma.message.create.mockResolvedValue({
      id: 'msg-draft',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: '[draft] A reply',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    const args = prisma.message.create.mock.calls[0][0]
    expect(args.data.isPrivate).toBe(true)
    expect(args.data.status).toBe('PENDING')
  })

  it('returns early without creating a message when the LLM reply is empty/whitespace', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue({
      content: [{ type: 'text', text: '   ' }],
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    expect(prisma.message.create).not.toHaveBeenCalled()
    // But the session is still persisted with the assistant turn
    expect(prisma.aiAgentSession.update).toHaveBeenCalledTimes(1)
  })

  it('returns early when the LLM reply has no text blocks at all', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue({
      // stop_reason isn't tool_use, but there's no text either → finalText = null
      content: [],
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    expect(prisma.message.create).not.toHaveBeenCalled()
  })
})

// ---------- handleInbound: tool calls ----------

describe('OrchestratorService.handleInbound — tool calls', () => {
  let prisma: Prisma
  let anthropic: Anthropic
  let tools: Tools

  beforeEach(() => {
    prisma = makePrisma()
    anthropic = makeAnthropic()
    tools = makeTools()
  })

  function setupConvAndBot(
    botOverrides: Partial<typeof baseBot> = {},
    mode = 'AUTO_FULL',
  ) {
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: mode },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot(botOverrides))
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    prisma.agentToolCall.create.mockResolvedValue({ id: 'tc1' })
    prisma.message.create.mockResolvedValue({
      id: 'msg-out',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'final',
      isPrivate: false,
      createdAt: new Date(),
    })
  }

  it('executes a non-destructive tool, feeds result back, then completes', async () => {
    setupConvAndBot({ knowledgeTags: ['financeiro'] } as never)
    const attachTag = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockResolvedValue({
        output: { ok: true, tags: ['vip'] },
        durationMs: 12,
      }),
    }
    tools.all.mockReturnValue([attachTag])
    tools.byName.mockImplementation((name: string) =>
      name === 'attach_tag' ? attachTag : null,
    )
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'attach_tag', input: { tag: 'vip' } }]),
      )
      .mockResolvedValueOnce(textResponse('Tag attached.'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'tag please',
    })

    expect(attachTag.handler).toHaveBeenCalledTimes(1)
    // The agent's own knowledge base travels with every tool call.
    expect(attachTag.handler.mock.calls[0]![1]).toEqual({
      accountId: 'acc1', conversationId: 'conv1', contactId: 'contact1', knowledgeTags: ['financeiro'],
    })
    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          durationMs: 12,
          toolName: 'attach_tag',
        }),
      }),
    )
    expect(anthropic.createMessage).toHaveBeenCalledTimes(2)
    expect(prisma.message.create).toHaveBeenCalled()
  })

  it('records ERROR + feeds error back when a non-destructive tool handler throws an Error', async () => {
    setupConvAndBot()
    const broken = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockRejectedValue(new Error('boom')),
    }
    tools.all.mockReturnValue([broken])
    tools.byName.mockReturnValue(broken)
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'attach_tag', input: {} }]),
      )
      .mockResolvedValueOnce(textResponse('Sorry, that errored.'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'tag please',
    })

    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorMessage: 'boom',
        }),
      }),
    )
  })

  it('records ERROR with stringified value when handler throws a non-Error', async () => {
    setupConvAndBot()
    const broken = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockRejectedValue('plain-string-fail'),
    }
    tools.all.mockReturnValue([broken])
    tools.byName.mockReturnValue(broken)
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'attach_tag', input: {} }]),
      )
      .mockResolvedValueOnce(textResponse('done'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'tag',
    })

    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorMessage: 'plain-string-fail',
        }),
      }),
    )
  })

  it('queues a destructive tool as PENDING and surfaces a SYSTEM approval message', async () => {
    setupConvAndBot()
    const destructive = {
      name: 'assign_conversation_to_human',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([destructive])
    tools.byName.mockReturnValue(destructive)
    anthropic.createMessage.mockResolvedValueOnce(
      toolUseResponse([
        {
          id: 'tu-d',
          name: 'assign_conversation_to_human',
          input: { reason: 'needs human' },
        },
      ]),
    )
    prisma.message.create.mockResolvedValue({
      id: 'msg-approval',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'SYSTEM',
      content: '🤖 needs approval',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc, realtime } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'do it',
    })

    expect(destructive.handler).not.toHaveBeenCalled()
    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    )
    expect(prisma.message.create).toHaveBeenCalledTimes(1)
    expect(prisma.message.create.mock.calls[0][0].data.senderType).toBe('SYSTEM')
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-approval' }),
    )
    // The queued call is answered by a placeholder, so the contact's next
    // message doesn't hit a 400 on an unanswered tool_use.
    const persisted =
      prisma.aiAgentSession.update.mock.calls[0][0].data.state.messages
    expect(persisted[persisted.length - 1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-d',
          content: AWAITING_APPROVAL_RESULT,
        },
      ],
    })
    expect(prisma.agentToolCall.create.mock.calls[0][0].data.toolUseId).toBe('tu-d')
  })

  it('records ERROR + tool_result error when the model calls a tool that is not enabled (toolsEnabled allowlist)', async () => {
    // Only `attach_tag` enabled; model picks `set_priority`
    setupConvAndBot({
      toolsEnabled: [{ name: 'attach_tag' }],
    } as never)
    const attachTag = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    const setPriority = {
      name: 'set_priority',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    // .all() includes both → the requested set_priority will be found by name but is not allowed
    tools.all.mockReturnValue([attachTag, setPriority])
    tools.byName.mockImplementation((name: string) =>
      name === 'attach_tag'
        ? attachTag
        : name === 'set_priority'
        ? setPriority
        : null,
    )
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'set_priority', input: {} }]),
      )
      .mockResolvedValueOnce(textResponse('Sorry, that tool is off.'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'pri high',
    })

    expect(setPriority.handler).not.toHaveBeenCalled()
    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorMessage: 'Tool set_priority not enabled',
        }),
      }),
    )
  })

  it('records ERROR when the model invokes an unknown tool (def is null)', async () => {
    setupConvAndBot({
      toolsEnabled: [{ name: 'attach_tag' }],
    } as never)
    const attachTag = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([attachTag])
    // .byName returns null for the bogus tool, no custom entry either → def is null
    tools.byName.mockReturnValue(null)
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'bogus_tool', input: {} }]),
      )
      .mockResolvedValueOnce(textResponse('ok'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'bogus',
    })

    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorMessage: 'Tool bogus_tool not enabled',
        }),
      }),
    )
  })

  it('runs a custom-tool handler when the model invokes it', async () => {
    setupConvAndBot({ customTools: [{ name: 'my_hook' }] } as never)
    const customDef = {
      name: 'my_hook',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockResolvedValue({ output: { ok: true }, durationMs: 7 }),
    }
    // built-in tools = []; customToolsForBot returns my_hook → toolPool has it
    tools.all.mockReturnValue([])
    tools.customToolsForBot.mockReturnValue([customDef])
    tools.byName.mockReturnValue(null)
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'my_hook', input: { k: 'v' } }]),
      )
      .mockResolvedValueOnce(textResponse('done'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'go',
    })

    expect(customDef.handler).toHaveBeenCalled()
    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          durationMs: 7,
          toolName: 'my_hook',
        }),
      }),
    )
  })

  it('records SUCCESS with durationMs=null when the handler returns no durationMs', async () => {
    setupConvAndBot()
    const tool = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockResolvedValue({ output: { ok: true } }),
    }
    tools.all.mockReturnValue([tool])
    tools.byName.mockReturnValue(tool)
    anthropic.createMessage
      .mockResolvedValueOnce(
        toolUseResponse([{ id: 'tu1', name: 'attach_tag', input: {} }]),
      )
      .mockResolvedValueOnce(textResponse('ok'))

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })

    expect(prisma.agentToolCall.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCESS',
          durationMs: null,
        }),
      }),
    )
  })

  it('stops the loop early when only destructive tools were queued (toolResults empty after queueing)', async () => {
    setupConvAndBot()
    const destructive = {
      name: 'assign_conversation_to_human',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([destructive])
    tools.byName.mockReturnValue(destructive)
    // Only destructive tool, no other tools → queued=true triggers break,
    // pendingDestructive surfaces a SYSTEM message and returns.
    anthropic.createMessage.mockResolvedValueOnce(
      toolUseResponse([
        {
          id: 'tu1',
          name: 'assign_conversation_to_human',
          input: { reason: 'r' },
        },
      ]),
    )
    prisma.message.create.mockResolvedValue({
      id: 'msg-q',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'SYSTEM',
      content: '🤖',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'do it',
    })

    expect(anthropic.createMessage).toHaveBeenCalledTimes(1)
    expect(prisma.message.create).toHaveBeenCalledTimes(1)
  })

  it('passes only the enabled built-in toolDefs to anthropic.createMessage', async () => {
    setupConvAndBot({ toolsEnabled: [{ name: 'attach_tag' }] } as never)
    const attachTag = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    const setPriority = {
      name: 'set_priority',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([attachTag, setPriority])
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.message.create.mockResolvedValue({
      id: 'msg',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })

    const args = anthropic.createMessage.mock.calls[0][0]
    expect(args.tools.map((t: { name: string }) => t.name)).toEqual(['attach_tag'])
  })

  it('exposes all built-in tools when toolsEnabled is null (default-on)', async () => {
    setupConvAndBot({ toolsEnabled: null })
    const a = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    const b = {
      name: 'set_priority',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([a, b])
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.message.create.mockResolvedValue({
      id: 'msg',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })
    const args = anthropic.createMessage.mock.calls[0][0]
    expect(args.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'attach_tag',
      'set_priority',
    ])
  })

  it('exposes all built-in tools when toolsEnabled is an empty array', async () => {
    setupConvAndBot({ toolsEnabled: [] } as never)
    const a = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([a])
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.message.create.mockResolvedValue({
      id: 'msg',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })
    const args = anthropic.createMessage.mock.calls[0][0]
    expect(args.tools.map((t: { name: string }) => t.name)).toEqual(['attach_tag'])
  })

  it('treats a non-array toolsEnabled as default-on', async () => {
    // Some legacy DB rows might have a non-array shape stored — the helper
    // should fall back to the full toolset.
    setupConvAndBot({ toolsEnabled: { not: 'an array' } } as never)
    const a = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn(),
    }
    tools.all.mockReturnValue([a])
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.message.create.mockResolvedValue({
      id: 'msg',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: false,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })
    const args = anthropic.createMessage.mock.calls[0][0]
    expect(args.tools.map((t: { name: string }) => t.name)).toEqual(['attach_tag'])
  })

  it('hits MAX_TOOL_LOOP_ITERATIONS (6) and exits without final text', async () => {
    setupConvAndBot()
    const tool = {
      name: 'attach_tag',
      description: 'd',
      input_schema: {},
      destructive: false,
      handler: vi.fn().mockResolvedValue({ output: { ok: true }, durationMs: 1 }),
    }
    tools.all.mockReturnValue([tool])
    tools.byName.mockReturnValue(tool)
    // Every iteration returns tool_use, never end_turn
    anthropic.createMessage.mockResolvedValue(
      toolUseResponse([{ id: 'tu', name: 'attach_tag', input: {} }]),
    )

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })

    expect(anthropic.createMessage).toHaveBeenCalledTimes(6)
    // No final text → no message created
    expect(prisma.message.create).not.toHaveBeenCalled()
    expect(prisma.aiAgentSession.update).toHaveBeenCalledTimes(1)
  })

  it('treats stop_reason=tool_use with empty content as a text turn (joins to empty → no message)', async () => {
    setupConvAndBot()
    anthropic.createMessage.mockResolvedValue({
      content: [],
      stop_reason: 'tool_use',
      usage: {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    const { svc } = makeService(prisma, anthropic, tools)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'x',
    })

    // stop_reason=tool_use but toolUses.length===0 → falls into the "final text" branch
    expect(anthropic.createMessage).toHaveBeenCalledTimes(1)
    expect(prisma.message.create).not.toHaveBeenCalled()
  })
})

// ---------- handleInbound: history & session ----------

describe('OrchestratorService.handleInbound — history & session', () => {
  let prisma: Prisma
  let anthropic: Anthropic

  beforeEach(() => {
    prisma = makePrisma()
    anthropic = makeAnthropic()
  })

  it('truncates persisted history to the last MAX_HISTORY_TURNS turns', async () => {
    // 30 prior turns + 1 new user turn + 1 assistant turn = 32 → truncate to last 30
    const priorMessages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
    }))
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({ state: { messages: priorMessages } }),
    )
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.message.create.mockResolvedValue({
      id: 'msg',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'newest',
    })

    // The createMessage call should see the truncated history
    const sentMessages = anthropic.createMessage.mock.calls[0][0].messages
    expect(sentMessages.length).toBe(30)
    // Final element is the inbound user message
    expect(sentMessages[29].content[0].text).toBe('newest')

    // Persisted state is also capped at 30
    const updateArgs = prisma.aiAgentSession.update.mock.calls[0][0]
    expect(updateArgs.data.state.messages.length).toBe(30)
  })

  it('uses existing session messages from state when available', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({
        state: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
          ],
        },
      }),
    )
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('reply'))
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'reply',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'next',
    })

    const sent = anthropic.createMessage.mock.calls[0][0].messages
    expect(sent[0].content[0].text).toBe('earlier')
    expect(sent[1].content[0].text).toBe('next')
  })

  it('creates a fresh session when none exists', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('reply'))
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'reply',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    expect(prisma.aiAgentSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: 'acc1',
          conversationId: 'conv1',
          agentBotId: 'bot1',
        }),
      }),
    )
  })

  it('treats null/non-object state as empty history', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({ state: null }),
    )
    prisma.aiAgentSession.update.mockResolvedValue({})
    // Snapshot the messages at call time — truncateHistory returns the
    // original array reference when below the cap, and the loop later
    // mutates it, so we can't read it post-hoc.
    let snapshot: unknown[] = []
    anthropic.createMessage.mockImplementation(async (opts: { messages: unknown[] }) => {
      snapshot = JSON.parse(JSON.stringify(opts.messages))
      return textResponse('r')
    })
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'r',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    // Only the new user turn — no prior messages because state was null
    expect(snapshot.length).toBe(1)
  })

  it('treats state with non-array messages field as empty history', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({ state: { messages: 'not-an-array' } }),
    )
    prisma.aiAgentSession.update.mockResolvedValue({})
    let snapshot: unknown[] = []
    anthropic.createMessage.mockImplementation(async (opts: { messages: unknown[] }) => {
      snapshot = JSON.parse(JSON.stringify(opts.messages))
      return textResponse('r')
    })
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'r',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    expect(snapshot.length).toBe(1)
  })

  it('echoes the assistant turn (text + tool_use blocks) back into history', async () => {
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    // Mixed response: one text block + one tool_use block; stop_reason=end_turn → loop exits.
    anthropic.createMessage.mockResolvedValue({
      content: [
        { type: 'text', text: 'thinking…' },
        { type: 'tool_use', id: 'tu1', name: 'whatever', input: { x: 1 } },
      ],
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: '[draft] thinking…',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    const persisted = prisma.aiAgentSession.update.mock.calls[0][0].data.state.messages
    const lastAssistant = persisted.filter((m: { role: string }) => m.role === 'assistant').pop()
    expect(lastAssistant.content).toEqual([
      { type: 'text', text: 'thinking…' },
      { type: 'tool_use', id: 'tu1', name: 'whatever', input: { x: 1 } },
    ])
    // `end_turn` alongside a tool_use leaves the call unanswered; persisting it
    // that way would 400 every later turn, so a stand-in result closes it.
    expect(persisted[persisted.length - 1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'Result unavailable.' },
      ],
    })
  })
})

// ---------- confirmToolCalls ----------

describe('OrchestratorService.confirmToolCalls', () => {
  let prisma: Prisma
  let tools: Tools

  beforeEach(() => {
    prisma = makePrisma()
    tools = makeTools()
  })

  it('returns [] when no session exists for the conversation', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(out).toEqual([])
  })

  it('returns [] when no matching PENDING tool calls are found', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(out).toEqual([])
  })

  it('returns [] when conversation lookup fails (e.g. deleted mid-confirm)', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'attach_tag', input: { tag: 'x' } },
    ])
    prisma.conversation.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(out).toEqual([])
  })

  it('REJECT sets status=REJECTED on all matching calls', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'a', input: {} },
      { id: 'tc2', toolName: 'b', input: {} },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    prisma.agentToolCall.update
      .mockResolvedValueOnce({ id: 'tc1', status: 'REJECTED' })
      .mockResolvedValueOnce({ id: 'tc2', status: 'REJECTED' })

    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1', 'tc2'],
      decision: 'REJECT',
    })
    expect(out).toHaveLength(2)
    expect(prisma.agentToolCall.update).toHaveBeenCalledTimes(2)
    expect(prisma.agentToolCall.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'tc1' },
      data: { status: 'REJECTED' },
    })
  })

  it('CONFIRM marks status=ERROR when the tool def is no longer registered', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'gone_tool', input: {} },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    prisma.agentToolCall.update.mockResolvedValue({
      id: 'tc1',
      status: 'ERROR',
      errorMessage: 'Tool no longer registered',
    })
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(out).toHaveLength(1)
    expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'tc1' },
      data: { status: 'ERROR', errorMessage: 'Tool no longer registered' },
    })
  })

  it('CONFIRM runs the handler and marks status=CONFIRMED with output + durationMs', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'assign_to_human', input: { reason: 'r' } },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    const def = {
      name: 'assign_to_human',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn().mockResolvedValue({
        output: { ok: true, assigneeCleared: true },
        durationMs: 42,
      }),
    }
    tools.all.mockReturnValue([def])
    prisma.agentToolCall.update.mockResolvedValue({ id: 'tc1', status: 'CONFIRMED' })

    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })

    expect(def.handler).toHaveBeenCalledWith(
      { reason: 'r' },
      expect.objectContaining({ accountId: 'acc1', conversationId: 'conv1', contactId: 'contact1' }),
      expect.objectContaining({ prisma: expect.anything() }),
    )
    expect(out).toHaveLength(1)
    expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'tc1' },
      data: {
        status: 'CONFIRMED',
        output: { ok: true, assigneeCleared: true },
        durationMs: 42,
      },
    })
  })

  it('CONFIRM uses {} when call.input is null', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'a', input: null },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    const def = {
      name: 'a',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn().mockResolvedValue({ output: { ok: true } }),
    }
    tools.all.mockReturnValue([def])
    prisma.agentToolCall.update.mockResolvedValue({ id: 'tc1' })

    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })

    expect(def.handler).toHaveBeenCalledWith({}, expect.anything(), expect.anything())
    // durationMs missing on handler result → stored as null
    expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'tc1' },
      data: { status: 'CONFIRMED', output: { ok: true }, durationMs: null },
    })
  })

  it('CONFIRM stores status=ERROR with err.message when the handler throws an Error', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'a', input: {} },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    const def = {
      name: 'a',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn().mockRejectedValue(new Error('whoops')),
    }
    tools.all.mockReturnValue([def])
    prisma.agentToolCall.update.mockResolvedValue({ id: 'tc1' })

    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'tc1' },
      data: { status: 'ERROR', errorMessage: 'whoops' },
    })
  })

  it('CONFIRM stringifies non-Error throws', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.agentToolCall.findMany.mockResolvedValue([
      { id: 'tc1', toolName: 'a', input: {} },
    ])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    const def = {
      name: 'a',
      description: 'd',
      input_schema: {},
      destructive: true,
      handler: vi.fn().mockRejectedValue('bad-string'),
    }
    tools.all.mockReturnValue([def])
    prisma.agentToolCall.update.mockResolvedValue({ id: 'tc1' })

    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'tc1' },
      data: { status: 'ERROR', errorMessage: 'bad-string' },
    })
  })

  // Since no built-in tool is destructive, a custom tool is the only thing
  // that ever reaches this path. These run the real AiTools, so the tool is
  // found (or not) the way it is in production: from the bot's customTools.
  describe('custom tools of the session bot', () => {
    const refundTool = {
      name: 'refund_order',
      description: 'Refund an order',
      input_schema: { type: 'object', properties: { orderId: { type: 'string' } } },
      destructive: true,
      webhook: { url: 'https://tools.example.com/refund' },
    }
    let fetchSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ refunded: true }),
      } as Response)
      prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
      prisma.agentToolCall.findMany.mockResolvedValue([
        { id: 'tc1', toolName: 'refund_order', input: { orderId: 'o1' } },
      ])
      prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
      prisma.agentToolCall.update.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'tc1', ...data }),
      )
    })

    afterEach(() => {
      fetchSpy.mockRestore()
    })

    function makeServiceWithRealTools() {
      const realTools = new AiTools(prisma as never, {} as never, {} as never)
      return makeService(prisma, undefined, realTools as never)
    }

    const confirm = (svc: OrchestratorService, decision: 'CONFIRM' | 'REJECT' = 'CONFIRM') =>
      svc.confirmToolCalls({
        accountId: 'acc1',
        conversationId: 'conv1',
        toolCallIds: ['tc1'],
        decision,
      })

    it('CONFIRM calls the webhook of a custom tool declared on the bot', async () => {
      prisma.agentBot.findUnique.mockResolvedValue({ customTools: [refundTool] })
      const { svc } = makeServiceWithRealTools()

      const out = await confirm(svc)

      // The bot is the one the session belongs to.
      expect(prisma.agentBot.findUnique).toHaveBeenCalledWith({
        where: { id: 'bot1' },
        select: { customTools: true },
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0]!
      expect(url).toBe('https://tools.example.com/refund')
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        tool: 'refund_order',
        input: { orderId: 'o1' },
        context: { accountId: 'acc1', conversationId: 'conv1', contactId: 'contact1' },
      })
      expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
        where: { id: 'tc1' },
        data: {
          status: 'CONFIRMED',
          output: { ok: true, refunded: true },
          durationMs: expect.any(Number),
        },
      })
      expect(out).toEqual([expect.objectContaining({ id: 'tc1', status: 'CONFIRMED' })])
    })

    it('CONFIRM errors when the tool was removed from the bot since it was queued', async () => {
      prisma.agentBot.findUnique.mockResolvedValue({
        customTools: [{ ...refundTool, name: 'another_tool' }],
      })
      const { svc } = makeServiceWithRealTools()

      await confirm(svc)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
        where: { id: 'tc1' },
        data: { status: 'ERROR', errorMessage: 'Tool no longer registered' },
      })
    })

    it('CONFIRM errors when the bot itself is gone', async () => {
      prisma.agentBot.findUnique.mockResolvedValue(null)
      const { svc } = makeServiceWithRealTools()

      await confirm(svc)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
        where: { id: 'tc1' },
        data: { status: 'ERROR', errorMessage: 'Tool no longer registered' },
      })
    })

    it('CONFIRM errors on a session that has no bot, without looking one up', async () => {
      prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession({ agentBotId: null }))
      const { svc } = makeServiceWithRealTools()

      await confirm(svc)

      expect(prisma.agentBot.findUnique).not.toHaveBeenCalled()
      expect(prisma.agentToolCall.update).toHaveBeenCalledWith({
        where: { id: 'tc1' },
        data: { status: 'ERROR', errorMessage: 'Tool no longer registered' },
      })
    })

    it('REJECT never reaches the webhook', async () => {
      prisma.agentBot.findUnique.mockResolvedValue({ customTools: [refundTool] })
      const { svc } = makeServiceWithRealTools()

      const out = await confirm(svc, 'REJECT')

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(out).toEqual([expect.objectContaining({ id: 'tc1', status: 'REJECTED' })])
    })
  })
})

// ---------- toToolCallDTO ----------

describe('OrchestratorService.toToolCallDTO', () => {
  it('maps a fully populated AgentToolCall', () => {
    const { svc } = makeService()
    const out = svc.toToolCallDTO({
      id: 'tc1',
      sessionId: 'sess1',
      toolName: 'attach_tag',
      input: { tag: 'vip' },
      output: { ok: true },
      errorMessage: null,
      status: 'SUCCESS',
      costUsd: '0.01',
      durationMs: 12,
      createdAt: new Date('2026-05-01T01:02:03Z'),
    } as never)
    expect(out).toEqual({
      id: 'tc1',
      sessionId: 'sess1',
      toolName: 'attach_tag',
      input: { tag: 'vip' },
      output: { ok: true },
      errorMessage: null,
      status: 'SUCCESS',
      costUsd: 0.01,
      durationMs: 12,
      createdAt: '2026-05-01T01:02:03.000Z',
    })
  })

  it('coerces null input/output to default shapes', () => {
    const { svc } = makeService()
    const out = svc.toToolCallDTO({
      id: 'tc1',
      sessionId: 'sess1',
      toolName: 't',
      input: null,
      output: null,
      errorMessage: 'err',
      status: 'ERROR',
      costUsd: '0',
      durationMs: null,
      createdAt: new Date('2026-05-01T00:00:00Z'),
    } as never)
    expect(out.input).toEqual({})
    expect(out.output).toBeNull()
  })
})

// ---------- getSessionView ----------

describe('OrchestratorService.getSessionView', () => {
  let prisma: Prisma

  beforeEach(() => {
    prisma = makePrisma()
  })

  it('returns null session + empty calls when no session exists', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    const out = await svc.getSessionView('conv1')
    expect(out).toEqual({ session: null, recentToolCalls: [] })
  })

  it('returns session metadata + last 10 tool calls', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({
        totalTokensIn: 100,
        totalTokensOut: 50,
        totalCostUsd: '0.25',
      }),
    )
    prisma.agentToolCall.findMany.mockResolvedValue([
      {
        id: 'tc1',
        sessionId: 'sess1',
        toolName: 'attach_tag',
        input: {},
        output: { ok: true },
        errorMessage: null,
        status: 'SUCCESS',
        costUsd: '0',
        durationMs: 5,
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
    ])

    const { svc } = makeService(prisma)
    const out = await svc.getSessionView('conv1')
    expect(out.session).toMatchObject({
      id: 'sess1',
      conversationId: 'conv1',
      agentBotId: 'bot1',
      totalTokensIn: 100,
      totalTokensOut: 50,
      totalCostUsd: 0.25,
    })
    expect(out.recentToolCalls).toHaveLength(1)
    expect(out.recentToolCalls[0].id).toBe('tc1')
    // findMany should have been called with take=10
    expect(prisma.agentToolCall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: 'sess1' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    )
  })
})

// ---------- scoreConfidence (exported helper) ----------

describe('scoreConfidence', () => {
  const KB = [{ name: 'search_knowledge_base' }, { name: 'read_knowledge_base_article' }]

  it('returns 0 for empty / whitespace text', () => {
    expect(scoreConfidence('', [])).toEqual({ score: 0, reasons: ['empty'] })
    expect(scoreConfidence('   \n\t  ', [])).toEqual({ score: 0, reasons: ['empty'] })
  })

  it('rewards a reply the model actually looked up', () => {
    const grounded = scoreConfidence('Vá em Canais > WhatsApp > Templates.', KB)
    const invented = scoreConfidence('Vá em Canais > WhatsApp > Templates.', [])
    // The whole point of the rework: consulting the knowledge base must not
    // score lower than asserting from memory.
    expect(grounded.score).toBeGreaterThan(invented.score)
    expect(grounded.score).toBe(100)
    expect(grounded.reasons).toContain('grounded in the knowledge base')
  })

  it('leaves a short conversational reply neutral', () => {
    // A greeting or a clarifying question makes no claim — nothing to check.
    const r = scoreConfidence('Oi! Como posso ajudar?', [])
    expect(r.score).toBe(80)
    expect(r.reasons).toEqual([])
  })

  it('holds back a long answer asserted with no lookup', () => {
    const r = scoreConfidence('x'.repeat(400), [])
    expect(r.score).toBe(55)
    expect(r.reasons).toContain('substantive answer with no knowledge-base lookup')
  })

  it('does not penalise side-effect tools', () => {
    // Tagging or setting priority says nothing about answer quality.
    const r = scoreConfidence('Certo!', [{ name: 'attach_tag' }, { name: 'set_priority' }])
    expect(r.score).toBe(80)
  })

  it('treats a handoff note as safe to send', () => {
    const r = scoreConfidence(
      'Vou passar para o time de suporte e já te retornamos por aqui.',
      [{ name: 'assign_conversation_to_human' }],
    )
    expect(r.score).toBe(90)
    expect(r.reasons).toContain('handing off to a human')
  })

  it('holds back a hedged reply even when it is grounded', () => {
    const r = scoreConfidence('Maybe you can try that.', KB)
    // 80 + 20 grounded − 30 uncertain
    expect(r.score).toBe(70)
  })

  it('subtracts for very long replies', () => {
    const r = scoreConfidence('x'.repeat(1500), KB)
    expect(r.score).toBe(90)
    expect(r.reasons).toContain('very long')
  })

  it('stacks uncertainty matches and clamps at 0', () => {
    const r = scoreConfidence(
      "I'm not sure. I don't know. Maybe. Let me check." + 'x'.repeat(1500),
      [{ name: 't' }],
    )
    expect(r.score).toBe(0)
  })

  it('recognises Portuguese and Spanish uncertainty phrases', () => {
    for (const t of ['Não tenho certeza.', 'No estoy seguro.', 'Não sei.', 'No sé.']) {
      expect(scoreConfidence(t, []).score).toBe(50)
    }
  })
})

// ---------- sanitizeHistory ----------

describe('sanitizeHistory', () => {
  const call = (id: string) => ({ type: 'tool_use' as const, id, name: 'n', input: {} })
  const result = (id: string, content = 'ok') => ({
    type: 'tool_result' as const,
    tool_use_id: id,
    content,
  })

  it('leaves a well-formed history untouched', () => {
    const msgs = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
      { role: 'assistant' as const, content: [call('t1')] },
      { role: 'user' as const, content: [result('t1')] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }] },
    ]
    expect(sanitizeHistory(msgs)).toEqual(msgs)
  })

  it('answers a tool_use the session never closed (the 400 that silenced the bot)', () => {
    const out = sanitizeHistory([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'one moment' }, call('t1')] },
    ])
    expect(out[out.length - 1]).toEqual({
      role: 'user',
      content: [result('t1', 'Result unavailable.')],
    })
  })

  it('keeps the real results and fills only the missing ones', () => {
    const out = sanitizeHistory([
      { role: 'assistant', content: [call('t1'), call('t2')] },
      { role: 'user', content: [result('t2', 'real')] },
    ])
    expect(out).toHaveLength(2)
    expect(out[1].content).toEqual([result('t1', 'Result unavailable.'), result('t2', 'real')])
  })

  it('drops a tool_result whose call was truncated away', () => {
    const out = sanitizeHistory([
      { role: 'user', content: [result('gone')] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(out).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])
  })

  it('keeps the rest of a user message when only its orphan result is dropped', () => {
    const out = sanitizeHistory([
      { role: 'user', content: [result('gone'), { type: 'text', text: 'and hello' }] },
    ])
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'and hello' }] }])
  })

  it('does not treat an assistant follow-up as the answer to a call', () => {
    const out = sanitizeHistory([
      { role: 'assistant', content: [call('t1')] },
      { role: 'assistant', content: [{ type: 'text', text: 'still thinking' }] },
    ])
    expect(out[1]).toEqual({ role: 'user', content: [result('t1', 'Result unavailable.')] })
    expect(out[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'still thinking' }] })
  })
})

// ---------- settling approved tool calls back into history ----------

describe('OrchestratorService.confirmToolCalls — history settlement', () => {
  const pendingState = (toolUseId = 'tu-d') => ({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'a', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: AWAITING_APPROVAL_RESULT,
          },
        ],
      },
    ],
  })

  function setup(call: Record<string, unknown>, handler?: ReturnType<typeof vi.fn>) {
    const prisma = makePrisma()
    const tools = makeTools()
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({ state: pendingState() }),
    )
    prisma.agentToolCall.findMany.mockResolvedValue([call])
    prisma.conversation.findUnique.mockResolvedValue({ contactId: 'contact1' })
    prisma.agentToolCall.update.mockResolvedValue({ id: 'tc1' })
    prisma.aiAgentSession.update.mockResolvedValue({})
    if (handler) {
      tools.all.mockReturnValue([
        {
          name: 'a',
          description: 'd',
          input_schema: {},
          destructive: true,
          handler,
        },
      ])
    }
    return { prisma, tools }
  }

  const settled = (prisma: Prisma) =>
    prisma.aiAgentSession.update.mock.calls[0][0].data.state.messages[2].content[0]

  it('replaces the placeholder with the tool output on CONFIRM', async () => {
    const handler = vi.fn().mockResolvedValue({ output: { ok: true }, durationMs: 4 })
    const { prisma, tools } = setup(
      { id: 'tc1', toolName: 'a', input: {}, toolUseId: 'tu-d' },
      handler,
    )
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(settled(prisma)).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu-d',
      content: JSON.stringify({ ok: true }),
      is_error: false,
    })
  })

  it('records the rejection so the model stops promising the action', async () => {
    const { prisma, tools } = setup({
      id: 'tc1',
      toolName: 'a',
      input: {},
      toolUseId: 'tu-d',
    })
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'REJECT',
    })
    expect(settled(prisma)).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu-d',
      content: 'A human rejected this action; it did not run.',
      is_error: true,
    })
  })

  it('records a handler failure in the history', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'))
    const { prisma, tools } = setup(
      { id: 'tc1', toolName: 'a', input: {}, toolUseId: 'tu-d' },
      handler,
    )
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(settled(prisma).content).toBe('Error: boom')
  })

  it('records a tool that is no longer registered', async () => {
    const { prisma, tools } = setup({
      id: 'tc1',
      toolName: 'a',
      input: {},
      toolUseId: 'tu-d',
    })
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'CONFIRM',
    })
    expect(settled(prisma).content).toBe('Error: tool no longer registered.')
  })

  it('leaves history alone for rows written before toolUseId existed', async () => {
    const { prisma, tools } = setup({ id: 'tc1', toolName: 'a', input: {}, toolUseId: null })
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'REJECT',
    })
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled()
  })

  it('leaves history alone when the placeholder is already settled', async () => {
    const { prisma, tools } = setup({
      id: 'tc1',
      toolName: 'a',
      input: {},
      toolUseId: 'other',
    })
    const { svc } = makeService(prisma, undefined, tools)
    await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'REJECT',
    })
    expect(prisma.aiAgentSession.update).not.toHaveBeenCalled()
  })

  it('survives a non-Error rejection from the history write', async () => {
    const { prisma, tools } = setup({
      id: 'tc1',
      toolName: 'a',
      input: {},
      toolUseId: 'tu-d',
    })
    prisma.aiAgentSession.update.mockRejectedValue('db down')
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'REJECT',
    })
    expect(out).toHaveLength(1)
  })

  it('a failed history write does not undo tool calls that already ran', async () => {
    const { prisma, tools } = setup({
      id: 'tc1',
      toolName: 'a',
      input: {},
      toolUseId: 'tu-d',
    })
    prisma.aiAgentSession.update.mockRejectedValue(new Error('db down'))
    const { svc } = makeService(prisma, undefined, tools)
    const out = await svc.confirmToolCalls({
      accountId: 'acc1',
      conversationId: 'conv1',
      toolCallIds: ['tc1'],
      decision: 'REJECT',
    })
    expect(out).toHaveLength(1)
  })
})

describe('OrchestratorService — history truncation', () => {
  it('never opens the window on tool results whose call was cut away', async () => {
    const prisma = makePrisma()
    const anthropic = makeAnthropic()
    // 34 stored turns: the 30-turn window would start exactly on the results
    // of a call made one turn earlier.
    const messages: Array<Record<string, unknown>> = []
    for (let i = 0; i < 4; i += 1) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] })
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'old', name: 'a', input: {} }],
    })
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'old', content: 'x' }],
    })
    for (let i = 0; i < 28; i += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })
    }
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
    prisma.conversation.findUnique.mockResolvedValue(makeConversation())
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession({ state: { messages } }))
    prisma.aiAgentSession.update.mockResolvedValue({})
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'AGENT_BOT',
      content: 'ok',
      isPrivate: true,
      createdAt: new Date(),
    })

    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'q',
    })

    const sent = anthropic.createMessage.mock.calls[0][0].messages
    expect(sent).toHaveLength(29)
    expect(
      sent.some((m: { content: Array<{ type: string }> }) =>
        m.content.some((b) => b.type === 'tool_result'),
      ),
    ).toBe(false)
  })
})

// ---------- localized SYSTEM notices ----------

describe('system notices follow the account language', () => {
  it('points at the AI panel in the sidebar, in each language', () => {
    expect(approvalNotice('pt-BR', 1)).toBe(
      '🤖 O assistente pediu 1 ação(ões) que precisam de aprovação. Revise no painel de IA, na barra lateral da conversa.',
    )
    expect(approvalNotice('es', 2)).toContain('barra lateral de la conversación')
    expect(approvalNotice('en', 3)).toContain('AI panel, in the conversation sidebar')
  })

  it('names both numbers when the monthly budget runs out', () => {
    expect(monthlyBudgetNotice('pt-BR', 15.4, 15)).toContain('$15.40 de $15.00')
    expect(monthlyBudgetNotice('es', 15.4, 15)).toContain('presupuesto mensual')
    expect(monthlyBudgetNotice('en', 15.4, 15)).toContain('$15.40 of $15.00')
  })

  it('names the bot when its daily budget is spent', () => {
    expect(dailyBudgetNotice('pt-BR', 'Suporte')).toContain('"Suporte"')
    expect(dailyBudgetNotice('es', 'Suporte')).toContain('Presupuesto diario')
    expect(dailyBudgetNotice('en', 'Suporte')).toContain('Daily AI budget')
  })

  it('falls back to Portuguese for an unknown locale', () => {
    expect(approvalNotice('de', 1)).toContain('painel de IA')
  })
})

describe('OrchestratorService — notice language comes from the account', () => {
  it('writes the budget notice in the account language', async () => {
    const prisma = makePrisma()
    const anthropic = makeAnthropic()
    prisma.conversation.findUnique.mockResolvedValue({
      ...makeConversation(),
      account: { defaultLocale: 'en' },
    })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.message.create.mockResolvedValue({
      id: 'm',
      accountId: 'acc1',
      conversationId: 'conv1',
      inboxId: 'inb1',
      senderType: 'SYSTEM',
      content: 'x',
      isPrivate: false,
      createdAt: new Date(),
    })
    const agentBots = makeAgentBots()
    agentBots.monthlyBudgetExceeded.mockResolvedValue({
      exceeded: true,
      used: 15.4,
      cap: 15,
    })

    const { svc } = makeService(prisma, anthropic, makeTools(), agentBots)
    await svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'oi',
    })

    expect(prisma.message.create.mock.calls[0][0].data.content).toContain(
      'Handing over to a human',
    )
  })
})

// ─── AI allowance gate + ledger ─────────────────────────────────────

describe('allowanceNotice', () => {
  it('distinguishes the plan allowance from the ceiling the customer chose', () => {
    // Two different conversations with the customer: "your plan ran out" is
    // an upgrade discussion, "your own ceiling was reached" is not.
    for (const locale of ['pt-BR', 'en', 'es']) {
      expect(allowanceNotice(locale, 'allowance_reached')).not.toBe(
        allowanceNotice(locale, 'cap_reached'),
      )
    }
    expect(allowanceNotice('en', 'cap_reached')).toContain('monthly AI ceiling')
    expect(allowanceNotice('es', 'cap_reached')).toContain('techo mensual de IA')
    expect(allowanceNotice('pt-BR', 'cap_reached')).toContain('teto mensal de IA')
    expect(allowanceNotice('en', 'allowance_reached')).toContain('AI allowance')
    expect(allowanceNotice('es', 'allowance_reached')).toContain('franquicia de IA')
    // An unknown locale falls back to Portuguese.
    expect(allowanceNotice('fr', 'allowance_reached')).toContain('franquia de IA')
  })
})

describe('OrchestratorService — the AI allowance gate', () => {
  let prisma: Prisma

  const blocked = (reason: string) => ({
    allowed: false,
    reason,
    used: 300,
    included: 300,
    remainingPaid: null,
    enforced: true,
  })

  beforeEach(() => {
    prisma = makePrisma()
    prisma.conversation.findUnique
      .mockResolvedValueOnce(makeConversation())
      .mockResolvedValueOnce({
        inboxId: 'inb1',
        contactId: 'contact1',
        assigneeId: null,
        controlMode: 'BOT',
      })
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'SYSTEM', content: 'x', isPrivate: false, createdAt: new Date(),
    })
    prisma.conversation.update.mockResolvedValue({})
  })

  const run = (h: ReturnType<typeof makeService>) =>
    h.svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'oi',
    })

  it('is checked before the model AND before the cost guards', async () => {
    const h = makeService(prisma)
    h.aiAllowance.check.mockResolvedValue(blocked('allowance_reached'))
    await run(h)

    // No tokens spent: an allowance that blocks after paying for the tokens
    // is not an allowance.
    expect(h.anthropic.createMessage).not.toHaveBeenCalled()
    // And the USD guards are never even consulted: the customer's limit comes
    // first, our internal cost protection second.
    expect(h.agentBots.monthlyBudgetExceeded).not.toHaveBeenCalled()
    expect(h.aiAllowance.check).toHaveBeenCalledWith('acc1', 'conv1')
  })

  it('hands the conversation over through the same routing as everything else', async () => {
    const h = makeService(prisma)
    h.aiAllowance.check.mockResolvedValue(blocked('allowance_reached'))
    await run(h)

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    // AssignmentService picks who takes it, falls back to an off-shift agent
    // rather than nobody, writes the assignee entry and notifies them. A
    // second picker here would quietly lose all three.
    expect(h.assignment.route).toHaveBeenCalledWith('conv1', 'bot_handoff')
  })

  it('tells the desk why, and the contact only that a person is coming', async () => {
    const h = makeService(prisma)
    h.aiAllowance.check.mockResolvedValue(blocked('allowance_reached'))
    await run(h)

    const note = prisma.message.create.mock.calls[0]![0].data
    expect(note.senderType).toBe('SYSTEM')
    expect(note.content).toContain('franquia de IA')
    const toContact = prisma.message.create.mock.calls[1]![0].data
    expect(toContact.senderType).toBe('AGENT_BOT')
    expect(toContact.content).toBe(
      'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.',
    )
    // The contact must never read anything about allowances or billing.
    expect(toContact.content).not.toContain('IA')
  })

  it("names the customer's own ceiling when that is what was reached", async () => {
    const h = makeService(prisma)
    h.aiAllowance.check.mockResolvedValue(blocked('cap_reached'))
    await run(h)
    expect(prisma.message.create.mock.calls[0]![0].data.content).toContain(
      'teto mensal de IA',
    )
  })

  it('spends nothing on the ledger for a turn it blocked', async () => {
    const h = makeService(prisma)
    h.aiAllowance.check.mockResolvedValue(blocked('allowance_reached'))
    await run(h)
    expect(h.aiUsage.record).not.toHaveBeenCalled()
  })
})

describe('OrchestratorService — what counts as an AI answer', () => {
  function turn(opts: { mode: string; text?: string; delivered?: boolean }) {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({
        inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: opts.mode },
      }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.findUnique.mockResolvedValue(makeSession())
    prisma.aiAgentSession.update.mockResolvedValue({})
    prisma.message.create.mockResolvedValue({
      id: 'msg1', accountId: 'acc1', conversationId: 'conv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: false, createdAt: new Date(),
    })
    const anthropic = makeAnthropic()
    anthropic.createMessage.mockResolvedValue({
      content: opts.text === '' ? [] : [{ type: 'text', text: opts.text ?? 'Olá!' }],
      stop_reason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const whatsapp = makeWhatsapp()
    if (opts.delivered === false) {
      whatsapp.recipientForConversation.mockResolvedValue(null)
    }
    return makeService(prisma, anthropic, undefined, undefined, undefined, whatsapp)
  }

  const run = (h: ReturnType<typeof makeService>) =>
    h.svc.handleInbound({
      accountId: 'acc1',
      conversationId: 'conv1',
      inboundMessageContent: 'oi',
    })

  it('an answer that reached the channel does', async () => {
    const h = turn({ mode: 'AUTO_FULL' })
    await run(h)
    expect(h.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        conversationId: 'conv1',
        agentBotId: 'bot1',
        source: 'AGENT_BOT',
        replied: true,
      }),
    )
  })

  it('a private draft does not: whoever sends it is the one who replied', async () => {
    const h = turn({ mode: 'DRAFT' })
    await run(h)
    expect(h.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ replied: false }),
    )
  })

  it('a send that never reached the channel does not', async () => {
    // Billing a conversation for a message the contact never saw would be
    // charging the customer for our own outage.
    const h = turn({ mode: 'AUTO_FULL', delivered: false })
    await run(h)
    expect(h.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ replied: false }),
    )
  })

  it('a turn that produced no text at all does not, but is still recorded', async () => {
    const h = turn({ mode: 'AUTO_FULL', text: '' })
    await run(h)
    // The tokens were spent, so the row exists; nobody was answered, so it
    // costs no allowance.
    expect(h.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ replied: false }),
    )
  })
})

describe('silentTurnNotice + handOffSilentTurn', () => {
  it('tells the desk the bot said nothing, in the three account languages', () => {
    expect(silentTurnNotice('en')).toContain('no reply')
    expect(silentTurnNotice('es')).toContain('no respondió')
    expect(silentTurnNotice('pt-BR')).toContain('não respondeu')
  })

  it('hands the conversation over: control, note for the desk, line for the contact', async () => {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue({
      inboxId: 'inb1', contactId: 'contact1', assigneeId: null, controlMode: 'BOT',
    })
    prisma.account.findUnique.mockResolvedValue({ defaultLocale: 'pt-BR' })

    const { svc } = makeService(prisma)
    await svc.handOffSilentTurn({ accountId: 'acc1', conversationId: 'conv1' })

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { controlMode: 'HUMAN' },
    })
    expect(prisma.message.create.mock.calls[0]![0].data.content).toContain(
      'não respondeu',
    )
    expect(prisma.message.create.mock.calls[1]![0].data.content).toContain(
      'nossa equipe',
    )
  })

  it('falls back to Portuguese when the account row is gone', async () => {
    const prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue({
      inboxId: 'inb1', contactId: 'contact1', assigneeId: null, controlMode: 'BOT',
    })
    prisma.account.findUnique.mockResolvedValue(null)

    const { svc } = makeService(prisma)
    await svc.handOffSilentTurn({ accountId: 'acc1', conversationId: 'conv1' })

    expect(prisma.message.create.mock.calls[0]![0].data.content).toContain(
      'não respondeu',
    )
  })
})

// Conversation 8741 (2026-10-13): handed over by the flow, the agent only
// knew its own session and drafted "Olá! Como posso ajudar?" to a customer
// forty minutes into a problem.
describe('OrchestratorService.handleInbound — reads what it did not see', () => {
  let prisma: Prisma
  let anthropic: Anthropic
  beforeEach(() => {
    prisma = makePrisma()
    anthropic = makeAnthropic()
    prisma.conversation.findUnique.mockResolvedValue(
      makeConversation({ inbox: { id: 'inb1', agentBotId: 'bot1', aiAutoreplyMode: 'AUTO_FULL' } }),
    )
    prisma.agentBot.findUnique.mockResolvedValue(makeBot())
    prisma.aiAgentSession.update.mockResolvedValue({})
    anthropic.createMessage.mockResolvedValue(textResponse('ok'))
  })

  async function run(inbound: string) {
    const { svc } = makeService(prisma, anthropic)
    await svc.handleInbound({ accountId: 'acc1', conversationId: 'conv1', inboundMessageContent: inbound })
    const sent = anthropic.createMessage.mock.calls[0]![0] as { messages: Array<{ role: string; content: Array<{ text?: string }> }> }
    return sent.messages.at(-1)!.content[0]!.text!
  }

  it('a new session reads the whole conversation before this message, oldest first', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    // newest first, as the query returns them; the newest is this turn's message
    prisma.message.findMany.mockResolvedValue([
      { senderType: 'CONTACT', content: '?' },
      { senderType: 'AGENT_BOT', content: 'Vou transferir seu atendimento.' },
      { senderType: 'CONTACT', content: 'Meu bot está parado' },
    ])
    const text = await run('?')

    const where = prisma.message.findMany.mock.calls[0]![0].where
    expect(where).not.toHaveProperty('createdAt')
    expect(text).toBe(
      'Messages in this conversation you have not seen yet, oldest first (the flow, colleagues and the customer may have spoken before you were called in):\n' +
        'Cliente: Meu bot está parado\nBot: Vou transferir seu atendimento.\n\n' +
        "The customer's new message:\n?",
    )
  })

  it('an ongoing session only reads what came after its last turn, never its own replies or notes', async () => {
    const lastActiveAt = new Date('2026-10-13T20:14:00Z')
    prisma.aiAgentSession.findUnique.mockResolvedValue(
      makeSession({
        lastActiveAt,
        state: { messages: [{ role: 'user', content: [{ type: 'text', text: 'antes' }] }, { role: 'assistant', content: [{ type: 'text', text: 'oi' }] }] },
      }),
    )
    prisma.message.findMany.mockResolvedValue([{ senderType: 'CONTACT', content: '?' }, { senderType: 'USER', content: 'Já vou ver' }])
    const text = await run('?')

    const where = prisma.message.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({
      conversationId: 'conv1',
      isPrivate: false,
      senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] },
      createdAt: { gt: lastActiveAt },
    })
    // Rows with NO bot (customer, flow) must survive the "not this bot" filter.
    expect(where.OR).toEqual([{ senderAgentBotId: null }, { senderAgentBotId: { not: 'bot1' } }])
    expect(text).toContain('Atendente: Já vou ver')
  })

  it('sends the plain message when nothing new happened', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    prisma.message.findMany.mockResolvedValue([{ senderType: 'CONTACT', content: 'hi there' }])
    expect(await run('hi there')).toBe('hi there')
  })

  it('keeps a newest customer row with no text (a photo, an audio) as context', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    prisma.message.findMany.mockResolvedValue([
      { senderType: 'CONTACT', content: null },
      { senderType: 'CONTACT', content: 'segue a foto' },
    ])
    expect(await run('olá')).toContain('Cliente: segue a foto')
  })

  it('keeps the newest row when it is not this turn’s message', async () => {
    prisma.aiAgentSession.findUnique.mockResolvedValue(null)
    prisma.aiAgentSession.create.mockResolvedValue(makeSession())
    prisma.message.findMany.mockResolvedValue([{ senderType: 'USER', content: 'Oi, sou a Ana' }])
    expect(await run('olá')).toContain('Atendente: Oi, sou a Ana')
  })
})
