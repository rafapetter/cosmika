import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ForbiddenException, NotFoundException } from '@nestjs/common'

import { AdminAgentService, buildRequestHistory, repairTranscript } from './admin-agent.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    adminAgentSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    adminAgentToolCall: {
      create: vi.fn().mockResolvedValue({ id: 'call1' }),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  }
}
function makeAnthropic() {
  return { createMessage: vi.fn() }
}
function makeTools(overrides: Record<string, unknown> = {}) {
  const readTool = {
    name: 'account_overview', description: 'read', input_schema: {},
    critical: false, handler: vi.fn().mockResolvedValue({ output: { name: 'CosmoBots' } }),
  }
  const writeTool = {
    name: 'set_inbox_ai_mode', description: 'write', input_schema: {},
    critical: true, handler: vi.fn().mockResolvedValue({ output: { to: 'AUTO_SAFE' } }),
  }
  const all = [readTool, writeTool]
  return {
    readTool, writeTool,
    all: () => all,
    byName: (n: string) => all.find((t) => t.name === n) ?? null,
    ...overrides,
  }
}
const makeAudit = () => ({ record: vi.fn().mockResolvedValue(undefined) })
const makeAiUsage = () => ({ record: vi.fn().mockResolvedValue(0) })

function svc(
  p = makePrisma(),
  a = makeAnthropic(),
  t = makeTools(),
  au = makeAudit(),
  usage = makeAiUsage(),
) {
  return {
    s: new AdminAgentService(
      p as never,
      a as never,
      t as never,
      au as never,
      usage as never,
    ),
    p, a, t, au, usage,
  }
}

const ADMIN = { role: 'ADMINISTRATOR', isActive: true }
const text = (t: string) => ({
  content: [{ type: 'text', text: t }],
  stop_reason: 'end_turn' as const,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
})
const toolUse = (name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use', id: 'tu1', name, input }],
  stop_reason: 'tool_use' as const,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
})

describe('AdminAgentService.assertAdmin', () => {
  it('allows an active administrator', async () => {
    const { s, p } = svc()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    await expect(s.assertAdmin('u1', 'acc1')).resolves.toBeUndefined()
  })

  it('refuses supervisors, agents, non-members and deactivated admins', async () => {
    const { s, p } = svc()
    for (const m of [
      { role: 'SUPERVISOR', isActive: true },
      { role: 'AGENT', isActive: true },
      { role: 'ADMINISTRATOR', isActive: false },
      null,
    ]) {
      p.accountMember.findUnique.mockResolvedValue(m)
      await expect(s.assertAdmin('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    }
  })
})

describe('AdminAgentService.send — approval mode ON', () => {
  let ctx: ReturnType<typeof svc>
  beforeEach(() => {
    ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'CosmoBots', adminAgentRequiresApproval: true,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
  })

  it('queues a critical tool instead of running it', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('set_inbox_ai_mode', { inboxId: 'i1', mode: 'AUTO_SAFE' }))
    const out = await ctx.s.send('u1', 'acc1', { message: 'turn on auto-safe' })
    expect(ctx.t.writeTool.handler).not.toHaveBeenCalled()
    expect(out.pending).toEqual([
      { id: 'call1', toolName: 'set_inbox_ai_mode', input: { inboxId: 'i1', mode: 'AUTO_SAFE' } },
    ])
    expect(ctx.p.adminAgentToolCall.create.mock.calls[0][0].data).toMatchObject({
      status: 'PENDING', critical: true,
    })
  })

  it('stops the loop once something is queued, rather than pretending it ran', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('set_inbox_ai_mode', { inboxId: 'i1' }))
      .mockResolvedValueOnce(text('done!'))
    await ctx.s.send('u1', 'acc1', { message: 'go' })
    expect(ctx.a.createMessage).toHaveBeenCalledTimes(1)
  })

  it('still runs read tools without asking', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('account_overview', {}))
      .mockResolvedValueOnce(text('You have 3 inboxes.'))
    const out = await ctx.s.send('u1', 'acc1', { message: 'how is it set up?' })
    expect(ctx.t.readTool.handler).toHaveBeenCalled()
    expect(out.pending).toEqual([])
    expect(out.reply).toBe('You have 3 inboxes.')
  })
})

describe('AdminAgentService.send — approval mode OFF', () => {
  let ctx: ReturnType<typeof svc>
  beforeEach(() => {
    ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'CosmoBots', adminAgentRequiresApproval: false,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
  })

  it('applies a critical change directly', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('set_inbox_ai_mode', { inboxId: 'i1', mode: 'AUTO_SAFE' }))
      .mockResolvedValueOnce(text('Switched Suporte to AUTO_SAFE.'))
    const out = await ctx.s.send('u1', 'acc1', { message: 'switch it' })
    expect(ctx.t.writeTool.handler).toHaveBeenCalled()
    expect(out.pending).toEqual([])
    expect(out.executed).toMatchObject([{ toolName: 'set_inbox_ai_mode', critical: true }])
  })

  it('still queues a tool marked alwaysApprove: access and mass messaging', async () => {
    // The assistant reads text customers wrote. Inviting someone or sending a
    // broadcast must never happen on its word alone, whatever the setting.
    const invite = {
      name: 'invite_member', description: 'invite', input_schema: {},
      critical: true, alwaysApprove: true, handler: vi.fn(),
    }
    const t = makeTools()
    const all = [...t.all(), invite]
    ctx = svc(ctx.p, ctx.a, { ...t, all: () => all, byName: (n: string) => all.find((x) => x.name === n) ?? null } as never)
    ctx.p.adminAgentToolCall.create.mockResolvedValue({ id: 'call1' })
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('invite_member', { email: 'x@y.com', role: 'ADMINISTRATOR' }))
      .mockResolvedValueOnce(text('Queued.'))
    const out = await ctx.s.send('u1', 'acc1', { message: 'invite x@y.com as admin' })
    expect(invite.handler).not.toHaveBeenCalled()
    expect(out.pending).toMatchObject([{ toolName: 'invite_member' }])
  })

  it('audits the change against the invoking administrator, not the agent', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('set_inbox_ai_mode', { inboxId: 'i1' }))
      .mockResolvedValueOnce(text('done'))
    await ctx.s.send('u1', 'acc1', { message: 'go' })
    expect(ctx.au.record).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        actorId: 'u1',
        action: 'admin_agent.set_inbox_ai_mode',
        metadata: expect.objectContaining({ viaAdminAgent: true }),
      }),
    )
  })

  it('does not audit a read', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('account_overview', {}))
      .mockResolvedValueOnce(text('ok'))
    await ctx.s.send('u1', 'acc1', { message: 'read' })
    expect(ctx.au.record).not.toHaveBeenCalled()
  })

  it('keeps the prose written alongside a tool call', async () => {
    ctx.a.createMessage
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Switching Suporte now.' },
          { type: 'tool_use', id: 'tu1', name: 'set_inbox_ai_mode', input: {} },
        ],
        stop_reason: 'tool_use' as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      .mockResolvedValueOnce(text('Done.'))
    const out = await ctx.s.send('u1', 'acc1', { message: 'go' })
    expect(out.reply).toBe('Switching Suporte now.\n\nDone.')
  })
})

describe('AdminAgentService.send — guards', () => {
  it('refuses a non-administrator before touching anything', async () => {
    const { s, p, a } = svc()
    p.accountMember.findUnique.mockResolvedValue({ role: 'SUPERVISOR', isActive: true })
    await expect(s.send('u1', 'acc1', { message: 'hi' })).rejects.toThrow(ForbiddenException)
    expect(a.createMessage).not.toHaveBeenCalled()
  })

  it("refuses to resume another user's session", async () => {
    const { s, p } = svc()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.account.findUnique.mockResolvedValue({ name: 'X', adminAgentRequiresApproval: true })
    // The lookup is scoped by accountId AND userId, so someone else's id misses.
    p.adminAgentSession.findFirst.mockResolvedValue(null)
    await expect(
      s.send('u1', 'acc1', { sessionId: 'not-mine', message: 'hi' }),
    ).rejects.toThrow(NotFoundException)
    expect(p.adminAgentSession.findFirst.mock.calls[0][0].where).toEqual({
      id: 'not-mine', accountId: 'acc1', userId: 'u1',
    })
  })

  it('reports an unknown tool back to the model instead of throwing', async () => {
    const { s, p, a } = svc()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.account.findUnique.mockResolvedValue({ name: 'X', adminAgentRequiresApproval: false })
    p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    a.createMessage
      .mockResolvedValueOnce(toolUse('does_not_exist', {}))
      .mockResolvedValueOnce(text('sorry'))
    const out = await s.send('u1', 'acc1', { message: 'go' })
    expect(out.reply).toBe('sorry')
  })
})

describe('AdminAgentService.decide', () => {
  let ctx: ReturnType<typeof svc>
  beforeEach(() => {
    ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.adminAgentSession.findFirst.mockResolvedValue({ id: 'sess1' })
  })

  it('runs an approved call and records it CONFIRMED', async () => {
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue({
      id: 'call1', toolName: 'set_inbox_ai_mode', input: { inboxId: 'i1' }, status: 'PENDING',
    })
    const out = await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: true }])
    expect(ctx.t.writeTool.handler).toHaveBeenCalledWith({ inboxId: 'i1' }, {
      accountId: 'acc1', userId: 'u1',
    })
    expect(out[0]).toMatchObject({ status: 'CONFIRMED' })
  })

  it('rejects without running anything', async () => {
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue({
      id: 'call1', toolName: 'set_inbox_ai_mode', input: {}, status: 'PENDING',
    })
    const out = await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: false }])
    expect(ctx.t.writeTool.handler).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ status: 'REJECTED' })
    expect(ctx.p.adminAgentToolCall.update).toHaveBeenCalledWith({
      where: { id: 'call1' }, data: { status: 'REJECTED' },
    })
  })

  it('ignores a call that is not pending, so approval cannot be replayed', async () => {
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue(null)
    const out = await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'already', approve: true }])
    expect(out).toEqual([])
    expect(ctx.t.writeTool.handler).not.toHaveBeenCalled()
    expect(ctx.p.adminAgentToolCall.findFirst.mock.calls[0][0].where).toMatchObject({
      status: 'PENDING', sessionId: 'sess1',
    })
  })

  it('refuses a non-administrator', async () => {
    ctx.p.accountMember.findUnique.mockResolvedValue({ role: 'AGENT', isActive: true })
    await expect(
      ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: true }]),
    ).rejects.toThrow(ForbiddenException)
  })

  it('records ERROR when a tool throws, and does not audit it', async () => {
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue({
      id: 'call1', toolName: 'set_inbox_ai_mode', input: {}, status: 'PENDING',
    })
    ctx.t.writeTool.handler.mockRejectedValue(new Error('db down'))
    await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: true }])
    expect(ctx.p.adminAgentToolCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR' }) }),
    )
    expect(ctx.au.record).not.toHaveBeenCalled()
  })
})

describe('getSession transcript', () => {
  const load = async (state: unknown) => {
    const { s, p } = svc()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.adminAgentSession.findFirst.mockResolvedValue({
      id: 'sess1', title: 't', totalCostUsd: 0, state, toolCalls: [],
    })
    return (await s.getSession('u1', 'acc1', 'sess1')).transcript
  }

  it('keeps the prose from both sides in order', async () => {
    expect(
      await load({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'how many inboxes?' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Two.' }] },
        ],
      }),
    ).toEqual([
      { role: 'user', text: 'how many inboxes?' },
      { role: 'assistant', text: 'Two.' },
    ])
  })

  it('leaves out the tool plumbing between the turns', async () => {
    // tool_use / tool_result are machinery; they're shown as tool-call rows,
    // not pasted into the conversation as if someone had said them.
    expect(
      await load({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'tu1', name: 'list_inboxes', input: {} },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '{"inboxes":[]}' }],
          },
        ],
      }),
    ).toEqual([{ role: 'assistant', text: 'Checking.' }])
  })

  it('is empty for a session that has no history yet', async () => {
    expect(await load({ messages: [] })).toEqual([])
  })

  it('survives a state row that is not the shape we expect', async () => {
    expect(await load(null)).toEqual([])
    expect(await load({ messages: 'corrupt' })).toEqual([])
  })

  it('treats an unknown role as the assistant rather than dropping the text', async () => {
    expect(
      await load({ messages: [{ role: 'system', content: [{ type: 'text', text: 'hi' }] }] }),
    ).toEqual([{ role: 'assistant', text: 'hi' }])
  })

  it('tolerates a message whose content is not an array', async () => {
    expect(await load({ messages: [{ role: 'user', content: 'plain' }] })).toEqual([])
  })

  it('tolerates a text block with no text', async () => {
    expect(
      await load({ messages: [{ role: 'user', content: [{ type: 'text' }] }] }),
    ).toEqual([])
  })
})

describe('approval mode keeps the transcript well-formed', () => {
  // Regression: a queued critical call used to leave a `tool_use` block with
  // no `tool_result`, so the NEXT message in that session was rejected with
  // "tool_use ids were found without tool_result blocks". Approval mode broke
  // itself the first time it was used. Found on production, not in tests —
  // hence this asserts the stored shape, not just the visible behaviour.
  const setup = async () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'CosmoBots', adminAgentRequiresApproval: true,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.a.createMessage.mockResolvedValueOnce(
      toolUse('set_inbox_ai_mode', { inboxId: 'i1', mode: 'AUTO_FULL' }),
    )
    await ctx.s.send('u1', 'acc1', { message: 'switch it' })
    return ctx
  }

  const savedMessages = (ctx: Awaited<ReturnType<typeof setup>>) =>
    ctx.p.adminAgentSession.update.mock.calls[0][0].data.state.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>

  it('answers a queued tool_use with a tool_result', async () => {
    const ctx = await setup()
    const msgs = savedMessages(ctx)
    const uses = msgs.flatMap((m) => m.content.filter((b) => b.type === 'tool_use'))
    const results = msgs.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'))
    expect(uses).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(results[0].tool_use_id).toBe(uses[0].id)
  })

  it('every tool_use in the saved transcript is answered in the very next message', async () => {
    const ctx = await setup()
    const msgs = savedMessages(ctx)
    for (let i = 0; i < msgs.length; i += 1) {
      const ids = msgs[i].content.filter((b) => b.type === 'tool_use').map((b) => b.id)
      if (ids.length === 0) continue
      const next = msgs[i + 1]
      expect(next, 'a tool_use must be followed by a message').toBeDefined()
      const answered = next.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id)
      for (const id of ids) expect(answered).toContain(id)
    }
  })

  it('tells the model the change has NOT run', async () => {
    const ctx = await setup()
    const result = savedMessages(ctx)
      .flatMap((m) => m.content.filter((b) => b.type === 'tool_result'))[0]
    expect(String(result.content)).toContain('awaiting_approval')
    expect(String(result.content)).toMatch(/has NOT run/)
  })

  it('records an approval outcome back into the transcript', async () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.adminAgentSession.findFirst.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue({
      id: 'call1', toolName: 'set_inbox_ai_mode', input: { inboxId: 'i1' },
    })
    await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: true }])
    const saved = ctx.p.adminAgentSession.update.mock.calls[0][0].data.state.messages
    expect(JSON.stringify(saved)).toMatch(/approved set_inbox_ai_mode/)
  })

  it('records a rejection as "nothing was changed"', async () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.adminAgentSession.findFirst.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue({
      id: 'call1', toolName: 'set_inbox_ai_mode', input: {},
    })
    await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'call1', approve: false }])
    const saved = ctx.p.adminAgentSession.update.mock.calls[0][0].data.state.messages
    expect(JSON.stringify(saved)).toMatch(/rejected set_inbox_ai_mode/)
    expect(JSON.stringify(saved)).toMatch(/Nothing was changed/)
  })

  it('does not touch the transcript when no decision applied', async () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.adminAgentSession.findFirst.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.p.adminAgentToolCall.findFirst.mockResolvedValue(null)
    await ctx.s.decide('u1', 'acc1', 'sess1', [{ id: 'gone', approve: true }])
    expect(ctx.p.adminAgentSession.update).not.toHaveBeenCalled()
  })
})

describe('repairTranscript', () => {
  // Sessions poisoned before the approval fix are already on disk. Repairing
  // on read is what makes them usable again rather than stranding the admin
  // on a conversation that 400s on every message.
  const use = (id: string) => ({ type: 'tool_use', id, name: 't', input: {} })
  const res = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '{}' })

  it('drops a tool_use nothing ever answered', () => {
    const out = repairTranscript([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, use('a')] },
    ] as never)
    expect(JSON.stringify(out)).not.toContain('tool_use')
    // The prose the assistant wrote alongside it survives.
    expect(JSON.stringify(out)).toContain('ok')
  })

  it('keeps a tool_use that was answered', () => {
    const out = repairTranscript([
      { role: 'assistant', content: [use('a')] },
      { role: 'user', content: [res('a')] },
    ] as never)
    expect(out).toHaveLength(2)
  })

  it('removes a message left with no content at all', () => {
    const out = repairTranscript([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [use('orphan')] },
    ] as never)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })

  it('keeps the answered one and drops the orphan in the same message', () => {
    const out = repairTranscript([
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [res('a')] },
    ] as never)
    const ids = JSON.stringify(out)
    expect(ids).toContain('"a"')
    expect(ids).not.toContain('"b"')
  })

  it('leaves a clean transcript untouched', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]
    expect(repairTranscript(msgs as never)).toEqual(msgs)
  })

  it('tolerates content that is not an array', () => {
    const msgs = [{ role: 'user', content: 'plain' }]
    expect(repairTranscript(msgs as never)).toEqual(msgs)
  })

  it('lets a poisoned session send a message again', async () => {
    // End to end: the exact shape production had after the bug.
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'CosmoBots', adminAgentRequiresApproval: true,
    })
    ctx.p.adminAgentSession.findFirst.mockResolvedValue({
      id: 'sess1',
      state: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'disable the bot' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'I will.' }, use('orphan')] },
        ],
      },
    })
    ctx.a.createMessage.mockResolvedValue(text('7,538 contacts.'))
    const turn = await ctx.s.send('u1', 'acc1', { sessionId: 'sess1', message: 'how many contacts?' })
    expect(turn.reply).toBe('7,538 contacts.')
    const sent = ctx.a.createMessage.mock.calls[0][0].messages
    expect(JSON.stringify(sent)).not.toContain('orphan')
  })
})

describe('attachments', () => {
  const setup = () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'CosmoBots', adminAgentRequiresApproval: true,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.a.createMessage.mockResolvedValue(text('That is a screenshot of the inbox.'))
    return ctx
  }
  const png = { name: 'shot.png', mediaType: 'image/png', data: 'AAAA' }
  const sent = (ctx: ReturnType<typeof setup>) =>
    ctx.a.createMessage.mock.calls[0][0].messages.at(-1).content

  it('puts the file before the question, so the question has a referent', async () => {
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', { message: 'what is wrong here?', attachments: [png] })
    const c = sent(ctx)
    expect(c[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    })
    expect(c[1]).toMatchObject({ type: 'text', text: 'what is wrong here?' })
  })

  it('sends a PDF as a document, not an image', async () => {
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', {
      message: 'read this',
      attachments: [{ name: 'r.pdf', mediaType: 'application/pdf', data: 'JVBER' }],
    })
    expect(sent(ctx)[0]).toMatchObject({ type: 'document' })
  })

  it('supplies words when the admin attached a file and typed nothing', async () => {
    // An empty text block is rejected by the API, and a wordless turn is a
    // real thing an admin does — drag a screenshot in and hit send.
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', { message: '   ', attachments: [png] })
    const c = sent(ctx)
    expect(c[1].text).toBe('Look at the attached file.')
  })

  it('titles a wordless session something other than blank', async () => {
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', { message: '', attachments: [png] })
    expect(ctx.p.adminAgentSession.create.mock.calls[0][0].data.title).toBe('Attachment')
  })

  it('carries several attachments in order', async () => {
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', {
      message: 'compare',
      attachments: [png, { ...png, name: 'b.png', data: 'BBBB' }],
    })
    const c = sent(ctx)
    expect(c.map((b: { type: string }) => b.type)).toEqual(['image', 'image', 'text'])
    expect(c[1].source.data).toBe('BBBB')
  })

  it('sends a plain message with no attachment array at all', async () => {
    const ctx = setup()
    await ctx.s.send('u1', 'acc1', { message: 'hello' })
    expect(sent(ctx)).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('echoed tool output', () => {
  const run = async (toolOutput: Record<string, unknown>) => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      name: 'X', adminAgentRequiresApproval: true,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({ id: 'sess1', state: { messages: [] } })
    ctx.t.readTool.handler.mockResolvedValue({ output: toolOutput })
    ctx.a.createMessage
      .mockResolvedValueOnce(toolUse('account_overview', {}))
      .mockResolvedValueOnce(text('done'))
    return ctx.s.send('u1', 'acc1', { message: 'overview' })
  }

  it('returns a small result so the UI can chart it', async () => {
    const turn = await run({ counts: { contacts: 7538 } })
    expect(turn.executed[0]).toMatchObject({
      toolName: 'account_overview',
      output: { counts: { contacts: 7538 } },
    })
  })

  it('drops a result too large to be worth shipping', async () => {
    const turn = await run({ blob: 'x'.repeat(30_000) })
    expect(turn.executed[0].toolName).toBe('account_overview')
    expect(turn.executed[0].output).toBeUndefined()
  })

  it('drops a result that cannot be serialised rather than throwing', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const turn = await run(cyclic)
    expect(turn.executed[0].output).toBeUndefined()
  })
})


// ─── The window sent to the model ─────────────────────────────────────────

describe('buildRequestHistory', () => {
  type M = Parameters<typeof buildRequestHistory>[0][number]
  const said = (text: string): M => ({ role: 'user', content: [{ type: 'text', text }] })
  const reply = (text: string): M => ({ role: 'assistant', content: [{ type: 'text', text }] })
  const call = (id: string): M => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'get_flow', input: {} }],
  })
  const result = (id: string, content = 'ok'): M => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  })

  /** An admin turn that makes `n` tool calls before answering. */
  const turn = (tag: string, n: number, size = 10): M[] => {
    const out: M[] = [said(`q-${tag}`)]
    for (let i = 0; i < n; i += 1) {
      out.push(call(`${tag}-${i}`), result(`${tag}-${i}`, 'x'.repeat(size)))
    }
    out.push(reply(`a-${tag}`))
    return out
  }

  /** The Messages API contract the old slice broke. */
  function assertValid(h: M[]) {
    expect(h[0]!.role).toBe('user')
    expect(h[0]!.content.some((b) => b.type === 'tool_result')).toBe(false)
    h.forEach((m, i) => {
      const calls = m.content.filter((b) => b.type === 'tool_use') as Array<{ id: string }>
      if (!calls.length) return
      const answered = new Set(
        (h[i + 1]?.content ?? [])
          .filter((b) => b.type === 'tool_result')
          .map((b) => (b as { tool_use_id: string }).tool_use_id),
      )
      for (const c of calls) expect(answered.has(c.id)).toBe(true)
    })
  }

  it('sends a short history as it is', () => {
    const h = turn('a', 2)
    expect(buildRequestHistory(h)).toEqual(h)
  })

  it("never opens on an orphaned tool result (Gabriel's 154-message session)", () => {
    // Tool-heavy turns, like building a flow: far past the 40-message cap,
    // and shaped so a plain slice(-40) starts on a tool_result.
    const h = [...turn('a', 30), ...turn('b', 30), reply('mais algo?'), said('monte o esqueleto')]
    expect(h.slice(-40)[0]!.content[0]!.type).toBe('tool_result') // the old bug
    const out = buildRequestHistory(h)
    assertValid(out)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.at(-1)).toEqual(said('monte o esqueleto'))
  })

  it('keeps the window start still across tool rounds, so the cache can hit', () => {
    const base = [...turn('a', 25), said('q')]
    const first = buildRequestHistory(base)
    const later = buildRequestHistory([...base, call('r1'), result('r1'), call('r2'), result('r2')])
    expect(later[0]).toEqual(first[0])
  })

  it('summarizes big results from earlier turns and keeps the current turn whole', () => {
    const big = 'y'.repeat(5000)
    const h = [
      said('antes'),
      call('old'),
      result('old', big),
      reply('pronto'),
      said('agora'),
      call('now'),
      result('now', big),
    ]
    const out = buildRequestHistory(h)
    const old = out[2]!.content[0] as { content: string }
    expect(old.content.length).toBeLessThan(600)
    expect(old.content).toContain('4600 characters omitted')
    expect((out[6]!.content[0] as { content: string }).content).toBe(big)
  })

  it('leaves small results and block-shaped results untouched', () => {
    const blocks = [{ type: 'text' as const, text: 'z'.repeat(5000) }]
    const h: M[] = [
      said('antes'),
      call('s'),
      result('s', 'small'),
      call('b'),
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: blocks }] },
      reply('ok'),
      said('agora'),
    ]
    const out = buildRequestHistory(h)
    expect((out[2]!.content[0] as { content: string }).content).toBe('small')
    expect((out[4]!.content[0] as { content: unknown }).content).toEqual(blocks)
  })

  it('reads legacy rows stored with plain-string content', () => {
    const legacy = { role: 'user', content: 'olá' } as unknown as M
    expect(buildRequestHistory([legacy])).toEqual([said('olá')])
  })

  it('falls back to the last message when nothing after the cut is an admin turn', () => {
    const h = [said('q'), ...Array.from({ length: 30 }, (_, i) => [call(`c${i}`), result(`c${i}`)]).flat()]
    const out = buildRequestHistory(h, 10, 5)
    // No admin turn in reach: the window collapses to the tail, which
    // sanitizeHistory then makes valid (the orphan result is dropped).
    expect(out.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(false)
  })
})

describe('AdminAgentService — AI ledger', () => {
  it('records its spend, but never as a conversation the AI answered', async () => {
    const ctx = svc()
    ctx.p.accountMember.findUnique.mockResolvedValue(ADMIN)
    ctx.p.account.findUnique.mockResolvedValue({
      id: 'acc1',
      name: 'Acme',
      adminAgentRequiresApproval: false,
    })
    ctx.p.adminAgentSession.create.mockResolvedValue({
      id: 'sess1',
      state: { messages: [] },
    })
    ctx.a.createMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    await ctx.s.send('u1', 'acc1', { message: 'quantos agentes?' } as never)

    // The assistant talks to the account's own administrator. Its cost is
    // real and belongs in the ledger; charging the customer a conversation
    // from their AI allowance for asking their admin panel a question would
    // be indefensible, so `replied` is false and there is no conversation.
    expect(ctx.usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        source: 'ADMIN_AGENT',
        replied: false,
      }),
    )
    expect(ctx.usage.record.mock.calls[0]![0]).not.toHaveProperty('conversationId')
  })
})
