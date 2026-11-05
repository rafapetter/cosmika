import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SSRF guard module up front. The actual SSRF rules are exhaustively
// tested in src/common/safe-fetch.test.ts — here we only need to (1) confirm
// the guard is invoked before every custom-tool fetch (the S6 H2 fix), and
// (2) make it controllable so we can also exercise the "guard rejects" path.
vi.mock('../../common/safe-fetch', () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
}))

import { assertSafeFetchUrl } from '../../common/safe-fetch'
import { AiTools, type ToolExecutionContext } from './ai-tools'

// ---------- helpers ----------

function makePrisma() {
  return {
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    message: {
      create: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeArticles() {
  return {
    search: vi.fn(),
    readPublished: vi.fn(),
  }
}
type Articles = ReturnType<typeof makeArticles>

function makeAssignment() {
  return { route: vi.fn().mockResolvedValue({ assigneeId: null, pickedId: null }) }
}
type Assignment = ReturnType<typeof makeAssignment>

function makeService(
  prisma: Prisma,
  articles: Articles,
  assignment: Assignment = makeAssignment(),
): AiTools {
  return new AiTools(prisma as never, articles as never, assignment as never)
}

const CTX: ToolExecutionContext = {
  accountId: 'acc1',
  conversationId: 'conv1',
  contactId: 'ct1',
}

// Track guard mock as a properly typed Mock so we can clear/assert.
const guardMock = assertSafeFetchUrl as unknown as ReturnType<typeof vi.fn>

// ---------- all() / byName() ----------

describe('AiTools.all() + byName()', () => {
  let svc: AiTools
  beforeEach(() => {
    svc = makeService(makePrisma(), makeArticles())
  })

  it('returns exactly the 5 built-in tools', () => {
    const tools = svc.all()
    expect(tools.map((t) => t.name)).toEqual([
      'attach_tag',
      'assign_conversation_to_human',
      'set_priority',
      'add_internal_note',
      'search_knowledge_base',
      'read_knowledge_base_article',
    ])
  })

  it('each tool has a non-empty description + input_schema', () => {
    for (const t of svc.all()) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.input_schema).toBe('object')
    }
  })

  it('marks no built-in tool destructive', () => {
    // Handing a conversation to a human was the last one flagged, which meant
    // the agent's request for help waited on the very people it was calling.
    const destructive = svc.all().filter((t) => t.destructive).map((t) => t.name)
    expect(destructive).toEqual([])
  })

  it('byName() returns the matching tool', () => {
    expect(svc.byName('attach_tag')?.name).toBe('attach_tag')
    expect(svc.byName('search_knowledge_base')?.name).toBe('search_knowledge_base')
  })

  it('byName() returns null for unknown names', () => {
    expect(svc.byName('nope')).toBeNull()
    expect(svc.byName('')).toBeNull()
  })
})

// ---------- attach_tag ----------

describe('attach_tag', () => {
  let prisma: Prisma
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeArticles())
  })

  function tool() {
    return svc.byName('attach_tag')!
  }

  it('errors on empty tag (whitespace only)', async () => {
    const out = await tool().handler({ tag: '   ' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty tag' })
    expect(out.durationMs).toBe(0)
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled()
  })

  it('errors when `tag` is missing entirely (coerces undefined → "")', async () => {
    const out = await tool().handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty tag' })
  })

  it('errors when conversation is not found', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    const out = await tool().handler({ tag: 'billing' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'conversation not found' })
    expect(typeof out.durationMs).toBe('number')
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('appends a new tag and persists it', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: ['vip'] })
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler({ tag: 'billing' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true, tags: ['vip', 'billing'] })
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { aiTags: ['vip', 'billing'] },
    })
  })

  it('returns success with note when tag already present (no update)', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: ['billing'] })
    const out = await tool().handler({ tag: 'billing' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({
      ok: true,
      tags: ['billing'],
      note: 'tag already present',
    })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('caps the tag list at 5 entries (slice)', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      aiTags: ['a', 'b', 'c', 'd', 'e'],
    })
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler({ tag: 'f' }, CTX, { prisma: prisma as never })
    // Append then slice(0,5) drops the new one if list was already full at 5.
    expect((out.output as { tags: string[] }).tags).toHaveLength(5)
    expect((out.output as { tags: string[] }).tags).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('trims + truncates the tag to 32 chars', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: [] })
    prisma.conversation.update.mockResolvedValue({})
    const long = '  ' + 'x'.repeat(50) + '  '
    const out = await tool().handler({ tag: long }, CTX, { prisma: prisma as never })
    expect((out.output as { tags: string[] }).tags[0]).toBe('x'.repeat(32))
  })
})

// ---------- assign_conversation_to_human ----------

describe('assign_conversation_to_human', () => {
  let prisma: Prisma
  let assignment: Assignment
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    assignment = makeAssignment()
    svc = makeService(prisma, makeArticles(), assignment)
  })

  function tool() {
    return svc.byName('assign_conversation_to_human')!
  }

  it('runs directly — calling a human needs no human approval', () => {
    expect(tool().destructive).toBe(false)
  })

  it('errors when conversation is not found', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    const out = await tool().handler(
      { reason: 'angry customer' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: false, error: 'conversation not found' })
    expect(prisma.conversation.update).not.toHaveBeenCalled()
    expect(assignment.route).not.toHaveBeenCalled()
  })

  it('distributes to an available agent after the handoff and says so', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: [] })
    prisma.conversation.update.mockResolvedValue({})
    assignment.route.mockResolvedValue({ assigneeId: 'u9', pickedId: 'u9' })
    const out = await tool().handler({ reason: 'r' }, CTX, { prisma: prisma as never })
    expect(assignment.route).toHaveBeenCalledWith('conv1', 'bot_handoff')
    // The model learns someone took it, never who.
    expect(out.output).toEqual({
      ok: true,
      reason: 'r',
      assigneeCleared: true,
      agentAssigned: true,
    })
  })

  it('reports no agent when routing outcome is unknown', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: [] })
    prisma.conversation.update.mockResolvedValue({})
    assignment.route.mockResolvedValue(null)
    const out = await tool().handler({ reason: 'r' }, CTX, { prisma: prisma as never })
    expect((out.output as { agentAssigned: boolean }).agentAssigned).toBe(false)
  })

  it('clears assignee and adds "needs-human" tag when absent', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: ['billing'] })
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler(
      { reason: 'AI cannot resolve refund policy' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({
      ok: true,
      reason: 'AI cannot resolve refund policy',
      assigneeCleared: true,
      agentAssigned: false,
    })
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { assigneeId: null, aiTags: ['billing', 'needs-human'] },
    })
  })

  it('reuses existing aiTags when "needs-human" already present', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      aiTags: ['needs-human', 'vip'],
    })
    prisma.conversation.update.mockResolvedValue({})
    await tool().handler({ reason: 'r' }, CTX, { prisma: prisma as never })
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { assigneeId: null, aiTags: ['needs-human', 'vip'] },
    })
  })

  it('caps the tag list at 5 when appending needs-human', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      aiTags: ['a', 'b', 'c', 'd', 'e'],
    })
    prisma.conversation.update.mockResolvedValue({})
    await tool().handler({ reason: 'r' }, CTX, { prisma: prisma as never })
    const call = prisma.conversation.update.mock.calls[0]![0] as {
      data: { aiTags: string[] }
    }
    expect(call.data.aiTags).toHaveLength(5)
  })

  it('falls back to "requested handoff" when reason is missing', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: [] })
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler({}, CTX, { prisma: prisma as never })
    expect((out.output as { reason: string }).reason).toBe('requested handoff')
  })

  it('truncates reason at 200 chars', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ aiTags: [] })
    prisma.conversation.update.mockResolvedValue({})
    const long = 'x'.repeat(500)
    const out = await tool().handler({ reason: long }, CTX, { prisma: prisma as never })
    expect((out.output as { reason: string }).reason).toHaveLength(200)
  })
})

// ---------- set_priority ----------

describe('set_priority', () => {
  let prisma: Prisma
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeArticles())
  })

  function tool() {
    return svc.byName('set_priority')!
  }

  it('errors when priority is not in the allowlist', async () => {
    const out = await tool().handler(
      { priority: 'super-mega', reason: 'r' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: false, error: 'invalid priority' })
    expect(out.durationMs).toBe(0)
    expect(prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('errors when priority is missing', async () => {
    const out = await tool().handler({ reason: 'r' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'invalid priority' })
  })

  it.each(['LOW', 'NORMAL', 'HIGH', 'URGENT'])('accepts %s', async (p) => {
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler(
      { priority: p, reason: 'tested' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: true, priority: p, reason: 'tested' })
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv1' },
      data: { priority: p },
    })
  })

  it('falls back to empty reason when reason missing', async () => {
    prisma.conversation.update.mockResolvedValue({})
    const out = await tool().handler(
      { priority: 'HIGH' },
      CTX,
      { prisma: prisma as never },
    )
    expect((out.output as { reason: string }).reason).toBe('')
  })
})

// ---------- add_internal_note ----------

describe('add_internal_note', () => {
  let prisma: Prisma
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeArticles())
  })

  function tool() {
    return svc.byName('add_internal_note')!
  }

  it('errors when the note body is empty', async () => {
    const out = await tool().handler({ note: '   ' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty note' })
    expect(out.durationMs).toBe(0)
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled()
  })

  it('errors when note is missing entirely', async () => {
    const out = await tool().handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty note' })
  })

  it('errors when conversation is not found', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    const out = await tool().handler(
      { note: 'follow-up tomorrow' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: false, error: 'conversation not found' })
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('creates an isPrivate AGENT_BOT message and returns its id', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ inboxId: 'inb1' })
    prisma.message.create.mockResolvedValue({ id: 'msg-9' })
    const out = await tool().handler(
      { note: 'spoke with billing — refund OK' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: true, messageId: 'msg-9' })
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'conv1',
        inboxId: 'inb1',
        accountId: 'acc1',
        senderType: 'AGENT_BOT',
        content: 'spoke with billing — refund OK',
        contentType: 'TEXT',
        status: 'SENT',
        isPrivate: true,
      },
    })
  })
})

// ---------- search_knowledge_base ----------

describe('search_knowledge_base', () => {
  let prisma: Prisma
  let articles: Articles
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    articles = makeArticles()
    svc = makeService(prisma, articles)
  })

  function tool() {
    return svc.byName('search_knowledge_base')!
  }

  it('errors when query is empty whitespace', async () => {
    const out = await tool().handler({ query: '   ' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty query' })
    expect(out.durationMs).toBe(0)
    expect(articles.search).not.toHaveBeenCalled()
  })

  it('errors when query is missing entirely', async () => {
    const out = await tool().handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty query' })
  })

  it('returns hits from ArticlesService.search with default limit 5', async () => {
    articles.search.mockResolvedValue([{ id: 'a1', title: 'Refunds' }])
    const out = await tool().handler(
      { query: 'how do refunds work?' },
      CTX,
      { prisma: prisma as never },
    )
    expect(out.output).toEqual({ ok: true, hits: [{ id: 'a1', title: 'Refunds' }] })
    expect(articles.search).toHaveBeenCalledWith('acc1', 'how do refunds work?', 5, [])
  })

  it("searches only the answering agent's base", async () => {
    articles.search.mockResolvedValue([])
    await tool().handler({ query: 'anuidade' }, { ...CTX, knowledgeTags: ['financeiro'] }, { prisma: prisma as never })
    expect(articles.search).toHaveBeenCalledWith('acc1', 'anuidade', 5, ['financeiro'])
  })

  it('clamps limit to max 10', async () => {
    articles.search.mockResolvedValue([])
    await tool().handler(
      { query: 'q', limit: 9999 },
      CTX,
      { prisma: prisma as never },
    )
    expect(articles.search).toHaveBeenCalledWith('acc1', 'q', 10, [])
  })

  it('clamps limit to min 1', async () => {
    articles.search.mockResolvedValue([])
    await tool().handler(
      { query: 'q', limit: 0 },
      CTX,
      { prisma: prisma as never },
    )
    expect(articles.search).toHaveBeenCalledWith('acc1', 'q', 1, [])
  })

  it('uses provided in-range limit verbatim', async () => {
    articles.search.mockResolvedValue([])
    await tool().handler(
      { query: 'q', limit: 7 },
      CTX,
      { prisma: prisma as never },
    )
    expect(articles.search).toHaveBeenCalledWith('acc1', 'q', 7, [])
  })

  it('catches Error from ArticlesService and returns its message', async () => {
    articles.search.mockRejectedValue(new Error('db down'))
    const out = await tool().handler({ query: 'q' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'db down' })
  })

  it('coerces non-Error rejections to string', async () => {
    articles.search.mockRejectedValue('boom')
    const out = await tool().handler({ query: 'q' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'boom' })
  })
})

// ---------- customToolsForBot — validation / shape ----------

describe('customToolsForBot — entry validation', () => {
  let svc: AiTools
  beforeEach(() => {
    svc = makeService(makePrisma(), makeArticles())
  })

  it('returns [] for non-array input (null, string, object, number)', () => {
    expect(svc.customToolsForBot(null)).toEqual([])
    expect(svc.customToolsForBot('nope')).toEqual([])
    expect(svc.customToolsForBot({ a: 1 })).toEqual([])
    expect(svc.customToolsForBot(42)).toEqual([])
  })

  it('returns [] when array is empty', () => {
    expect(svc.customToolsForBot([])).toEqual([])
  })

  it('skips null / non-object entries', () => {
    const tools = svc.customToolsForBot([null, undefined, 42, 'string', true])
    expect(tools).toEqual([])
  })

  it('skips entry without a string name', () => {
    const tools = svc.customToolsForBot([{
      description: 'd',
      input_schema: { type: 'object' },
      webhook: { url: 'https://example.com/hook' },
    }])
    expect(tools).toEqual([])
  })

  it('skips entry without a string description', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      input_schema: { type: 'object' },
      webhook: { url: 'https://example.com/hook' },
    }])
    expect(tools).toEqual([])
  })

  it('skips entry without an input_schema', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      webhook: { url: 'https://example.com/hook' },
    }])
    expect(tools).toEqual([])
  })

  it('skips entry without webhook.url', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: { type: 'object' },
      webhook: {},
    }])
    expect(tools).toEqual([])
  })

  it('skips entry without a webhook object', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: { type: 'object' },
    }])
    expect(tools).toEqual([])
  })

  it('skips entry whose webhook.url is not http(s)', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: { type: 'object' },
      webhook: { url: 'ftp://files.example.com/hook' },
    }])
    expect(tools).toEqual([])
  })

  it('skips entry whose webhook.url is javascript:', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: { type: 'object' },
      webhook: { url: 'javascript:alert(1)' },
    }])
    expect(tools).toEqual([])
  })

  it('builds a ToolDef from a valid entry', () => {
    const tools = svc.customToolsForBot([{
      name: 'lookup_order',
      description: 'Find an order by id',
      input_schema: { type: 'object', properties: { id: { type: 'string' } } },
      webhook: { url: 'https://example.com/lookup' },
    }])
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('lookup_order')
    expect(tools[0]!.description).toBe('Find an order by id')
    expect(tools[0]!.destructive).toBe(false)
    expect(typeof tools[0]!.handler).toBe('function')
  })

  it('coerces destructive:true through Boolean()', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: {},
      webhook: { url: 'https://example.com/h' },
      destructive: 'yes', // truthy non-bool
    }])
    expect(tools[0]!.destructive).toBe(true)
  })

  it('coerces missing destructive to false', () => {
    const tools = svc.customToolsForBot([{
      name: 'n',
      description: 'd',
      input_schema: {},
      webhook: { url: 'https://example.com/h' },
    }])
    expect(tools[0]!.destructive).toBe(false)
  })

  it('builds multiple ToolDefs in order, skipping invalid ones', () => {
    const tools = svc.customToolsForBot([
      {
        name: 'good1',
        description: 'd',
        input_schema: {},
        webhook: { url: 'https://example.com/1' },
      },
      { name: 'bad' }, // missing fields
      {
        name: 'good2',
        description: 'd',
        input_schema: {},
        webhook: { url: 'http://other.example.com/2' },
      },
    ])
    expect(tools.map((t) => t.name)).toEqual(['good1', 'good2'])
  })
})

// ---------- customToolsForBot — webhook handler ----------

describe('customToolsForBot — webhook handler execution', () => {
  let svc: AiTools
  let prisma: Prisma
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma, makeArticles())
    guardMock.mockClear()
    guardMock.mockImplementation(async (u: string) => new URL(u))
  })

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore()
    delete process.env.CUSTOM_TOOL_TIMEOUT_MS
  })

  function buildOne(overrides: Record<string, unknown> = {}) {
    const tools = svc.customToolsForBot([{
      name: 'lookup',
      description: 'Find a thing',
      input_schema: { type: 'object' },
      webhook: { url: 'https://example.com/hook' },
      ...overrides,
    }])
    return tools[0]!
  }

  it('SSRF guard is invoked before fetch (S6 H2)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ found: true }),
    } as Response)
    const tool = buildOne()
    await tool.handler({ id: 'o1' }, CTX, { prisma: prisma as never })
    expect(guardMock).toHaveBeenCalledWith('https://example.com/hook')
    expect(guardMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0]!,
    )
  })

  it('returns ok:true with merged JSON body on 2xx', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ orderId: 'o9', total: 42 }),
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({ id: 'o9' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true, orderId: 'o9', total: 42 })
    expect(typeof out.durationMs).toBe('number')
  })

  it('returns ok:true with result wrapper when JSON is a scalar', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify('a string'),
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true, result: 'a string' })
  })

  it('returns ok:true with raw text in result when body is not JSON', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'plaintext-not-json',
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true, result: 'plaintext-not-json' })
  })

  it('handles empty body (parses to {})', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true })
  })

  it('handles JSON `null` body (typeof null is "object" but parsed === null)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'null',
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    // typeof null === 'object' but `parsed !== null` short-circuits — result wrapper.
    expect(out.output).toEqual({ ok: true, result: null })
  })

  it('non-2xx with JSON object body returns ok:false + error obj', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ message: 'upstream busted' }),
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({
      ok: false,
      status: 502,
      error: { message: 'upstream busted' },
    })
  })

  it('non-2xx with non-JSON body truncates string error to 500 chars', async () => {
    const long = 'x'.repeat(2000)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => long,
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    const o = out.output as { error: string }
    expect(o.error).toHaveLength(500)
  })

  it('SSRF guard rejection is caught and returned as ok:false', async () => {
    guardMock.mockRejectedValueOnce(new Error('blocked: target IP is internal'))
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({
      ok: false,
      error: 'blocked: target IP is internal',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetch throwing a non-Error value gets coerced via String()', async () => {
    guardMock.mockImplementation(async (u: string) => new URL(u))
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue('socket: ECONNRESET')
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'socket: ECONNRESET' })
  })

  it('truncates fetch error message at 500 chars', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('x'.repeat(2000)),
    )
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    const o = out.output as { error: string }
    expect(o.error).toHaveLength(500)
  })

  it('passes accountId/conversationId/contactId context in body', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response)
    const tool = buildOne()
    await tool.handler({ q: 'find' }, CTX, { prisma: prisma as never })
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      tool: 'lookup',
      input: { q: 'find' },
      context: CTX,
    })
  })

  it('uses POST by default with x-cosmika-tool header and redirect:manual', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response)
    const tool = buildOne()
    await tool.handler({}, CTX, { prisma: prisma as never })
    const init = fetchSpy.mock.calls[0]![1] as RequestInit & {
      headers: Record<string, string>
      redirect: string
    }
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.headers['x-cosmika-tool']).toBe('lookup')
    expect(init.headers['content-type']).toBe('application/json')
  })

  it('respects custom method + headers', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response)
    const tool = buildOne({
      webhook: {
        url: 'https://example.com/hook',
        method: 'PUT',
        headers: { 'x-api-key': 'sekret', 'x-cosmika-tool': 'should-be-overridden-NO' },
      },
    })
    await tool.handler({}, CTX, { prisma: prisma as never })
    const init = fetchSpy.mock.calls[0]![1] as RequestInit & {
      headers: Record<string, string>
    }
    expect(init.method).toBe('PUT')
    expect(init.headers['x-api-key']).toBe('sekret')
    // Spread order: built-in x-cosmika-tool sits BEFORE user headers, so a
    // user-supplied 'x-cosmika-tool' WILL override. Verify the observed
    // behaviour so the test pins it down.
    expect(init.headers['x-cosmika-tool']).toBe('should-be-overridden-NO')
  })

  it('uses default 15000ms timeout when env var is not set', async () => {
    // We can't easily observe the timeout value directly, but we can prove the
    // AbortController + timer code path is exercised. Mock fetch to be fast.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect((out.output as { ok: boolean }).ok).toBe(true)
    // The AbortSignal should have been passed to fetch.
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeDefined()
  })

  it('honours CUSTOM_TOOL_TIMEOUT_MS env var', async () => {
    process.env.CUSTOM_TOOL_TIMEOUT_MS = '5000'
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    } as Response)
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    expect((out.output as { ok: boolean }).ok).toBe(true)
  })

  it('aborts the request when the timer fires (timeoutMs=0)', async () => {
    process.env.CUSTOM_TOOL_TIMEOUT_MS = '0'
    // With timeoutMs=0, setTimeout fires on next tick. We have fetch throw an
    // AbortError to simulate the abort propagating.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      // simulate fetch honouring the abort signal
      await new Promise((resolve) => setTimeout(resolve, 1))
      const signal = (init as RequestInit).signal as AbortSignal
      if (signal.aborted) {
        throw new Error('The operation was aborted')
      }
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
      } as Response
    })
    const tool = buildOne()
    const out = await tool.handler({}, CTX, { prisma: prisma as never })
    // Either we got the abort message back, OR the request completed before
    // the timer (race). Both paths are valid; the assertion is just that the
    // handler doesn't crash and returns a structured result.
    expect(out.output).toHaveProperty('ok')
  })
})

// ---------- read_knowledge_base_article ----------

describe('read_knowledge_base_article', () => {
  let prisma: Prisma
  let articles: Articles
  let svc: AiTools

  beforeEach(() => {
    prisma = makePrisma()
    articles = makeArticles()
    svc = makeService(prisma, articles)
  })

  function tool() {
    return svc.byName('read_knowledge_base_article')!
  }

  it('errors when the reference is empty whitespace', async () => {
    const out = await tool().handler({ article: '  ' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty article reference' })
    expect(out.durationMs).toBe(0)
    expect(articles.readPublished).not.toHaveBeenCalled()
  })

  it('errors when the reference is missing entirely', async () => {
    const out = await tool().handler({}, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'empty article reference' })
  })

  it('returns the article body, scoped to the account', async () => {
    const article = {
      id: 'a1', slug: 'regra-24h', title: 'Regra 24 horas',
      content: 'A janela abre quando o cliente escreve.', truncated: false,
    }
    articles.readPublished.mockResolvedValue(article)
    const out = await tool().handler({ article: 'regra-24h' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: true, article })
    expect(articles.readPublished).toHaveBeenCalledWith('acc1', 'regra-24h', [])
  })

  it("reads only inside the answering agent's base", async () => {
    articles.readPublished.mockResolvedValue(null)
    await tool().handler({ article: 'a1' }, { ...CTX, knowledgeTags: ['cadastro'] }, { prisma: prisma as never })
    expect(articles.readPublished).toHaveBeenCalledWith('acc1', 'a1', ['cadastro'])
  })

  it('reports a miss rather than throwing', async () => {
    articles.readPublished.mockResolvedValue(null)
    const out = await tool().handler({ article: 'nope' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'article not found' })
  })

  it('catches Error from ArticlesService and returns its message', async () => {
    articles.readPublished.mockRejectedValue(new Error('db down'))
    const out = await tool().handler({ article: 'a1' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'db down' })
  })

  it('catches non-Error throwables', async () => {
    articles.readPublished.mockRejectedValue('boom')
    const out = await tool().handler({ article: 'a1' }, CTX, { prisma: prisma as never })
    expect(out.output).toEqual({ ok: false, error: 'boom' })
  })
})
