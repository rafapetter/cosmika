import { describe, expect, it, vi } from 'vitest'

import { FlowAgentService, TRANSFER_TOOL, buildFlowAgentPrompt } from './flow-agent.service'

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 }

const BOT = {
  id: 'bot-fin',
  accountId: 'acc1',
  name: 'Financeiro',
  systemPrompt: 'Você é a Ana, do Financeiro da Acme. Fala de anuidade e boletos.',
  model: 'claude-haiku-4-5',
  temperature: 0.3,
  toolsEnabled: [],
  knowledgeTags: ['financeiro'],
  dailyBudgetUsd: 10,
  isActive: true,
}

function tool(name: string, destructive = false) {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object' },
    destructive,
    handler: vi.fn().mockResolvedValue({ output: { ok: true, from: name } }),
  }
}

function setup(over: { bot?: Record<string, unknown> | null; dialogue?: unknown[]; before?: unknown[] } = {}) {
  const tools = [
    tool('search_knowledge_base'),
    tool('read_knowledge_base_article'),
    tool('attach_tag'),
    tool('assign_conversation_to_human'),
    tool('dangerous', true),
  ]
  const prisma = {
    agentBot: { findFirst: vi.fn().mockResolvedValue(over.bot === undefined ? BOT : over.bot) },
    message: {
      findMany: vi.fn().mockImplementation(async ({ where }: { where: { createdAt: { gte?: Date } } }) =>
        where.createdAt.gte ? over.dialogue ?? [] : over.before ?? [],
      ),
    },
  }
  const anthropic = {
    isAvailable: vi.fn().mockReturnValue(true),
    createMessage: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Olá! Sou a Ana.' }],
      stop_reason: 'end_turn',
      usage: USAGE,
    }),
  }
  const aiTools = { all: vi.fn().mockReturnValue(tools) }
  const aiUsage = { botCostLast24h: vi.fn().mockResolvedValue(0) }
  const svc = new FlowAgentService(prisma as never, anthropic as never, aiTools as never, aiUsage as never)
  return { svc, prisma, anthropic, tools, aiUsage }
}

const INPUT = {
  accountId: 'acc1',
  conversationId: 'cv1',
  contactId: 'ct1',
  agentBotId: 'bot-fin',
  since: '2026-10-16T12:00:00.000Z',
  userText: null,
  instructions: '',
  offTopic: 'refuse' as const,
  locale: 'pt-BR',
}

describe('FlowAgentService.runTurn: availability', () => {
  it('only loads agents of the same account', async () => {
    const m = setup({ bot: null })
    expect(await m.svc.runTurn(INPUT)).toEqual({ kind: 'unavailable', reason: 'missing', botName: '' })
    expect(m.prisma.agentBot.findFirst).toHaveBeenCalledWith({ where: { id: 'bot-fin', accountId: 'acc1' } })
  })

  it('a switched-off agent is missing', async () => {
    const m = setup({ bot: { ...BOT, isActive: false } })
    expect((await m.svc.runTurn(INPUT)).kind).toBe('unavailable')
  })

  it('no AI client for the model', async () => {
    const m = setup()
    m.anthropic.isAvailable.mockReturnValue(false)
    expect(await m.svc.runTurn(INPUT)).toEqual({ kind: 'unavailable', reason: 'no_client', botName: 'Financeiro' })
  })

  it('its own daily budget is spent', async () => {
    const m = setup()
    m.aiUsage.botCostLast24h.mockResolvedValue(10)
    expect(await m.svc.runTurn(INPUT)).toEqual({ kind: 'unavailable', reason: 'daily_budget', botName: 'Financeiro' })
  })
})

describe('FlowAgentService.runTurn: the conversation', () => {
  it('opens in character with the persona, read-only tools and the transfer tool', async () => {
    const m = setup()
    const out = await m.svc.runTurn(INPUT)
    expect(out).toEqual({
      kind: 'reply', text: 'Olá! Sou a Ana.', handoff: false, botId: 'bot-fin', model: 'claude-haiku-4-5', usage: USAGE,
    })
    const call = m.anthropic.createMessage.mock.calls[0]![0]
    expect(call.model).toBe('claude-haiku-4-5')
    expect(call.temperature).toBe(0.3)
    expect(call.systemPrompt.startsWith(BOT.systemPrompt)).toBe(true)
    expect(call.tools.map((t: { name: string }) => t.name)).toEqual([
      'search_knowledge_base', 'read_knowledge_base_article', TRANSFER_TOOL,
    ])
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].content[0].text).toContain('Greet the customer')
  })

  it('respects the bot tool list', async () => {
    const m = setup({ bot: { ...BOT, toolsEnabled: [{ name: 'read_knowledge_base_article' }, { name: 'attach_tag' }, null] } })
    await m.svc.runTurn(INPUT)
    const names = m.anthropic.createMessage.mock.calls[0]![0].tools.map((t: { name: string }) => t.name)
    // A tool that writes is never offered here, even when the bot has it.
    expect(names).toEqual(['read_knowledge_base_article', TRANSFER_TOOL])
    // Without the knowledge tools the prompt forbids inventing instead.
    expect(m.anthropic.createMessage.mock.calls[0]![0].systemPrompt).toContain('Never invent')
  })

  it('treats a non-array tool list as "all"', async () => {
    const m = setup({ bot: { ...BOT, toolsEnabled: null } })
    await m.svc.runTurn(INPUT)
    expect(m.anthropic.createMessage.mock.calls[0]![0].tools).toHaveLength(3)
  })

  it('reads its dialogue from the thread as alternating turns, user first', async () => {
    const m = setup({
      // newest first, as the query returns it
      dialogue: [
        { senderType: 'CONTACT', content: 'Quanto custa?' },
        { senderType: 'CONTACT', content: 'Oi' },
        { senderType: 'USER', content: '' },
        { senderType: 'AGENT_BOT', content: 'Sou a Ana.' },
      ],
      before: [{ senderType: 'CONTACT', content: 'Financeiro' }],
    })
    await m.svc.runTurn({ ...INPUT, userText: 'Quanto custa?' })
    const call = m.anthropic.createMessage.mock.calls[0]![0]
    expect(call.messages.map((t: { role: string; content: Array<{ text: string }> }) => [t.role, t.content[0]!.text])).toEqual([
      ['user', '(The flow routed the customer to you.)'],
      ['assistant', 'Sou a Ana.'],
      ['user', 'Oi\n\nQuanto custa?'],
    ])
    expect(call.systemPrompt).toContain('Cliente: Financeiro')
    // Only this conversation, public messages after the block took over.
    expect(m.prisma.message.findMany.mock.calls[1]![0].where).toMatchObject({
      conversationId: 'cv1', isPrivate: false, createdAt: { gte: new Date(INPUT.since) },
    })
  })

  it("adds the customer's text when the thread does not end on it yet", async () => {
    const m = setup({ dialogue: [{ senderType: 'AGENT_BOT', content: 'Sou a Ana.' }, { senderType: 'CONTACT', content: null }] })
    await m.svc.runTurn({ ...INPUT, userText: 'oi' })
    const msgs = m.anthropic.createMessage.mock.calls[0]![0].messages
    expect(msgs.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'oi' }] })
  })

  it('searches only its own base and reports a transfer wish', async () => {
    const m = setup()
    m.anthropic.createMessage
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Vou verificar.' },
          { type: 'tool_use', id: 't1', name: 'search_knowledge_base', input: { query: 'anuidade' } },
          { type: 'tool_use', id: 't2', name: 'nope', input: {} },
          { type: 'tool_use', id: 't3', name: TRANSFER_TOOL, input: {} },
        ],
        stop_reason: 'tool_use',
        usage: USAGE,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'A anuidade vence em março. Um atendente continua.' }],
        stop_reason: 'end_turn',
        usage: USAGE,
      })
    const out = await m.svc.runTurn({ ...INPUT, userText: 'anuidade?' })
    expect(m.tools[0]!.handler).toHaveBeenCalledWith(
      { query: 'anuidade' },
      { accountId: 'acc1', conversationId: 'cv1', contactId: 'ct1', knowledgeTags: ['financeiro'] },
      expect.anything(),
    )
    const second = m.anthropic.createMessage.mock.calls[1]![0].messages
    const results = second.at(-1).content
    expect(results[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ ok: true, from: 'search_knowledge_base' }) })
    expect(results[1]).toMatchObject({ tool_use_id: 't2', is_error: true })
    expect(results[2]).toMatchObject({ tool_use_id: 't3' })
    expect(out).toMatchObject({
      kind: 'reply',
      handoff: true,
      text: 'Vou verificar.\n\nA anuidade vence em março. Um atendente continua.',
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 4 },
    })
  })

  it('a failing tool is reported to the model, not thrown', async () => {
    const m = setup()
    m.tools[0]!.handler.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce('boom')
    const toolTurn = {
      content: [{ type: 'tool_use', id: 't1', name: 'search_knowledge_base', input: {} }],
      stop_reason: 'tool_use',
      usage: USAGE,
    }
    m.anthropic.createMessage.mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(toolTurn)
    await m.svc.runTurn(INPUT)
    const third = m.anthropic.createMessage.mock.calls[2]![0].messages
    expect(third.at(-3).content[0]).toMatchObject({ content: 'Error: db down', is_error: true })
    expect(third.at(-1).content[0]).toMatchObject({ content: 'Error: boom', is_error: true })
  })

  it('stops after a bounded number of rounds, and keeps one copy of a repeated line', async () => {
    const m = setup()
    m.anthropic.createMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'Um momento.' }, { type: 'tool_use', id: 't', name: 'search_knowledge_base', input: {} }],
      stop_reason: 'tool_use',
      usage: USAGE,
    })
    const out = await m.svc.runTurn(INPUT)
    expect(m.anthropic.createMessage).toHaveBeenCalledTimes(4)
    expect(out).toMatchObject({ text: 'Um momento.', handoff: false })
  })

  it('rounds that run out with nothing said get one more round asking for text', async () => {
    const m = setup()
    const toolTurn = {
      content: [{ type: 'tool_use', id: 't', name: 'search_knowledge_base', input: { query: 'x' } }],
      stop_reason: 'tool_use',
      usage: USAGE,
    }
    m.anthropic.createMessage
      .mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce(toolTurn).mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'A anuidade vence em março.' }], stop_reason: 'end_turn', usage: USAGE })
    const out = await m.svc.runTurn({ ...INPUT, userText: 'anuidade?' })
    expect(m.anthropic.createMessage).toHaveBeenCalledTimes(5)
    const last = m.anthropic.createMessage.mock.calls[4]![0]
    // The tools stay declared (the API wants them with tool history) and the
    // last user turn asks for an answer now.
    expect(last.tools).toHaveLength(3)
    expect(last.messages.at(-1).content.at(-1)).toEqual({ type: 'text', text: expect.stringContaining('Reply to the customer now') })
    expect(out).toMatchObject({ text: 'A anuidade vence em março.', handoff: false })
  })

  it('a turn that still says nothing goes to a person instead of silence', async () => {
    const m = setup()
    m.anthropic.createMessage.mockResolvedValue({ content: [], stop_reason: 'tool_use', usage: USAGE })
    expect(await m.svc.runTurn(INPUT)).toMatchObject({ text: '', handoff: true })
    expect(m.anthropic.createMessage).toHaveBeenCalledTimes(2)
  })

  it('a message with no text (an attachment) still reaches the model as a turn', async () => {
    const m = setup({ dialogue: [{ senderType: 'AGENT_BOT', content: 'Sou a Ana.' }] })
    await m.svc.runTurn({ ...INPUT, userText: '  ' })
    const msgs = m.anthropic.createMessage.mock.calls[0]![0].messages
    expect(msgs.at(-1).content[0].text).toContain('no text')
  })
})

describe('buildFlowAgentPrompt', () => {
  const base = {
    persona: 'Persona.',
    hasKnowledgeBase: true,
    offTopic: 'refuse' as const,
    instructions: '',
    locale: 'pt-BR',
    context: '',
  }

  it('refuses off-topic questions and says what it can do', () => {
    const p = buildFlowAgentPrompt(base)
    expect(p).toContain('Brazilian Portuguese')
    expect(p).toContain('say what you can help with')
    expect(p).toContain('search_knowledge_base')
    expect(p).not.toContain('# Instructions for this step')
    expect(p).not.toContain('# Conversation before you joined')
  })

  it('or sends them to a person, with the author instructions and earlier context', () => {
    const p = buildFlowAgentPrompt({ ...base, offTopic: 'handoff', instructions: ' Só anuidade. ', context: 'Cliente: oi', locale: 'es' })
    expect(p).toContain(`a person will help with that, and call ${TRANSFER_TOOL}`)
    expect(p).toContain('# Instructions for this step of the flow\nSó anuidade.')
    expect(p).toContain('Cliente: oi')
    expect(p).toContain('Spanish')
  })

  it('falls back to Portuguese for an unknown locale', () => {
    expect(buildFlowAgentPrompt({ ...base, locale: 'fr' })).toContain('Brazilian Portuguese')
  })
})
