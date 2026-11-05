import { channelsOver } from '../channels/channels.testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'

import { FlowRunnerService, describeStep, collectLinkIds } from './flow-runner.service'
import { FlowEngine } from './flow-engine'

// The real effects() port SSRF-guards via safe-fetch; stub it so webhook tests
// don't do DNS/network.
vi.mock('../../common/safe-fetch', () => ({
  assertSafeFetchUrl: vi.fn().mockResolvedValue(new URL('https://api.example')),
}))

function makePrisma() {
  return {
    conversation: { findUnique: vi.fn(), update: vi.fn() },
    flow: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    message: { create: vi.fn(), update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeRealtime() {
  return { publish: vi.fn().mockResolvedValue(undefined) }
}
function makeWhatsapp() {
  return {
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'w1' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
    sendInteractive: vi.fn().mockResolvedValue({ wamid: 'w2' }),
    sendMedia: vi.fn().mockResolvedValue({ wamid: 'w4' }),
    sendTemplate: vi.fn().mockResolvedValue({ wamid: 'w3' }),
    resolveRecipient: vi.fn().mockResolvedValue(null),
    recipientForConversation: vi.fn().mockResolvedValue('+5511'),
  }
}
const DEVIATION_USAGE = {
  inputTokens: 12,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

function makeAi() {
  return {
    classifyDeviation: vi.fn().mockResolvedValue({
      action: 'answer',
      reply: 'Sure — let me help.',
      value: null,
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    }),
    createMessage: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'AI reply' }],
      stop_reason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
  }
}

function makeEmails() {
  return { send: vi.fn().mockResolvedValue(true) }
}

function makeAgentBots() {
  return {
    monthlyBudgetExceeded: vi
      .fn()
      .mockResolvedValue({ exceeded: false, used: 1, cap: 15 }),
  }
}

/**
 * The AI ledger. `AiUsageService.record` superseded
 * `AgentBotsService.recordAiUsage`: it writes an `AiUsageEvent` row AND folds
 * the same call into the `AiAgentSession` aggregate the dollar guards read,
 * so nothing that used to be recorded stopped being recorded.
 */
function makeAiUsage() {
  return { record: vi.fn().mockResolvedValue(0.0001) }
}

/** The customer's AI allowance. Default: it never stops anything. */
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

/** The account's AI allowance is spent AND enforcement is on. */
function allowanceSpent(
  aiAllowance: ReturnType<typeof makeAiAllowance>,
  reason = 'allowance_reached',
): void {
  aiAllowance.check.mockResolvedValue({
    allowed: false,
    reason,
    used: 300,
    included: 300,
    remainingPaid: null,
    enforced: true,
  })
}

/** The account has spent its monthly AI ceiling. */
function budgetSpent(agentBots: ReturnType<typeof makeAgentBots>): void {
  agentBots.monthlyBudgetExceeded.mockResolvedValue({
    exceeded: true,
    used: 15.4,
    cap: 15,
  })
}

function makeTickets() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'tk1', number: 42, subject: 'Erro no relatório' }),
    appendUpdate: vi.fn().mockResolvedValue({ id: 'tk1', status: 'PENDING' }),
    list: vi.fn().mockResolvedValue([]),
  }
}

function makeAssignment() {
  return { route: vi.fn().mockResolvedValue({ assigneeId: null, pickedId: null }) }
}

const AGENT_USAGE = { inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** The AI agent of an "AI agent" block. Default: a plain answer. */
function makeFlowAgent() {
  return {
    runTurn: vi.fn().mockResolvedValue({
      kind: 'reply',
      text: 'Sou a Ana, do Financeiro.',
      handoff: false,
      botId: 'bot-fin',
      model: 'claude-haiku-4-5',
      usage: AGENT_USAGE,
    }),
  }
}

function makeService(
  prisma = makePrisma(),
  realtime = makeRealtime(),
  whatsapp = makeWhatsapp(),
  ai = makeAi(),
  emails = makeEmails(),
  tickets = makeTickets(),
  assignment = makeAssignment(),
  agentBots = makeAgentBots(),
  aiUsage = makeAiUsage(),
  aiAllowance = makeAiAllowance(),
  flowAgent = makeFlowAgent(),
) {
  const svc = new FlowRunnerService(
    prisma as never,
    realtime as never,
    whatsapp as never,
    ai as never,
    emails as never,
    tickets as never,
    assignment as never,
    agentBots as never,
    aiUsage as never,
    aiAllowance as never,
    flowAgent as never,
    channelsOver(
      whatsapp,
      {},
      { recipientForConversation: vi.fn().mockResolvedValue(null) },
      {},
      { recipientForConversation: vi.fn().mockResolvedValue(null) },
    ) as never,
  )
  return {
    svc, prisma, realtime, whatsapp, ai, emails, tickets, assignment, agentBots,
    aiUsage, aiAllowance, flowAgent,
  }
}

// flows
const TEXT_FLOW = {
  groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'Hello {{contact.name}}' } }] }],
  edges: [],
  variables: [],
}
const CHOICE_FLOW = {
  groups: [{ id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { message: 'Pick', items: [{ id: 'i1', content: 'A', outgoingEdgeId: 'e1' }] } }] }],
  edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
  variables: [],
}
const HANDOFF_FLOW = {
  groups: [{ id: 'g1', blocks: [{ id: 'cd', type: 'Cosmodesk', options: { assigningMessage: 'Transferring', teamId: 't1' } }] }],
  edges: [],
  variables: [],
}
const NOTE_FLOW = {
  groups: [{ id: 'g1', blocks: [
    { id: 'n', type: 'note', options: { content: 'VIP' } },
    { id: 'b', type: 'text', options: { content: 'done' } },
  ] }],
  edges: [],
  variables: [],
}
const TEXTINPUT_FLOW = {
  groups: [
    { id: 'g1', blocks: [{ id: 'in', type: 'text input', options: { variableId: 'v' }, outgoingEdgeId: 'e1' }] },
    { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'got {{v}}' } }] },
  ],
  edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
  variables: [],
}

function conv(over: Record<string, unknown> = {}) {
  return {
    id: 'cv1',
    accountId: 'acc1',
    inboxId: 'inb1',
    contactId: 'ct1',
    controlMode: 'BOT',
    flowState: null,
    inbox: { id: 'inb1', channelType: 'WHATSAPP', flowMode: 'STRICT', defaultFlowId: 'f1' },
    contact: { name: 'Ana', email: null, phoneNumber: '+5511' },
    account: { defaultLocale: 'pt-BR' },
    ...over,
  }
}

function args(over: Record<string, unknown> = {}) {
  return { accountId: 'acc1', conversationId: 'cv1', content: 'hi', ...over }
}

describe('FlowRunnerService — gating (returns false → AI agent takes over)', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('false when conversation not found', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false on cross-account', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ accountId: 'other' }))
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when not bot-controlled', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ controlMode: 'HUMAN' }))
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when flowMode OFF', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ inbox: { ...conv().inbox, flowMode: 'OFF' } }))
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when no defaultFlowId', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ inbox: { ...conv().inbox, defaultFlowId: null } }))
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when flow missing or unpublished', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue(null)
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: null })
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when the flow belongs to another account (isolation guard)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'OTHER', published: TEXT_FLOW })
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when published definition is invalid', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: { nope: true } })
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
  it('false when the flow already concluded (no re-trigger)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ flowState: { flowId: 'f1', status: 'completed' } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    expect(await makeService(prisma).svc.handleInbound(args())).toBe(false)
  })
})

describe('FlowRunnerService — dispatch', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1',
      accountId: data.accountId,
      conversationId: data.conversationId,
      inboxId: data.inboxId,
      senderType: data.senderType,
      content: data.content ?? null,
      isPrivate: data.isPrivate ?? false,
      createdAt: new Date('2026-06-26T00:00:00Z'),
    }))
  })

  it('settles the bot message to FAILED when the channel push fails', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const whatsapp = makeWhatsapp()
    whatsapp.sendOutbound.mockRejectedValue(new Error('Authorization Error'))
    const realtime = makeRealtime()
    const { svc } = makeService(prisma, realtime, whatsapp)
    await svc.handleInbound(args())
    // The row was created SENT, the push died — the thread must not keep the
    // lie (this is how the Comercial cutover's wrong-token sends hid).
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { status: 'FAILED' },
    })
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MessageStatusChanged', status: 'FAILED' }),
    )
  })

  const WEBHOOK_FLOW = (method: string, withHeaders: boolean) => ({
    groups: [
      { id: 'g1', blocks: [{ id: 'w', type: 'Webhook', options: { url: 'https://api.example/ping', method, ...(withHeaders ? { headers: { 'x-key': 'v' }, body: '{"a":1}' } : {}) }, outgoingEdgeId: 'e1' }] },
      { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'status {{status_code}}' } }] },
    ],
    edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
    variables: [],
  })

  it('webhook (GET, JSON response): SSRF-guarded effect runs, response stored, branches on it', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: WEBHOOK_FLOW('GET', false) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: async () => '{"ok":true}',
    } as Response)
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    const init = fetchSpy.mock.calls[0]![1]!
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined() // GET → no body
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'status 200')).toBe(true)
    fetchSpy.mockRestore()
  })

  it('webhook (POST, headers + non-JSON response): sends body + merged headers', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: WEBHOOK_FLOW('POST', true) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 500,
      text: async () => 'not json',
    } as Response)
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    const init = fetchSpy.mock.calls[0]![1]! as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['x-key']).toBe('v')
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'status 500')).toBe(true)
    fetchSpy.mockRestore()
  })

  it('WhatsApp Template block: sends the HSM via the WhatsApp service', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { name: 'reminder', language: 'pt_BR', params: ['{{contact.name}}'] } }] }],
      edges: [], variables: [],
    } })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('inb1', '+5511', 'reminder', 'pt_BR', ['Ana'])
  })

  it('WhatsApp Template block: falls back to the BSUID recipient when the contact has no phone', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ contact: { name: 'Ana', email: null, phoneNumber: null } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { name: 'reminder', language: 'pt_BR', params: [] } }] }],
      edges: [], variables: [],
    } })
    const whatsapp = makeWhatsapp()
    whatsapp.recipientForConversation.mockResolvedValue('BR.13491208655302741918')
    const { svc } = makeService(prisma, makeRealtime(), whatsapp)
    await svc.handleInbound(args())
    expect(whatsapp.recipientForConversation).toHaveBeenCalledWith('cv1')
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('inb1', 'BR.13491208655302741918', 'reminder', 'pt_BR', [])
  })

  it('template send failure is logged, not thrown', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { name: 'x' } }] }],
      edges: [], variables: [],
    } })
    const whatsapp = makeWhatsapp()
    whatsapp.sendTemplate.mockRejectedValue(new Error('wa down'))
    const { svc } = makeService(prisma, makeRealtime(), whatsapp)
    await expect(svc.handleInbound(args())).resolves.toBe(true)
  })

  it('template send failure with a non-Error rejection is also handled', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 't', type: 'WhatsApp Template', options: { name: 'x' } }] }],
      edges: [], variables: [],
    } })
    const whatsapp = makeWhatsapp()
    whatsapp.sendTemplate.mockRejectedValue('a string')
    const { svc } = makeService(prisma, makeRealtime(), whatsapp)
    await expect(svc.handleInbound(args())).resolves.toBe(true)
  })

  it('media block (image): persists an IMAGE message + sends the picture natively with its caption', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'i', type: 'image', options: { url: 'https://x/p.png', caption: 'look' } }] }],
      edges: [], variables: [],
    } })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      contentType: 'IMAGE',
      content: 'look',
      contentAttributes: { url: 'https://x/p.png' },
    })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('inb1', '+5511', {
      kind: 'image',
      source: { link: 'https://x/p.png' },
      fileName: 'p.png',
      caption: 'look',
    })
    expect(whatsapp.stampOutbound).toHaveBeenCalledWith(expect.any(String), ['w4'])
  })

  it('media block (audio): sends a playable voice note, with the caption first as text', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'a', type: 'audio', options: { url: 'https://x/aviso.mp3', caption: 'ouça' } }] }],
      edges: [], variables: [],
    } })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511', 'ouça')
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('inb1', '+5511', {
      kind: 'audio',
      source: { link: 'https://x/aviso.mp3' },
      fileName: 'aviso.mp3',
    })
  })

  it('file block (PDF): persists a FILE message and sends the document itself, with its name', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'f', type: 'file', options: { url: 'https://app/poc/guia-segunda-via.pdf', caption: 'Guia' } }] }],
      edges: [], variables: [],
    } })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      contentType: 'FILE',
      content: 'Guia',
      contentAttributes: { url: 'https://app/poc/guia-segunda-via.pdf' },
    })
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('inb1', '+5511', {
      kind: 'document',
      source: { link: 'https://app/poc/guia-segunda-via.pdf' },
      fileName: 'guia-segunda-via.pdf',
      caption: 'Guia',
    })
  })

  it('media block (video) with no caption and no file name: one native send, nothing else', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'v', type: 'video', options: { url: 'https://cdn/' } }] }],
      edges: [], variables: [],
    } })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('inb1', '+5511', {
      kind: 'video',
      source: { link: 'https://cdn/' },
    })
  })

  it('OpenAI block: runs the llm effect (AI client) and emits the reply', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help' } }] }],
      edges: [], variables: [],
    } })
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args())
    expect(ai.createMessage).toHaveBeenCalled()
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'AI reply')).toBe(true)
  })

  it('OpenAI block: empty reply when the model returns no text block', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help', responseVariableId: 'r' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'r=[{{r}}]' } }] }],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }], variables: [],
    } })
    const ai = makeAi()
    ai.createMessage.mockResolvedValue({ content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }], stop_reason: 'end_turn', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'r=[]')).toBe(true)
  })

  it('Code block: runs via the sandbox effect; flow continues (degrades if isolated-vm absent)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [
        { id: 'g1', blocks: [{ id: 'c', type: 'Code', options: { content: 'user.x = 1' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'done' } }] },
      ],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }], variables: [],
    } })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'done')).toBe(true)
  })

  it('Cosmoflow link: loads the sub-flow by externalId and composes it', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [
        { id: 'l', type: 'Cosmoflow link', options: { cosmoflowId: '4617' }, outgoingEdgeId: 'eret' },
      ] }, { id: 'g2', blocks: [{ id: 'after', type: 'text', options: { content: 'back in parent' } }] }],
      edges: [{ id: 'eret', from: {}, to: { groupId: 'g2' } }], variables: [],
    } })
    prisma.flow.findMany.mockResolvedValue([
      { id: 'sub1', accountId: 'acc1', externalId: '4617', published: {
        groups: [{ id: 'sg', blocks: [{ id: 'sb', type: 'text', options: { content: 'from the sub-flow' } }] }],
        edges: [], variables: [],
      } },
    ])
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.flow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ accountId: 'acc1', externalId: { in: ['4617'] } }) }),
    )
    const texts = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    expect(texts).toContain('from the sub-flow')
    expect(texts).toContain('back in parent')
  })

  it('loadSubFlows: skips invalid + null-externalId rows and breaks on a cycle', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [{ id: 'g1', blocks: [
        { id: 'l1', type: 'Cosmoflow link', options: { cosmoflowId: '4617' }, outgoingEdgeId: 'e1' },
        { id: 'l2', type: 'Cosmoflow link', options: { cosmoflowId: 'bad' } },
        { id: 'l3', type: 'Cosmoflow link', options: { cosmoflowId: 'nullext' } },
      ] }, { id: 'g2', blocks: [{ id: 'after', type: 'text', options: { content: 'parent-after' } }] }],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }], variables: [],
    } })
    prisma.flow.findMany.mockResolvedValue([
      // valid, but its sub-flow links back to itself → next round's wanted is empty → break
      { id: 's1', accountId: 'acc1', externalId: '4617', published: {
        groups: [{ id: 'sg', blocks: [
          { id: 'sb', type: 'text', options: { content: 'sub-ok' } },
          { id: 'cyc', type: 'Cosmoflow link', options: { cosmoflowId: '4617' }, outgoingEdgeId: null },
        ] }], edges: [], variables: [],
      } },
      { id: 's2', accountId: 'acc1', externalId: 'bad', published: { nope: true } }, // invalid → skipped
      { id: 's3', accountId: 'acc1', externalId: null, published: {
        groups: [{ id: 'x', blocks: [] }], edges: [], variables: [],
      } }, // null externalId → skipped
    ])
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    const texts = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    expect(texts).toContain('sub-ok')
    expect(texts).toContain('parent-after')
  })

  it('provider integration block (Sheets): runs the effect (no-op), flow continues', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: {
      groups: [
        { id: 'g1', blocks: [{ id: 's', type: 'Google Sheets', options: { action: 'Read' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'after-sheets' } }] },
      ],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }], variables: [],
    } })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'after-sheets')).toBe(true)
  })

  // ---- Email integration block -------------------------------------------
  // Real migrated Nebula shape: { type: 'Email', options: { recipients, cc,
  // subject, body, isHtml, ... } }, already interpolated by the engine.
  const emailFlow = (options: Record<string, unknown>) => ({
    groups: [
      { id: 'g1', blocks: [{ id: 'em', type: 'Email', options, outgoingEdgeId: 'e1' }] },
      { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'after-email' } }] },
    ],
    edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
    variables: [],
  })
  const runEmail = async (options: Record<string, unknown>, emails = makeEmails()) => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', published: emailFlow(options),
    })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), makeAi(), emails)
    await svc.handleInbound(args())
    const reached = prisma.message.create.mock.calls.some(
      (c) => c[0].data.content === 'after-email',
    )
    return { emails, reached }
  }

  it('Email block: sends to every recipient and cc, then continues', async () => {
    const { emails, reached } = await runEmail({
      recipients: 'ops@cosmobots.io; second@cosmobots.io',
      cc: 'boss@cosmobots.io',
      subject: 'New lead',
      body: 'Ana asked about pricing',
    })
    expect(emails.send.mock.calls.map((c) => c[0])).toEqual([
      'ops@cosmobots.io', 'second@cosmobots.io', 'boss@cosmobots.io',
    ])
    expect(emails.send).toHaveBeenCalledWith('ops@cosmobots.io', 'New lead', 'Ana asked about pricing')
    expect(reached).toBe(true)
  })

  it('Email block: strips markup when isHtml', async () => {
    const { emails } = await runEmail({
      recipients: 'ops@cosmobots.io',
      subject: 'HTML',
      body: '<p>Hello <b>Ana</b></p>',
      isHtml: true,
    })
    expect(emails.send).toHaveBeenCalledWith('ops@cosmobots.io', 'HTML', 'Hello Ana')
  })

  it('Email block: no valid recipient → skipped, flow still continues', async () => {
    const { emails, reached } = await runEmail({
      recipients: 'not-an-address', subject: 'x', body: 'y',
    })
    expect(emails.send).not.toHaveBeenCalled()
    expect(reached).toBe(true)
  })

  it('Email block: missing subject → skipped', async () => {
    const { emails } = await runEmail({ recipients: 'ops@cosmobots.io', body: 'y' })
    expect(emails.send).not.toHaveBeenCalled()
  })

  it('Email block: provider rejects → flow continues', async () => {
    const emails = { send: vi.fn().mockResolvedValue(false) }
    const { reached } = await runEmail(
      { recipients: 'ops@cosmobots.io', subject: 's', body: 'b' },
      emails as never,
    )
    expect(reached).toBe(true)
  })

  it('Email block: send throws → flow continues', async () => {
    const emails = { send: vi.fn().mockRejectedValue(new Error('resend down')) }
    const { reached } = await runEmail(
      { recipients: 'ops@cosmobots.io', subject: 's', body: 'b' },
      emails as never,
    )
    expect(reached).toBe(true)
  })

  it('Email block: non-Error throw is reported', async () => {
    const emails = { send: vi.fn().mockRejectedValue('boom') }
    const { reached } = await runEmail(
      { recipients: 'ops@cosmobots.io', subject: 's', body: 'b' },
      emails as never,
    )
    expect(reached).toBe(true)
  })

  it('Email block: non-string body/cc are tolerated', async () => {
    const { emails } = await runEmail({
      recipients: 'ops@cosmobots.io', cc: 42, subject: 's', body: null,
    })
    expect(emails.send).toHaveBeenCalledWith('ops@cosmobots.io', 's', '')
  })

  // ---- Ticket blocks --------------------------------------------------------
  // Real migrated shapes, straight from production:
  //   Ticket Create { subject, category, priority, description,
  //                   ticketIdVariable, ticketNumberVariable }
  //   Ticket Update { message, resultVariable }
  //   Ticket Query  { queryType, countVariable, resultVariable }
  const ticketFlow = (type: string, options: Record<string, unknown>, echo: string) => ({
    groups: [
      { id: 'g1', blocks: [{ id: 'tk', type, options, outgoingEdgeId: 'e1' }] },
      { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: echo } }] },
    ],
    edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
    variables: [],
  })
  const runTicket = async (
    type: string,
    options: Record<string, unknown>,
    echo: string,
    tickets = makeTickets(),
  ) => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', published: ticketFlow(type, options, echo),
    })
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), tickets,
    )
    await svc.handleInbound(args())
    const texts = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    return { tickets, texts }
  }

  it('Ticket Create: opens the ticket and exposes id + number to later blocks', async () => {
    const { tickets, texts } = await runTicket(
      'Ticket Create',
      {
        subject: 'Erro no relatório',
        category: 'relatorios',
        priority: 'alta',
        description: 'Não baixa',
        ticketIdVariable: 'ticket_id',
        ticketNumberVariable: 'ticket_number',
      },
      'Chamado {{ticket_number}} aberto ({{ticket_id}})',
    )
    expect(tickets.create).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      contactId: 'ct1',
      subject: 'Erro no relatório',
      description: 'Não baixa',
      category: 'relatorios',
      priority: 'alta',
    })
    expect(texts).toContain('Chamado 42 aberto (tk1)')
    // The agent picking this up must see the chamado without leaving the thread.
    const note = prisma.message.create.mock.calls.find(
      (c) => c[0].data.isPrivate === true,
    )
    expect(note![0].data.content).toBe('🎫 Chamado #42 aberto — Erro no relatório')
  })

  it('Ticket Create: honours author-chosen variable names', async () => {
    const { texts } = await runTicket(
      'Ticket Create',
      { subject: 's', ticketNumberVariable: 'meu_numero' },
      'n={{meu_numero}}',
    )
    expect(texts).toContain('n=42')
  })

  it('Ticket Update: records the status when a ticket was updated', async () => {
    const { tickets, texts } = await runTicket(
      'Ticket Update',
      { message: 'cliente respondeu', resultVariable: 'ticket_status' },
      'status={{ticket_status}}',
    )
    expect(tickets.appendUpdate).toHaveBeenCalledWith('acc1', 'cv1', 'cliente respondeu')
    expect(texts).toContain('status=PENDING')
  })

  it('Ticket Update: reports not_found instead of stalling when nothing is open', async () => {
    const tickets = makeTickets()
    tickets.appendUpdate.mockResolvedValue(null)
    const { texts } = await runTicket(
      'Ticket Update', { message: 'oi' }, 'status={{ticket_status}}', tickets,
    )
    expect(texts).toContain('status=not_found')
  })

  it('Ticket Query: counts the conversation tickets', async () => {
    const tickets = makeTickets()
    tickets.list.mockResolvedValue([
      { id: 'tk1', number: 42, subject: 's', status: 'OPEN', priority: 'HIGH', createdAt: new Date('2026-08-05T00:00:00Z') },
    ])
    const { texts } = await runTicket(
      'Ticket Query',
      { queryType: 'conversation', countVariable: 'ticket_count', resultVariable: 'tickets' },
      'voce tem {{ticket_count}} chamado(s)',
      tickets,
    )
    expect(tickets.list).toHaveBeenCalledWith('acc1', {
      conversationId: 'cv1', contactId: 'ct1', byContact: false,
    })
    expect(texts).toContain('voce tem 1 chamado(s)')
  })

  it('Ticket Query: queryType "contact" widens the scope', async () => {
    const { tickets } = await runTicket(
      'Ticket Query', { queryType: 'contact' }, 'n={{ticket_count}}',
    )
    expect(tickets.list.mock.calls[0]![1].byContact).toBe(true)
  })

  it('a ticket failure sets ticket_error and the flow continues', async () => {
    const tickets = makeTickets()
    tickets.create.mockRejectedValue(new Error('db down'))
    const { texts } = await runTicket(
      'Ticket Create', { subject: 's' }, 'erro={{ticket_error}}', tickets,
    )
    expect(texts).toContain('erro=failed')
  })

  it('a non-Error ticket failure is reported too', async () => {
    const tickets = makeTickets()
    tickets.create.mockRejectedValue('boom')
    const { texts } = await runTicket(
      'Ticket Create', { subject: 's' }, 'erro={{ticket_error}}', tickets,
    )
    expect(texts).toContain('erro=failed')
  })

  it('start: emits a text bubble, pushes to WhatsApp, persists completed', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const { svc, realtime, whatsapp } = makeService(prisma)
    expect(await svc.handleInbound(args())).toBe(true)
    // message created with the interpolated text
    expect(prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      senderType: 'AGENT_BOT',
      content: 'Hello Ana',
      contentType: 'TEXT',
    })
    expect(realtime.publish).toHaveBeenCalled()
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511', 'Hello Ana')
    // flow completed → persisted status completed, no runtime
    const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(persisted).toEqual({ flowId: 'f1', status: 'completed' })
  })

  it('choice: emits interactive buttons, persists waiting runtime', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: CHOICE_FLOW })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      contentType: 'QUICK_REPLIES',
      content: 'Pick',
    })
    expect(whatsapp.sendInteractive).toHaveBeenCalled()
    const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(persisted.status).toBe('waiting')
    expect(persisted.runtime.currentBlockId).toBe('ci')
  })

  it('resume: continues a waiting flow from persisted runtime', async () => {
    // Derive a real waiting state by running the engine once.
    const waiting = (await new FlowEngine(TEXTINPUT_FLOW as never).start()).state
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ flowState: { flowId: 'f1', status: 'waiting', runtime: waiting } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXTINPUT_FLOW })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args({ content: 'Bob' }))
    // captured var interpolated into g2's bubble
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('got Bob')
  })

  it('handoff: sends the assigning message, assigns team, flips to HUMAN', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: HANDOFF_FLOW })
    const { svc, whatsapp, assignment } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('Transferring')
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511', 'Transferring')
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ teamId: 't1' })
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
    // Distributed only after the team is set and humans own the conversation.
    expect(assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
    const lastUpdate = Math.max(...prisma.conversation.update.mock.invocationCallOrder)
    expect(assignment.route.mock.invocationCallOrder[0]).toBeGreaterThan(lastUpdate)
  })

  it('handoff with no message still flips control', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1',
      accountId: 'acc1',
      published: { groups: [{ id: 'g1', blocks: [{ id: 'cd', type: 'cosmodesk', options: {} }] }], edges: [], variables: [] },
    })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    expect(prisma.message.create).not.toHaveBeenCalled()
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
  })

  it('note: writes a private message', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: NOTE_FLOW })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created).toContainEqual(expect.objectContaining({ content: 'VIP', isPrivate: true }))
    // the text bubble emission is public (no isPrivate flag)
    const doneMsg = created.find((d) => d.content === 'done')
    expect(doneMsg).toBeTruthy()
    expect(doneMsg!.isPrivate).toBeUndefined()
  })

  it('web-widget channel does not push (pull-based)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'STRICT', defaultFlowId: 'f1' } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const { svc, whatsapp } = makeService(prisma)
    await svc.handleInbound(args())
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('whatsapp without a phone number does not push', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ contact: { name: 'X', phoneNumber: null } }))
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const { svc, whatsapp } = makeService(prisma)
    // The resolver is the single source of truth for reachability now.
    whatsapp.recipientForConversation.mockResolvedValue(null)
    await svc.handleInbound(args())
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('handles a conversation with no contact (null contact fields, no push)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv({ contact: null }))
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const { svc, whatsapp } = makeService(prisma)
    whatsapp.recipientForConversation.mockResolvedValue(null)
    expect(await svc.handleInbound(args())).toBe(true)
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('Hello ')
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('ignores persisted state from a different flow and starts fresh', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ flowState: { flowId: 'OLD-FLOW', status: 'waiting', runtime: { currentGroupId: 'x', currentBlockId: 'y', variables: {}, retryCounts: {}, visitCounts: {} } } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    // started fresh from g1, not resumed into the foreign runtime
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('Hello Ana')
  })

  it('a channel push failure is swallowed (logged, not thrown)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const whatsapp = makeWhatsapp()
    whatsapp.sendOutbound.mockRejectedValue(new Error('wa down'))
    const { svc } = makeService(prisma, makeRealtime(), whatsapp)
    await expect(svc.handleInbound(args())).resolves.toBe(true)
  })

  it('push failure with a non-Error rejection is also swallowed', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXT_FLOW })
    const whatsapp = makeWhatsapp()
    whatsapp.sendOutbound.mockRejectedValue('boom')
    const { svc } = makeService(prisma, makeRealtime(), whatsapp)
    await expect(svc.handleInbound(args())).resolves.toBe(true)
  })
})

// ─── The customer's AI allowance, a layer above the dollar ceiling ─────

// Two limits, and they are not the same thing. The dollar ceiling below is
// OUR cost protection; this is the allowance the customer bought, counted in
// conversations the AI answered. Both end in the same handoff, and the
// allowance is asked first, because it is the one an upgrade fixes.
describe('FlowRunnerService: the AI allowance stops a flow AI reply', () => {
  const AI_FLOW = {
    groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help' } }] }],
    edges: [],
    variables: [],
  }

  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
    prisma.conversation.update.mockResolvedValue({})
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId,
      inboxId: data.inboxId, senderType: data.senderType, content: data.content ?? null,
      isPrivate: data.isPrivate ?? false, createdAt: new Date(),
    }))
  })

  it('does not gate anything while the allowance is observing', async () => {
    // This is how the feature ships: `COSMIKA_AI_ALLOWANCE_ENFORCE` unset
    // means the check logs what it WOULD have blocked and answers "allowed",
    // so a flow behaves exactly as before.
    const h = makeService(prisma)
    await h.svc.handleInbound(args())
    expect(h.ai.createMessage).toHaveBeenCalled()
    expect(h.assignment.route).not.toHaveBeenCalled()
  })

  it('a throwing allowance check leaves the flow answering, not silent', async () => {
    // The failure this guards against is specific: without a local catch the
    // throw escapes the `llm` effect, the engine catches it, the AI block
    // yields an empty reply, and the flow walks on saying nothing. That is
    // the exact outcome the `blocked` path exists to prevent, so a broken
    // meter must fail OPEN and let the model answer.
    const aiAllowance = makeAiAllowance()
    aiAllowance.check.mockRejectedValue(new Error('db down'))
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    // The harm first, so this test fails on the behaviour and not merely on
    // a missing log line: the model was called and its answer reached the
    // thread, and no empty message was written in its place.
    expect(h.ai.createMessage).toHaveBeenCalled()
    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created.some((d) => d.content === 'AI reply')).toBe(true)
    expect(created.some((d) => d.content === '')).toBe(false)
    // Nothing was handed to a person either: the flow is still running.
    expect(h.assignment.route).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('flow AI allowance check failed'),
    )
    err.mockRestore()
  })

  it('a non-Error rejection from the allowance check is handled too', async () => {
    const aiAllowance = makeAiAllowance()
    aiAllowance.check.mockRejectedValue('a string')
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    expect(h.ai.createMessage).toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('a string'))
    err.mockRestore()
  })

  it('stops the reply and hands the conversation over once it is enforced', async () => {
    const aiAllowance = makeAiAllowance()
    allowanceSpent(aiAllowance)
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    // Checked before the model, so nothing was paid for.
    expect(h.ai.createMessage).not.toHaveBeenCalled()
    expect(h.aiUsage.record).not.toHaveBeenCalled()
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
    expect(h.assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })

  it('tells the contact a person is coming, and the desk which limit it was', async () => {
    const aiAllowance = makeAiAllowance()
    allowanceSpent(aiAllowance, 'cap_reached')
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    const toContact = created.find((d) => d.isPrivate !== true)
    expect(toContact?.content).toBe(
      'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.',
    )
    // The note stays internal, and names the ceiling the customer set rather
    // than the plan allowance.
    const note = created.find((d) => d.isPrivate === true)
    expect(note?.content).toContain('teto mensal de IA')
  })

  it('asks the allowance before the dollar ceiling', async () => {
    // Same order as the orchestrator: the customer's limit first, our cost
    // protection second, because they lead to different conversations.
    const aiAllowance = makeAiAllowance()
    allowanceSpent(aiAllowance)
    const agentBots = makeAgentBots()
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots, makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    expect(agentBots.monthlyBudgetExceeded).not.toHaveBeenCalled()
  })

  it('never gates a silent classifier, whichever limit is spent', async () => {
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1',
      published: {
        groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'classify', sendMessage: false, responseVariableId: 'r' } }] }],
        edges: [], variables: [],
      },
    })
    const aiAllowance = makeAiAllowance()
    allowanceSpent(aiAllowance)
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args())

    expect(aiAllowance.check).not.toHaveBeenCalled()
    expect(h.ai.createMessage).toHaveBeenCalled()
    // Internal work: recorded, and costing no allowance.
    expect(h.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'FLOW_BLOCK', replied: false }),
    )
    expect(h.assignment.route).not.toHaveBeenCalled()
  })

  it('writes the handoff in the account language, and falls back to pt-BR', async () => {
    for (const [account, line] of [
      [{ defaultLocale: 'en' }, "I'm transferring you to our team, who will reply shortly."],
      // A conversation whose account row did not come back still gets a
      // sentence, rather than `undefined` reaching the contact.
      [null, 'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.'],
    ] as const) {
      const p2 = makePrisma()
      p2.conversation.findUnique.mockResolvedValue(conv({ account }))
      p2.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
      p2.conversation.update.mockResolvedValue({})
      p2.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'm1', accountId: data.accountId, conversationId: data.conversationId,
        inboxId: data.inboxId, senderType: data.senderType, content: data.content ?? null,
        isPrivate: data.isPrivate ?? false, createdAt: new Date(),
      }))
      const aiAllowance = makeAiAllowance()
      allowanceSpent(aiAllowance)
      const h = makeService(
        p2, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
        makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
      )

      await h.svc.handleInbound(args())

      const created = p2.message.create.mock.calls.map((c) => c[0].data)
      expect(created.some((d) => d.content === line)).toBe(true)
    }
  })

  it('stops the deviation classifier on the allowance too', async () => {
    const aiAllowance = makeAiAllowance()
    allowanceSpent(aiAllowance)
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: GUIDED_FLOW })
    const h = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), makeAgentBots(), makeAiUsage(), aiAllowance,
    )

    await h.svc.handleInbound(args({ content: 'do you ship to Brazil?' }))

    expect(h.ai.classifyDeviation).not.toHaveBeenCalled()
    expect(h.aiUsage.record).not.toHaveBeenCalled()
    // Parking silently would leave someone mid-question waiting on a bot that
    // has stopped answering, so a person takes it.
    expect(h.assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })
})

// ─── AI spend a flow makes is billed to the account ────────────────────

// Both of a flow's model calls used to report nothing, so an account whose
// whole AI story is a flow could run indefinitely past a monthly cap that
// kept reading zero. They now write to the same AiAgentSession row the
// orchestrator increments.
// Metering the flow's spend only made it visible. This is the ceiling
// actually biting on the flow paths: the AI stops answering AND a person
// takes over, instead of the flow walking on with an empty answer.
describe('FlowRunnerService: the budget stops a flow AI reply', () => {
  const AI_FLOW = {
    groups: [
      {
        id: 'g1',
        blocks: [
          { id: 'ai', type: 'OpenAI', options: { prompt: 'help' }, outgoingEdgeId: 'e1' },
        ],
      },
      { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'next step' } }] },
    ],
    edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
    variables: [],
  }

  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId,
      inboxId: data.inboxId, senderType: data.senderType, content: data.content ?? null,
      isPrivate: data.isPrivate ?? false, createdAt: new Date(),
    }))
  })

  it('never calls the model, and hands the conversation to a person', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    const { svc, ai, assignment, aiUsage } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    expect(ai.createMessage).not.toHaveBeenCalled()
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
    expect(assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })

  it('tells the contact, and tells the desk why', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    const { svc, whatsapp } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    const toContact = created.find((d) => d.isPrivate !== true && d.senderType === 'AGENT_BOT')
    expect(toContact?.content).toBe(
      'Vou transferir seu atendimento para a nossa equipe, que já vai te responder.',
    )
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511', toContact?.content)

    // The note stays internal: the customer never reads about budgets.
    const note = created.find((d) => d.isPrivate === true)
    expect(note?.content).toContain('orçamento mensal de IA desta conta acabou')
    expect(note?.content).toContain('$15.40 de $15.00')
  })

  it('stops the flow at the AI block instead of walking on with no answer', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    const contents = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    expect(contents).not.toContain('next step')
    const states = prisma.conversation.update.mock.calls.map((c) => c[0].data.flowState)
    expect(states.some((f) => f && (f as { status: string }).status === 'handoff')).toBe(true)
  })

  it('lets a silent classifier block keep running, and still meters it', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1',
      published: {
        groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'classify', sendMessage: false, responseVariableId: 'r' } }] }],
        edges: [], variables: [],
      },
    })
    const { svc, ai, assignment, aiUsage } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    // Nothing the contact reads, so nothing to gate; Nebula's allowance draws
    // the same line. The cost is still recorded.
    expect(ai.createMessage).toHaveBeenCalled()
    expect(aiUsage.record).toHaveBeenCalled()
    expect(assignment.route).not.toHaveBeenCalled()
  })

  it('answers in the account language', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ account: { defaultLocale: 'en' } }),
    )
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created.some((d) => d.content === "I'm transferring you to our team, who will reply shortly.")).toBe(true)
  })

  it('falls back to pt-BR when the account row is missing', async () => {
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    prisma.conversation.findUnique.mockResolvedValue(conv({ account: null }))
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created.some((d) => String(d.content).startsWith('Vou transferir'))).toBe(true)
  })

  it('a budget check that throws lets the flow run rather than going quiet', async () => {
    const agentBots = makeAgentBots()
    agentBots.monthlyBudgetExceeded.mockRejectedValue(new Error('db down'))
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc, ai } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    expect(ai.createMessage).toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('flow AI budget check failed'))
    err.mockRestore()
  })

  it('logs a non-Error budget failure too', async () => {
    const agentBots = makeAgentBots()
    agentBots.monthlyBudgetExceeded.mockRejectedValue('a string')
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args())

    expect(err).toHaveBeenCalledWith(expect.stringContaining('a string'))
    err.mockRestore()
  })
})

describe('FlowRunnerService: flow AI usage reaches the budget', () => {
  const AI_FLOW = {
    groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options: { prompt: 'help' } }] }],
    edges: [],
    variables: [],
  }

  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.message.create.mockResolvedValue({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'AI reply', isPrivate: false, createdAt: new Date(),
    })
  })

  it('records what the AI block spent, against the inbox bot', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      conv({ inbox: { id: 'inb1', channelType: 'WHATSAPP', flowMode: 'STRICT', defaultFlowId: 'f1', agentBotId: 'bot1' } }),
    )
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })

    const { svc, aiUsage } = makeService(prisma)
    await svc.handleInbound(args())

    expect(aiUsage.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      agentBotId: 'bot1',
      source: 'FLOW_BLOCK',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      // The block's reply reached the contact, so it spends a conversation
      // from the account's AI allowance.
      replied: true,
    })
  })

  it('records with no bot when the inbox runs a flow alone', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })

    const { svc, aiUsage } = makeService(prisma)
    await svc.handleInbound(args())

    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc1', agentBotId: undefined }),
    )
  })

  it('writes nothing when the call cost nothing (stub mode)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
    const ai = makeAi()
    ai.createMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'AI reply' }],
      stop_reason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })

    const { svc, aiUsage } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args())

    expect(aiUsage.record).not.toHaveBeenCalled()
  })

  it('a bookkeeping failure never costs the customer their answer', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
    const aiUsage = makeAiUsage()
    aiUsage.record.mockRejectedValue(new Error('db down'))
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(), makeAssignment(), makeAgentBots(), aiUsage,
    )
    await svc.handleInbound(args())

    expect(err).toHaveBeenCalledWith(expect.stringContaining('flow AI usage not recorded'))
    // The reply still went into the thread.
    expect(prisma.message.create.mock.calls.some((c) => c[0].data.content === 'AI reply')).toBe(true)
    err.mockRestore()
  })

  it('logs a non-Error bookkeeping rejection too', async () => {
    prisma.conversation.findUnique.mockResolvedValue(conv())
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AI_FLOW })
    const aiUsage = makeAiUsage()
    aiUsage.record.mockRejectedValue('a string')
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(), makeAssignment(), makeAgentBots(), aiUsage,
    )
    await svc.handleInbound(args())

    expect(err).toHaveBeenCalledWith(expect.stringContaining('a string'))
    err.mockRestore()
  })
})

// ─── GUIDED deviation handling ─────────────────────────────────────────

const GUIDED_FLOW = {
  groups: [
    { id: 'g1', blocks: [{ id: 'ci', type: 'choice input', options: { message: 'Pick', items: [{ id: 'i1', content: 'Billing', outgoingEdgeId: 'e1' }] } }] },
    { id: 'g2', blocks: [{ id: 'b2', type: 'text', options: { content: 'billing!' }}] },
  ],
  edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
  variables: [],
}
// A FRESH state parked on the choice input each call — resume() mutates state
// in place, so tests must not share one instance.
async function guidedWaiting() {
  return (await new FlowEngine(GUIDED_FLOW as never, 'GUIDED').start()).state
}

async function guidedConv(over: Record<string, unknown> = {}, devCount?: number) {
  return conv({
    inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'GUIDED', defaultFlowId: 'f1', deviationPolicy: 'answer_and_advance', maxDeviations: 3 },
    flowState: { flowId: 'f1', status: 'waiting', runtime: await guidedWaiting(), ...(devCount !== undefined ? { deviations: devCount } : {}) },
    ...over,
  })
}

describe('FlowRunnerService — GUIDED deviation', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: GUIDED_FLOW })
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId, inboxId: data.inboxId,
      senderType: data.senderType, content: data.content ?? null, isPrivate: data.isPrivate ?? false,
      createdAt: new Date('2026-06-26T00:00:00Z'),
    }))
  })

  it('over budget: skips the classifier and hands off instead of parking', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    const assignment = makeAssignment()
    const { svc, ai } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      assignment, agentBots,
    )

    await svc.handleInbound(args({ content: 'do you ship to Brazil?' }))

    // Parking silently would leave someone mid-question waiting on a bot that
    // has stopped thinking.
    expect(ai.classifyDeviation).not.toHaveBeenCalled()
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
    expect(assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')

    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created.some((d) => d.isPrivate === true && String(d.content).includes('$15.40 de $15.00'))).toBe(true)
    expect(created.some((d) => String(d.content).startsWith('Vou transferir'))).toBe(true)
  })

  it('the maxDeviations escalation wins over the budget check', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({}, 3))
    const agentBots = makeAgentBots()
    budgetSpent(agentBots)
    const { svc } = makeService(
      prisma, makeRealtime(), makeWhatsapp(), makeAi(), makeEmails(), makeTickets(),
      makeAssignment(), agentBots,
    )

    await svc.handleInbound(args({ content: 'this is going nowhere' }))

    // Already escalating; no reason to spend a budget lookup on it.
    expect(agentBots.monthlyBudgetExceeded).not.toHaveBeenCalled()
    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    // In the account's language: this line once went out in English to a
    // Brazilian lead.
    expect(created.some((d) => String(d.content).startsWith('Vou transferir'))).toBe(true)
    expect(created.some((d) => String(d.content).includes('teammate'))).toBe(false)
  })

  it.each([
    [{ defaultLocale: 'en' }, "I'm transferring you to our team"],
    [{ defaultLocale: 'es' }, 'Voy a transferir'],
    [null, 'Vou transferir'],
  ])('the maxDeviations handoff line follows the account language (%j)', async (account, start) => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({ account }, 3))
    const { svc } = makeService(prisma)
    await svc.handleInbound(args({ content: 'this is going nowhere' }))
    const created = prisma.message.create.mock.calls.map((c) => c[0].data)
    expect(created.some((d) => String(d.content).startsWith(start))).toBe(true)
  })

  it('bills the deviation classifier to the account budget', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const { svc, aiUsage } = makeService(prisma)
    await svc.handleInbound(args({ content: 'do you ship to Brazil?' }))

    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        conversationId: 'cv1',
        source: 'FLOW_DEVIATION',
        model: 'claude-haiku-4-5',
        usage: DEVIATION_USAGE,
        // AI-written prose sent to the contact: it spends a conversation.
        replied: true,
      }),
    )
  })

  it('does not bill the escalation, which never calls the model', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({}, 3))
    const { svc, ai, aiUsage } = makeService(prisma)
    await svc.handleInbound(args({ content: 'this is going nowhere' }))

    expect(ai.classifyDeviation).not.toHaveBeenCalled()
    expect(aiUsage.record).not.toHaveBeenCalled()
  })

  it('answer: emits the AI reply and stays parked (deviations incremented)', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const { svc, ai } = makeService(prisma)
    expect(await svc.handleInbound(args({ content: 'do you ship to Brazil?' }))).toBe(true)
    expect(ai.classifyDeviation).toHaveBeenCalledWith(
      expect.objectContaining({ stepIntent: 'choose one of: Billing', allowedActions: ['answer', 'fill', 'handoff'] }),
    )
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe('Sure — let me help.')
    // The AI wrote it, so the desk labels it "AI agent", not "Bot".
    expect(prisma.message.create.mock.calls[0]![0].data.contentAttributes).toEqual({ aiGenerated: true })
    const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(persisted).toMatchObject({ status: 'waiting', deviations: 1 })
  })

  it('fill: feeds the extracted value back into the flow and advances', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const ai = makeAi()
    ai.classifyDeviation.mockResolvedValue({
      action: 'fill', reply: 'Got it', value: 'Billing',
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args({ content: 'I have a billing question' }))
    const contents = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    expect(contents).toContain('Got it')
    expect(contents).toContain('billing!') // flow advanced to g2
    // Only the AI's line is marked; the flow's own line is scripted.
    const attrsOf = (text: string) =>
      prisma.message.create.mock.calls.find((c) => c[0].data.content === text)![0].data.contentAttributes
    expect(attrsOf('Got it')).toEqual({ aiGenerated: true })
    expect(attrsOf('billing!')).toEqual({})
  })

  it('fill with no extracted value falls back to staying parked', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const ai = makeAi()
    ai.classifyDeviation.mockResolvedValue({
      action: 'fill', reply: 'Hmm?', value: null,
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args({ content: 'maybe' }))
    const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(persisted).toMatchObject({ status: 'waiting', deviations: 1 })
  })

  it('exit: concludes the flow so future messages reach the AI agent', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      await guidedConv({ inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'GUIDED', defaultFlowId: 'f1', deviationPolicy: 'free_until_done', maxDeviations: 3 } }),
    )
    const ai = makeAi()
    ai.classifyDeviation.mockResolvedValue({
      action: 'exit', reply: 'No problem!', value: null,
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args({ content: 'just browsing' }))
    const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(persisted).toEqual({ flowId: 'f1', status: 'completed' })
  })

  it('handoff (AI-chosen): replies + flips to HUMAN', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const ai = makeAi()
    ai.classifyDeviation.mockResolvedValue({
      action: 'handoff', reply: 'One sec', value: null,
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    })
    const { svc, assignment } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args({ content: 'I want a human' }))
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
    expect(assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })

  it('forces handoff (without calling the AI) once maxDeviations is exceeded', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({}, 3)) // already at the cap
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args({ content: 'still off-script' }))
    expect(ai.classifyDeviation).not.toHaveBeenCalled()
    const updates = prisma.conversation.update.mock.calls.map((c) => c[0].data)
    expect(updates).toContainEqual({ controlMode: 'HUMAN' })
  })

  it('an unknown policy falls back to answer-only', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      await guidedConv({ inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'GUIDED', defaultFlowId: 'f1', deviationPolicy: 'bogus', maxDeviations: 3 } }),
    )
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args({ content: 'x' }))
    expect(ai.classifyDeviation).toHaveBeenCalledWith(
      expect.objectContaining({ allowedActions: ['answer', 'handoff'] }),
    )
  })

  it('defaults policy + maxDeviations when the inbox omits them', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      await guidedConv({ inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'GUIDED', defaultFlowId: 'f1' } }),
    )
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args({ content: 'x' }))
    // default policy = answer_and_return → allowed ['answer']
    expect(ai.classifyDeviation).toHaveBeenCalledWith(
      expect.objectContaining({ allowedActions: ['answer', 'handoff'] }),
    )
  })

  it('an empty AI reply produces no message', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    const ai = makeAi()
    ai.classifyDeviation.mockResolvedValue({
      action: 'answer', reply: '', value: null,
      model: 'claude-haiku-4-5',
      usage: DEVIATION_USAGE,
    })
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    await svc.handleInbound(args({ content: 'x' }))
    expect(prisma.message.create).not.toHaveBeenCalled()
  })
})

describe('describeStep', () => {
  it('describes a choice step with its options', () => {
    expect(describeStep({ type: 'choice input', options: { items: [{ content: 'A' }, { content: 'B' }] } })).toBe('choose one of: A, B')
  })
  it('choice with no labelled items → generic selection', () => {
    expect(describeStep({ type: 'choice input', options: { items: [] } })).toBe('make a selection')
  })
  it('choice with no items key (non-array) → generic selection', () => {
    expect(describeStep({ type: 'choice input', options: {} })).toBe('make a selection')
  })
  it('reads choice items off the block directly (no options wrapper); skips blank labels', () => {
    expect(describeStep({ type: 'choice input', items: [{ content: 'A' }, {}] })).toBe('choose one of: A')
  })
  it('block with no type → the current step', () => {
    expect(describeStep({})).toBe('the current step')
  })
  it('describes typed-input intents', () => {
    expect(describeStep({ type: 'email input', options: {} })).toBe('provide their email address')
    expect(describeStep({ type: 'phone number input', options: {} })).toBe('provide their phone number')
    expect(describeStep({ type: 'number input', options: {} })).toBe('provide a number')
  })
  it('falls back for null block / unknown type', () => {
    expect(describeStep(null)).toBe('the current step')
    expect(describeStep({ type: 'mystery', options: {} })).toBe('the current step')
  })
})

describe('collectLinkIds', () => {
  it('collects string and numeric cosmoflowIds; ignores non-links and missing ids', () => {
    const def = {
      groups: [
        { id: 'g1', blocks: [
          { type: 'Cosmoflow link', options: { cosmoflowId: 'a' } },
          { type: 'Cosmoflow link', options: { cosmoflowId: 42 } }, // numeric → '42'
          { type: 'Cosmoflow link', options: {} }, // no id → skipped
          { type: 'text', options: { content: 'hi' } },
        ] },
        { id: 'g2', blocks: 'not-an-array' }, // non-array blocks → skipped
      ],
    }
    expect(collectLinkIds(def)).toEqual(['a', '42'])
  })
  it('returns [] for a def with no groups array', () => {
    expect(collectLinkIds({ groups: 'nope' })).toEqual([])
    expect(collectLinkIds(null)).toEqual([])
  })
})

describe('FlowRunnerService — AI deviation daily cap', () => {
  let prisma: Prisma
  const CAP_ENV = 'COSMIKA_DEVIATION_DAILY_CAP'
  let savedCap: string | undefined

  beforeEach(() => {
    savedCap = process.env[CAP_ENV]
    prisma = makePrisma()
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: GUIDED_FLOW })
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId, inboxId: data.inboxId,
      senderType: data.senderType, content: data.content ?? null, isPrivate: data.isPrivate ?? false,
      createdAt: new Date('2026-06-26T00:00:00Z'),
    }))
  })

  afterEach(() => {
    if (savedCap === undefined) delete process.env[CAP_ENV]
    else process.env[CAP_ENV] = savedCap
    vi.useRealTimers()
  })

  it('over the cap: parks silently without calling the AI, warns once', async () => {
    process.env[CAP_ENV] = '1'
    const ai = makeAi()
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    try {
      // 1st deviation: within cap → AI called
      prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
      await svc.handleInbound(args({ content: 'off-script 1' }))
      expect(ai.classifyDeviation).toHaveBeenCalledTimes(1)
      // 2nd + 3rd: over cap → no AI call, no reply emitted, still parked
      for (const n of [2, 3]) {
        prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
        await svc.handleInbound(args({ content: `off-script ${n}` }))
      }
      expect(ai.classifyDeviation).toHaveBeenCalledTimes(1)
      expect(prisma.message.create.mock.calls.length).toBe(1) // only the 1st AI reply
      const persisted = prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
      expect(persisted).toMatchObject({ status: 'waiting', deviations: 1 })
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('deviation cap')).length).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('resets the counter on day rollover', async () => {
    process.env[CAP_ENV] = '1'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T23:59:00Z'))
    const ai = makeAi()
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    await svc.handleInbound(args({ content: 'a' }))
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    await svc.handleInbound(args({ content: 'b' })) // over cap today
    expect(ai.classifyDeviation).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-08-06T00:01:00Z')) // next day → counter resets
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    await svc.handleInbound(args({ content: 'c' }))
    expect(ai.classifyDeviation).toHaveBeenCalledTimes(2)
  })

  it('cap of 0 or a non-numeric value disables capping', async () => {
    const ai = makeAi()
    const { svc } = makeService(prisma, makeRealtime(), makeWhatsapp(), ai)
    for (const [i, v] of ['0', 'not-a-number'].entries()) {
      process.env[CAP_ENV] = v
      prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
      await svc.handleInbound(args({ content: `x${i}` }))
    }
    expect(ai.classifyDeviation).toHaveBeenCalledTimes(2)
  })
})

// ---- AI block vision: the runner fetches and encodes what the engine names ----

describe('FlowRunnerService — AI block media', () => {
  const prisma = makePrisma()
  const aiFlow = (options: Record<string, unknown>) => ({
    groups: [{ id: 'g1', blocks: [{ id: 'ai', type: 'OpenAI', options }] }],
    edges: [],
    variables: [],
  })

  const mediaResponse = (type: string, bytes: number) => ({
    ok: true,
    headers: { get: () => `${type}; charset=utf-8` },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  })

  // Seed the URL variables by resuming a flow that already captured them —
  // the Code-block route is a no-op under vitest (the isolated-vm addon is
  // never loaded in tests), so it can't stand in for a file-input block.
  async function run(options: Record<string, unknown>, vars: Record<string, unknown>) {
    const published = {
      groups: [
        { id: 'g1', blocks: [{ id: 'in', type: 'text input', options: { variableId: 'ack' }, outgoingEdgeId: 'e1' }] },
        { id: 'g2', blocks: [{ id: 'ai', type: 'OpenAI', options }] },
      ],
      edges: [{ id: 'e1', from: {}, to: { groupId: 'g2' } }],
      variables: [],
    }
    const waiting = (await new FlowEngine(published as never).start()).state
    waiting.variables = { ...waiting.variables, ...vars }

    prisma.conversation.findUnique.mockResolvedValue(
      conv({ flowState: { flowId: 'f1', status: 'waiting', runtime: waiting } }),
    )
    prisma.conversation.update.mockResolvedValue({})
    prisma.message.create.mockResolvedValue({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: false, createdAt: new Date(),
    })
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published })

    const ai = makeAi()
    const wa = makeWhatsapp()
    const svc = new FlowRunnerService(
      prisma as never,
      makeRealtime() as never,
      wa as never,
      ai as never,
      makeEmails() as never,
      makeTickets() as never,
      makeAssignment() as never,
      makeAgentBots() as never,
      makeAiUsage() as never,
      makeAiAllowance() as never,
      makeFlowAgent() as never,
      channelsOver(wa) as never,
    )
    await svc.handleInbound(args({ content: 'ok' }))
    return { ai, content: ai.createMessage.mock.calls[0]![0].messages[0].content }
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('encodes an image and a PDF as base64 blocks ahead of the prompt', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(mediaResponse('image/png', 8))
        .mockResolvedValueOnce(mediaResponse('application/pdf', 16)),
    )
    const { content } = await run(
      { prompt: 'Analise', imageVariableIds: ['docs'] },
      { docs: ['https://f.example/a.png', 'https://f.example/b.pdf'] },
    )
    expect(content.map((b: { type: string }) => b.type)).toEqual([
      'image', 'document', 'text',
    ])
    expect(content[0].source).toMatchObject({ type: 'base64', media_type: 'image/png' })
  })

  it('skips an unsupported type rather than failing the block', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mediaResponse('text/html', 8)))
    const { content } = await run(
      { prompt: 'p', imageVariableIds: ['docs'] },
      { docs: 'https://f.example/page.html' },
    )
    expect(content).toEqual([{ type: 'text', text: 'p' }])
  })

  it('skips a response with no content-type rather than guessing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    const { content } = await run(
      { prompt: 'p', imageVariableIds: ['docs'] },
      { docs: 'https://f.example/mystery' },
    )
    expect(content).toHaveLength(1)
  })

  it('skips a file over the size cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mediaResponse('image/png', 6 * 1024 * 1024)),
    )
    const { content } = await run(
      { prompt: 'p', imageVariableIds: ['docs'] },
      { docs: 'https://f.example/huge.png' },
    )
    expect(content).toHaveLength(1)
  })

  it('skips a URL the server rejects, and one that throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockRejectedValueOnce('boom'),
    )
    const { content } = await run(
      { prompt: 'p', imageVariableIds: ['docs'] },
      { docs: ['https://f.example/gone.png', 'https://f.example/dead.png'] },
    )
    expect(content).toHaveLength(1)
  })

  it('caps how many files one block can pull in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mediaResponse('image/png', 4)))
    const { content } = await run(
      { prompt: 'p', imageVariableIds: ['docs'] },
      { docs: Array.from({ length: 9 }, (_, i) => `https://f.example/${i}.png`) },
    )
    // 5 media blocks + the prompt.
    expect(content).toHaveLength(6)
  })
})

// A migrated flow's first Code block branches on `user.whatsapp_number` /
// `user.webchat_id`. Started with an empty bag it set nothing and every
// channel Condition fell through — a WhatsApp lead got the Facebook greeting.
describe('FlowRunnerService — seeded contact variables', () => {
  const ECHO_FLOW = {
    groups: [
      {
        id: 'g1',
        blocks: [
          {
            id: 'b1',
            type: 'text',
            options: { content: 'wa=[{{whatsapp_number}}] web=[{{webchat_id}}] nome=[{{first_name}}]' },
          },
        ],
      },
    ],
    edges: [],
    variables: [],
  }

  function run(over: Record<string, unknown> = {}, externalId: string | null = '3331') {
    const prisma = makePrisma()
    prisma.message.create.mockResolvedValue({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: false, createdAt: new Date(),
    })
    prisma.conversation.findUnique.mockResolvedValue(conv(over))
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', externalId, published: ECHO_FLOW,
    })
    return makeService(prisma)
  }

  /** What the contact actually received, which is what seeding is for. */
  function sent(prisma: Prisma): string {
    return prisma.message.create.mock.calls[0]![0].data.content as string
  }

  it('seeds whatsapp_number and the contact name on a WhatsApp inbox', async () => {
    const { svc, prisma } = run({ contactInbox: { sourceId: '5511999' } })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('wa=[+5511] web=[] nome=[Ana]')
  })

  it('falls back to the channel source id when the contact has no phone', async () => {
    const { svc, prisma } = run({
      contact: { name: 'Ana', email: null, phoneNumber: null },
      contactInbox: { sourceId: '5511999' },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('wa=[5511999] web=[] nome=[Ana]')
  })

  it('seeds webchat_id on a widget inbox, and no WhatsApp number', async () => {
    const { svc, prisma } = run({
      inbox: { id: 'inb1', channelType: 'WEB_WIDGET', flowMode: 'STRICT', defaultFlowId: 'f1' },
      contact: { name: 'Ana', email: null, phoneNumber: null },
      contactInbox: { sourceId: 'visitor-9' },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('wa=[] web=[visitor-9] nome=[Ana]')
  })

  it('seeds telegram_id on a Telegram inbox', async () => {
    const { svc, prisma } = run({
      inbox: { id: 'inb1', channelType: 'TELEGRAM', flowMode: 'STRICT', defaultFlowId: 'f1' },
      contact: { name: 'Ana', email: null, phoneNumber: null },
      contactInbox: { sourceId: '777' },
    })
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', externalId: '3331',
      published: {
        ...ECHO_FLOW,
        groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'tg=[{{telegram_id}}] wa=[{{whatsapp_number}}]' } }] }],
      },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('tg=[777] wa=[]')
  })

  it.each([
    ['FACEBOOK', 'messenger_id'],
    ['INSTAGRAM', 'instagram_id'],
  ])('seeds the sender id on a %s inbox', async (channelType, variable) => {
    const { svc, prisma } = run({
      inbox: { id: 'inb1', channelType, flowMode: 'STRICT', defaultFlowId: 'f1' },
      contact: { name: 'Ana', email: null, phoneNumber: null },
      contactInbox: { sourceId: 'psid-9' },
    })
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', externalId: '3331',
      published: {
        ...ECHO_FLOW,
        groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: `id=[{{${variable}}}]` } }] }],
      },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('id=[psid-9]')
  })

  it('seeds the service protocol', async () => {
    const { svc, prisma } = run({ protocol: '20261016-000123', contactInbox: { sourceId: '5511999' } })
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', externalId: '3331',
      published: { ...ECHO_FLOW, groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text', options: { content: 'protocolo=[{{protocol}}]' } }] }] },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('protocolo=[20261016-000123]')
  })

  it('seeds no channel id on other channels, and copes with no contact inbox', async () => {
    const { svc, prisma } = run({
      inbox: { id: 'inb1', channelType: 'EMAIL', flowMode: 'STRICT', defaultFlowId: 'f1' },
      contact: { name: null, email: null, phoneNumber: null },
      contactInbox: null,
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('wa=[] web=[] nome=[]')
  })

  it('runs a flow that has no externalId of its own', async () => {
    const { svc } = run({}, null)
    expect(await svc.handleInbound(args())).toBe(true)
  })

  // The sales form asked a known customer for the company the desk already
  // had (conversation 8742, 2026-10-14).
  it('seeds custom attributes under their own keys, without overriding the core fields', async () => {
    const prisma = makePrisma()
    prisma.message.create.mockResolvedValue({
      id: 'm1', accountId: 'acc1', conversationId: 'cv1', inboxId: 'inb1',
      senderType: 'AGENT_BOT', content: 'x', isPrivate: false, createdAt: new Date(),
    })
    prisma.conversation.findUnique.mockResolvedValue(
      conv({
        contact: {
          name: 'Ana', email: null, phoneNumber: null,
          customAttributes: {
            company_name: 'Acme Ltda', seats: 3, vip: false,
            first_name: 'Hacker', cpf: 'null', tags: ['a'], plano: null,
          },
        },
      }),
    )
    prisma.flow.findUnique.mockResolvedValue({
      id: 'f1', accountId: 'acc1', externalId: '3331',
      published: {
        ...ECHO_FLOW,
        groups: [{ id: 'g1', blocks: [{ id: 'b1', type: 'text', options: {
          content: 'emp=[{{company_name}}] n=[{{seats}}] vip=[{{vip}}] nome=[{{first_name}}] cpf=[{{cpf}}] tags=[{{tags}}] plano=[{{plano}}]',
        } }] }],
      },
    })
    const { svc } = makeService(prisma)
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('emp=[Acme Ltda] n=[3] vip=[false] nome=[Ana] cpf=[] tags=[] plano=[]')
  })

  it('copes with custom attributes that are not an object', async () => {
    const { svc, prisma } = run({
      contact: { name: 'Ana', email: null, phoneNumber: null, customAttributes: ['x'] },
    })
    await svc.handleInbound(args())
    expect(sent(prisma)).toBe('wa=[] web=[] nome=[Ana]')
  })
})

// Conversation 8741 (2026-10-13): the classifier saw one sentence and asked a
// customer with a stopped bot for an order number.
describe('FlowRunnerService — the off-script classifier reads the conversation', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: GUIDED_FLOW })
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId, inboxId: data.inboxId,
      senderType: data.senderType, content: data.content ?? null, isPrivate: false,
      createdAt: new Date('2026-06-26T00:00:00Z'),
    }))
  })

  it('passes the last messages oldest first, labelled, plus the business and its language', async () => {
    prisma.conversation.findUnique.mockResolvedValue(
      await guidedConv({ account: { defaultLocale: 'pt-BR', name: 'CosmoBots' } }),
    )
    // newest first, as the query returns them
    prisma.message.findMany.mockResolvedValue([
      { senderType: 'CONTACT', content: 'Precisamos resolver' },
      { senderType: 'USER', content: 'Oi, aqui é a equipe' },
      { senderType: 'AGENT_BOT', content: '   ' },
      { senderType: 'AGENT_BOT', content: 'Qual o site?' },
      { senderType: 'CONTACT', content: 'Meu bot\nestá parado ' + 'x'.repeat(400) },
      { senderType: 'SYSTEM', content: null },
    ])
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args({ content: 'Precisamos resolver' }))

    // Public messages from the three speakers only: notes and drafts were
    // never said to the customer.
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isPrivate: false, senderType: { in: ['CONTACT', 'AGENT_BOT', 'USER'] } }),
        take: 12,
      }),
    )
    const call = ai.classifyDeviation.mock.calls[0]![0]
    expect(call).toMatchObject({ businessName: 'CosmoBots', locale: 'pt-BR' })
    const lines = String(call.transcript).split('\n')
    expect(lines).toEqual([
      `Cliente: Meu bot está parado ${'x'.repeat(300 - 'Meu bot está parado '.length)}…`,
      'Bot: Qual o site?',
      'Atendente: Oi, aqui é a equipe',
      'Cliente: Precisamos resolver',
    ])
  })

  it('labels a sender it does not know as the bot', async () => {
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv())
    prisma.message.findMany.mockResolvedValue([{ senderType: 'OTHER', content: 'olá' }])
    const { svc, ai } = makeService(prisma)
    await svc.handleInbound(args({ content: 'olá' }))
    expect(ai.classifyDeviation.mock.calls[0]![0].transcript).toBe('Bot: olá')
  })
})

describe('FlowRunnerService — off-script handling with no account language', () => {
  it('falls back to Portuguese for both the classifier and the escalation line', async () => {
    const prisma = makePrisma()
    prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: GUIDED_FLOW })
    prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'm1', accountId: data.accountId, conversationId: data.conversationId, inboxId: data.inboxId,
      senderType: data.senderType, content: data.content ?? null, isPrivate: false, createdAt: new Date(),
    }))
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({ account: null }))
    const first = makeService(prisma)
    await first.svc.handleInbound(args({ content: 'oi' }))
    expect(first.ai.classifyDeviation.mock.calls[0]![0]).toMatchObject({ locale: 'pt-BR', businessName: undefined })

    prisma.message.create.mockClear()
    prisma.conversation.findUnique.mockResolvedValue(await guidedConv({ account: null }, 3))
    await makeService(prisma).svc.handleInbound(args({ content: 'oi' }))
    const sent = prisma.message.create.mock.calls.map((c) => c[0].data.content)
    expect(sent).toContain('Vou transferir seu atendimento para a nossa equipe, que já vai te responder.')
  })
})


describe('FlowRunnerService: AI agent block (PoC items 03/04/07)', () => {
  const AGENT_FLOW = {
    groups: [
      { id: 'g1', blocks: [{ id: 'ag', type: 'AI agent', options: { agentBotId: 'bot-fin', maxAiTurns: 2, instructions: 'Só anuidade.' }, outgoingEdgeId: 'e1' }] },
      { id: 'g2', blocks: [{ id: 'cd', type: 'Cosmodesk', options: { assigningMessage: 'Um atendente vai continuar.' } }] },
    ],
    edges: [{ id: 'e1', from: { blockId: 'ag' }, to: { groupId: 'g2' } }],
    variables: [],
  }
  const waitingOnAgent = (turns: number) => ({
    flowId: 'f1',
    status: 'waiting',
    runtime: {
      currentFlowId: '$root', currentGroupId: 'g1', currentBlockId: 'ag',
      variables: {}, retryCounts: {}, visitCounts: {}, stack: [],
      agent: { blockId: 'ag', since: '2026-10-16T12:00:00.000Z', turns },
    },
  })
  const setup = (flowState: unknown = null, over: Record<string, unknown> = {}) => {
    const m = makeService()
    m.prisma.conversation.findUnique.mockResolvedValue(conv({ flowState, ...over }))
    m.prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: AGENT_FLOW })
    m.prisma.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `m${m.prisma.message.create.mock.calls.length}`, createdAt: new Date(), isPrivate: false, ...data,
    }))
    return m
  }
  const sent = (m: ReturnType<typeof setup>) =>
    m.whatsapp.sendOutbound.mock.calls.map((c: unknown[]) => c[2])

  it('opens in character, bills the agent that spoke, and waits on the block', async () => {
    const m = setup()
    expect(await m.svc.handleInbound(args({ content: 'Financeiro' }))).toBe(true)
    expect(m.flowAgent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1', conversationId: 'cv1', contactId: 'ct1', agentBotId: 'bot-fin',
        userText: null, instructions: 'Só anuidade.', offTopic: 'refuse', locale: 'pt-BR',
      }),
    )
    expect(sent(m)).toEqual(['Sou a Ana, do Financeiro.'])
    expect(m.aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'AGENT_BOT', agentBotId: 'bot-fin', replied: true, usage: AGENT_USAGE }),
    )
    const saved = m.prisma.conversation.update.mock.calls.at(-1)![0].data.flowState
    expect(saved.status).toBe('waiting')
    expect(saved.runtime.agent).toMatchObject({ blockId: 'ag', turns: 0 })
  })

  it('answers in the same conversation until maxAiTurns, then takes the transfer edge', async () => {
    const m = setup(waitingOnAgent(1))
    await m.svc.handleInbound(args({ content: 'Quanto custa a anuidade?' }))
    expect(m.flowAgent.runTurn.mock.calls[0]![0]).toMatchObject({
      userText: 'Quanto custa a anuidade?', since: '2026-10-16T12:00:00.000Z',
    })
    expect(sent(m)).toEqual(['Sou a Ana, do Financeiro.', 'Um atendente vai continuar.'])
    expect(m.prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'cv1' }, data: { controlMode: 'HUMAN' } })
    expect(m.assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })

  it('a spent allowance hands over before any model call', async () => {
    const m = setup(waitingOnAgent(0))
    allowanceSpent(m.aiAllowance)
    await m.svc.handleInbound(args())
    expect(m.flowAgent.runTurn).not.toHaveBeenCalled()
    expect(sent(m)).toEqual(['Vou transferir seu atendimento para a nossa equipe, que já vai te responder.'])
  })

  it('an agent over its daily budget, or gone, hands over with a note for the desk', async () => {
    const daily = setup(waitingOnAgent(0))
    daily.flowAgent.runTurn.mockResolvedValue({ kind: 'unavailable', reason: 'daily_budget', botName: 'Financeiro' })
    await daily.svc.handleInbound(args())
    const notes = (mm: ReturnType<typeof setup>) =>
      mm.prisma.message.create.mock.calls.map((c: Array<{ data: { content: string; isPrivate?: boolean } }>) => c[0].data).filter((d) => d.isPrivate)
    expect(notes(daily)[0]!.content).toContain('"Financeiro"')

    const gone = setup(waitingOnAgent(0))
    gone.flowAgent.runTurn.mockResolvedValue({ kind: 'unavailable', reason: 'missing', botName: '' })
    await gone.svc.handleInbound(args())
    expect(notes(gone)[0]!.content).toContain('indisponível')
  })

  it('a failing agent goes to a person, never to silence', async () => {
    const m = setup(waitingOnAgent(0), { account: null })
    m.flowAgent.runTurn.mockRejectedValue(new Error('provider down'))
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await m.svc.handleInbound(args())
    expect(m.flowAgent.runTurn.mock.calls[0]![0].locale).toBe('pt-BR')
    expect(sent(m)).toEqual(['Vou transferir seu atendimento para a nossa equipe, que já vai te responder.'])
    expect(m.assignment.route).toHaveBeenCalledWith('cv1', 'bot_handoff')
  })

  it('a non-Error throw is logged as text', async () => {
    const m = setup(waitingOnAgent(0))
    m.flowAgent.runTurn.mockRejectedValue('boom')
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    await m.svc.handleInbound(args())
    expect(log.mock.calls.some((c) => String(c[0]).includes('boom'))).toBe(true)
  })

  it('a burst of messages while the agent holds the conversation gets ONE turn, answered once', async () => {
    const m = setup(waitingOnAgent(0))
    const calls = ['oi', 'tudo bem?', 'quero a 2a via'].map((content) => m.svc.handleInbound(args({ content })))
    // The first to settle is an earlier, folded message: by then the answer is out.
    const first = await Promise.race(calls)
    expect(first).toBe(true)
    expect(sent(m)).toEqual(['Sou a Ana, do Financeiro.'])
    expect(await Promise.all(calls)).toEqual([true, true, true])
    expect(m.flowAgent.runTurn).toHaveBeenCalledTimes(1)
    expect(m.flowAgent.runTurn.mock.calls[0]![0].userText).toBe('quero a 2a via')
    expect((m.svc as unknown as { lanes: Map<string, unknown> }).lanes.size).toBe(0)
  })

  it("outside an agent, a conversation's messages run in order, each on the state the previous saved", async () => {
    const m = makeService()
    m.prisma.conversation.findUnique.mockResolvedValue(conv())
    m.prisma.flow.findUnique.mockResolvedValue({ id: 'f1', accountId: 'acc1', published: TEXTINPUT_FLOW })
    m.prisma.message.create.mockResolvedValue({ id: 'm1', createdAt: new Date(), isPrivate: false })
    await Promise.all([m.svc.handleInbound(args({ content: 'a' })), m.svc.handleInbound(args({ content: 'b' }))])
    const reads = m.prisma.conversation.findUnique.mock.invocationCallOrder
    const writes = m.prisma.conversation.update.mock.invocationCallOrder
    // The second message is read only after the first one's state was written.
    expect(reads).toHaveLength(2)
    expect(writes.some((w: number) => w > reads[0]! && w < reads[1]!)).toBe(true)
  })

  it('a failed message does not stall the ones behind it', async () => {
    const m = setup(waitingOnAgent(0))
    m.prisma.conversation.findUnique.mockRejectedValueOnce(new Error('db blip'))
    const [a, b] = [m.svc.handleInbound(args({ content: 'x' })), m.svc.handleInbound(args({ content: 'y' }))]
    await expect(a).rejects.toThrow('db blip')
    expect(await b).toBe(true)
    expect(m.flowAgent.runTurn).toHaveBeenCalledTimes(1)
  })

  it('an empty reply does not count as answered', async () => {
    const m = setup(waitingOnAgent(0))
    m.flowAgent.runTurn.mockResolvedValue({ kind: 'reply', text: '', handoff: false, botId: 'bot-fin', model: 'm', usage: AGENT_USAGE })
    await m.svc.handleInbound(args())
    expect(m.aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({ replied: false }))
  })
})
