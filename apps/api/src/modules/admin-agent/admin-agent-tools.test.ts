import { describe, expect, it, vi } from 'vitest'

import { AdminAgentTools, redactSecrets } from './admin-agent-tools'
import { validateDefinition } from './flow-edit'

function makePrisma() {
  const t = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _sum: { totalCostUsd: 0 } }),
  })
  return {
    account: t(), accountMember: t(), inbox: t(), contact: t(),
    conversation: t(), flow: t(), agentBot: t(), message: t(),
    aiAgentSession: t(), auditLog: t(),
    team: t(), label: t(), cannedResponse: t(), supportTicket: t(),
    csatSurvey: t(), article: t(),
  }
}
type Prisma = ReturnType<typeof makePrisma>
const tools = (p: Prisma) => new AdminAgentTools(p as never)
const CTX = { accountId: 'acc1', userId: 'u1' }

describe('redactSecrets', () => {
  it('hides secret values but keeps their presence visible', () => {
    // A transcript is quoted, logged and rendered — a token that reaches it
    // has leaked, and no approval click undoes that.
    expect(
      redactSecrets({ accessToken: 'EAAG123', appSecret: 'abc', name: 'Suporte' }),
    ).toEqual({ accessToken: '[set — hidden]', appSecret: '[set — hidden]', name: 'Suporte' })
  })

  it('reports an unset secret as null rather than pretending one exists', () => {
    expect(redactSecrets({ accessToken: null, appSecret: '' })).toEqual({
      accessToken: null,
      appSecret: null,
    })
  })

  it('reaches into nested objects and arrays', () => {
    expect(
      redactSecrets({ inboxes: [{ cfg: { accessToken: 'x', phoneNumberId: '55' } }] }),
    ).toEqual({ inboxes: [{ cfg: { accessToken: '[set — hidden]', phoneNumberId: '55' } }] })
  })

  it('leaves ordinary values alone', () => {
    expect(redactSecrets({ n: 1, b: true, s: 'hi', z: null })).toEqual({
      n: 1, b: true, s: 'hi', z: null,
    })
  })
})

describe('AdminAgentTools registry', () => {
  it('gates what can reach a customer or change the live account, not draft edits', () => {
    // Approval protects customers. A flow draft reaches none until
    // publish_flow, so gating each draft edit only made flows unbuildable
    // (every account has approval on and the loop stops at each queued call).
    const all = tools(makePrisma()).all()
    const critical = all.filter((t) => t.critical).map((t) => t.name).sort()
    expect(critical).toEqual([
      'create_canned_response',
      'create_label',
      'publish_flow',
      'revert_flow_draft',
      'set_account_settings',
      'set_agent_bot_config',
      'set_agent_bot_prompt',
      'set_csat_enabled',
      'set_inbox_ai_mode',
      'set_inbox_default_flow',
      'set_inbox_flow_mode',
      'set_member_role',
    ])
    const draftOnly = [
      'add_flow_block', 'add_flow_group', 'connect_flow_blocks', 'connect_flow_option',
      'create_flow', 'delete_flow_block', 'delete_flow_group', 'rename_flow_group',
      'set_flow_choice_options', 'set_flow_hours_condition', 'update_flow_block',
    ]
    for (const name of draftOnly) expect(all.find((t) => t.name === name)?.critical).toBe(false)
  })

  it('gives the assistant no way to switch off its own approval gate', () => {
    // If disarming the gate were itself a gated tool, one approval click
    // would skip every future one. The setting is human-only, by omission.
    const all = tools(makePrisma()).all()
    for (const t of all) {
      expect(JSON.stringify(t.input_schema)).not.toContain('adminAgentRequiresApproval')
    }
  })

  it('every tool has a description and a schema', () => {
    for (const t of tools(makePrisma()).all()) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.input_schema).toBeTypeOf('object')
    }
  })
})

describe('account scoping', () => {
  it('never exposes a credential value through list_inboxes', async () => {
    const p = makePrisma()
    p.inbox.findMany.mockResolvedValue([
      {
        id: 'i1', name: 'Suporte', channelType: 'WHATSAPP', aiAutoreplyMode: 'AUTO_SAFE',
        flowMode: 'GUIDED', defaultFlowId: 'f1', csatEnabled: false, agentBot: null,
        channelConfig: { accessToken: 'EAAsecret', appSecret: 'shh', phoneNumberId: '523' },
      },
    ])
    const out = await tools(p).byName('list_inboxes')!.handler({}, CTX)
    const inbox = (out.output.inboxes as Array<Record<string, unknown>>)[0]!
    expect(JSON.stringify(out.output)).not.toContain('EAAsecret')
    expect(JSON.stringify(out.output)).not.toContain('shh')
    // Presence is still reportable — the admin can ask "is it configured?".
    expect(inbox.credentialsConfigured).toBe(true)
    expect(inbox.inboundConfigured).toBe(true)
  })

  it('refuses to change an inbox belonging to another account', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('set_inbox_ai_mode')!.handler(
      { inboxId: 'inbox-from-elsewhere', mode: 'AUTO_FULL' },
      CTX,
    )
    expect(out.output.error).toMatch(/no such inbox/)
    expect(p.inbox.update).not.toHaveBeenCalled()
    // The account filter is applied in the query, not after the fact.
    expect(p.inbox.findFirst.mock.calls[0][0].where).toEqual({
      id: 'inbox-from-elsewhere',
      accountId: 'acc1',
    })
  })

  it('refuses to change a bot belonging to another account', async () => {
    const p = makePrisma()
    p.agentBot.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('set_agent_bot_config')!.handler(
      { botId: 'bot-elsewhere', isActive: false },
      CTX,
    )
    expect(out.output.error).toMatch(/no such agent bot/)
    expect(p.agentBot.update).not.toHaveBeenCalled()
  })
})

describe('set_inbox_ai_mode', () => {
  it('applies a valid mode and reports the transition', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', aiAutoreplyMode: 'DRAFT' })
    const out = await tools(p).byName('set_inbox_ai_mode')!.handler(
      { inboxId: 'i1', mode: 'AUTO_SAFE' },
      CTX,
    )
    expect(p.inbox.update).toHaveBeenCalledWith({
      where: { id: 'i1' }, data: { aiAutoreplyMode: 'AUTO_SAFE' },
    })
    expect(out.output).toMatchObject({ from: 'DRAFT', to: 'AUTO_SAFE' })
  })

  it('rejects a mode that is not one of the three', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_inbox_ai_mode')!.handler(
      { inboxId: 'i1', mode: 'YOLO' },
      CTX,
    )
    expect(out.output.error).toMatch(/unknown mode/)
    expect(p.inbox.findFirst).not.toHaveBeenCalled()
  })
})

describe('set_agent_bot_config', () => {
  it('applies only the fields supplied and clamps them', async () => {
    const p = makePrisma()
    p.agentBot.findFirst.mockResolvedValue({ id: 'b1', name: 'Suporte' })
    p.agentBot.update.mockResolvedValue({
      model: 'claude-sonnet-5', autoSafeConfidenceThreshold: 100,
      dailyBudgetUsd: 1000, isActive: true,
    })
    await tools(p).byName('set_agent_bot_config')!.handler(
      { botId: 'b1', autoSafeConfidenceThreshold: 5000, dailyBudgetUsd: 99999 },
      CTX,
    )
    expect(p.agentBot.update.mock.calls[0][0].data).toEqual({
      autoSafeConfidenceThreshold: 100,
      dailyBudgetUsd: 1000,
    })
  })

  it('says so when asked to change nothing', async () => {
    const p = makePrisma()
    p.agentBot.findFirst.mockResolvedValue({ id: 'b1', name: 'x' })
    const out = await tools(p).byName('set_agent_bot_config')!.handler({ botId: 'b1' }, CTX)
    expect(out.output.error).toMatch(/nothing to change/)
    expect(p.agentBot.update).not.toHaveBeenCalled()
  })
})

describe('set_member_role', () => {
  it('refuses to strip the last active administrator, in any mode', async () => {
    // Not an approval question: locking everyone out of their own workspace
    // can't be undone from inside the product.
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ role: 'ADMINISTRATOR', isActive: true })
    p.accountMember.count.mockResolvedValue(1)
    const out = await tools(p).byName('set_member_role')!.handler(
      { userId: 'u9', role: 'AGENT' },
      CTX,
    )
    expect(out.output.error).toMatch(/last active administrator/)
    expect(p.accountMember.update).not.toHaveBeenCalled()
  })

  it('refuses to deactivate the last active administrator', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ role: 'ADMINISTRATOR', isActive: true })
    p.accountMember.count.mockResolvedValue(1)
    const out = await tools(p).byName('set_member_role')!.handler(
      { userId: 'u9', isActive: false },
      CTX,
    )
    expect(out.output.error).toMatch(/last active administrator/)
  })

  it('allows demoting an admin when others remain', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ role: 'ADMINISTRATOR', isActive: true })
    p.accountMember.count.mockResolvedValue(3)
    p.accountMember.update.mockResolvedValue({ role: 'AGENT', isActive: true })
    const out = await tools(p).byName('set_member_role')!.handler(
      { userId: 'u9', role: 'AGENT' },
      CTX,
    )
    expect(out.output).toMatchObject({ role: 'AGENT' })
  })

  it('refuses a member who is not in this account', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    const out = await tools(p).byName('set_member_role')!.handler(
      { userId: 'stranger', role: 'AGENT' },
      CTX,
    )
    expect(out.output.error).toMatch(/no such member/)
    expect(p.accountMember.update).not.toHaveBeenCalled()
  })

  it('rejects an unknown role', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ role: 'AGENT', isActive: true })
    const out = await tools(p).byName('set_member_role')!.handler(
      { userId: 'u9', role: 'OWNER' },
      CTX,
    )
    expect(out.output.error).toMatch(/unknown role/)
  })
})

describe('read tools', () => {
  it('clamps the conversation_stats window to 90 days', async () => {
    const p = makePrisma()
    await tools(p).byName('conversation_stats')!.handler({ days: 9999 }, CTX)
    const since = p.message.count.mock.calls[0][0].where.createdAt.gte as Date
    const days = Math.round((Date.now() - since.getTime()) / 86_400_000)
    expect(days).toBe(90)
  })

  it('reports remaining budget as null when no cap is set', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({ monthlyAiBudgetUsd: 0 })
    const out = await tools(p).byName('ai_spend')!.handler({}, CTX)
    expect(out.output.remainingUsd).toBeNull()
  })

  it('scopes every read to the account', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({ id: 'acc1', name: 'X', slug: 's', plan: 'ROCKET', status: 'ACTIVE', defaultLocale: 'pt-BR', defaultTimezone: 'UTC', monthlyAiBudgetUsd: 15, adminAgentRequiresApproval: true })
    await tools(p).byName('account_overview')!.handler({}, CTX)
    expect(p.contact.count.mock.calls[0][0].where).toEqual({ accountId: 'acc1' })
    expect(p.conversation.count.mock.calls[0][0].where).toEqual({ accountId: 'acc1' })
  })
})

describe('set_account_settings', () => {
  it('ignores an attempt to relax its own approval requirement', async () => {
    const p = makePrisma()
    p.account.update.mockResolvedValue({
      name: 'Suporte', defaultLocale: 'pt-BR', defaultTimezone: 'UTC', monthlyAiBudgetUsd: 15,
    })
    await tools(p).byName('set_account_settings')!.handler(
      { name: 'Suporte', adminAgentRequiresApproval: false } as never,
      CTX,
    )
    expect(p.account.update.mock.calls[0][0].data).toEqual({ name: 'Suporte' })
  })

  it('rejects a timezone that would silently break scheduling', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_account_settings')!.handler(
      { defaultTimezone: 'Mars/Olympus' },
      CTX,
    )
    expect(out.output.error).toMatch(/not a valid IANA timezone/)
    expect(p.account.update).not.toHaveBeenCalled()
  })

  it('rejects an unsupported locale', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_account_settings')!.handler(
      { defaultLocale: 'fr-FR' },
      CTX,
    )
    expect(out.output.error).toMatch(/unknown locale/)
  })

  it('accepts a real timezone and clamps the budget', async () => {
    const p = makePrisma()
    p.account.update.mockResolvedValue({
      name: 'X', defaultLocale: 'en', defaultTimezone: 'America/Sao_Paulo', monthlyAiBudgetUsd: 10000,
    })
    const out = await tools(p).byName('set_account_settings')!.handler(
      { defaultTimezone: 'America/Sao_Paulo', defaultLocale: 'en', monthlyAiBudgetUsd: 999999 },
      CTX,
    )
    expect(p.account.update.mock.calls[0][0].data.monthlyAiBudgetUsd).toBe(10000)
    expect(out.output.changed).toEqual(['defaultLocale', 'defaultTimezone', 'monthlyAiBudgetUsd'])
  })

  it('rejects a negative budget', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_account_settings')!.handler(
      { monthlyAiBudgetUsd: -5 },
      CTX,
    )
    expect(out.output.error).toMatch(/must be >= 0/)
  })

  it('says so when asked to change nothing', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_account_settings')!.handler({}, CTX)
    expect(out.output.error).toMatch(/nothing to change/)
  })
})

describe('set_inbox_flow_mode', () => {
  it('applies a valid mode', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', flowMode: 'GUIDED' })
    const out = await tools(p).byName('set_inbox_flow_mode')!.handler(
      { inboxId: 'i1', mode: 'STRICT' },
      CTX,
    )
    expect(out.output).toMatchObject({ from: 'GUIDED', to: 'STRICT' })
  })

  it('rejects an unknown mode', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_inbox_flow_mode')!.handler(
      { inboxId: 'i1', mode: 'LOOSE' },
      CTX,
    )
    expect(out.output.error).toMatch(/unknown mode/)
    expect(p.inbox.findFirst).not.toHaveBeenCalled()
  })

  it('refuses an inbox from another account', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('set_inbox_flow_mode')!.handler(
      { inboxId: 'x', mode: 'STRICT' },
      CTX,
    )
    expect(out.output.error).toMatch(/no such inbox/)
  })
})

describe('set_csat_enabled', () => {
  it('warns that enabling starts messaging real customers', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', csatEnabled: false })
    const out = await tools(p).byName('set_csat_enabled')!.handler(
      { inboxId: 'i1', enabled: true },
      CTX,
    )
    expect(p.inbox.update).toHaveBeenCalledWith({
      where: { id: 'i1' }, data: { csatEnabled: true },
    })
    expect(out.output.note).toMatch(/survey link to the contact/)
  })

  it('reports turning it off without the warning', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'S', csatEnabled: true })
    const out = await tools(p).byName('set_csat_enabled')!.handler(
      { inboxId: 'i1', enabled: false },
      CTX,
    )
    expect(out.output.note).toMatch(/No further surveys/)
  })

  it('requires a boolean', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_csat_enabled')!.handler({ inboxId: 'i1' }, CTX)
    expect(out.output.error).toMatch(/true or false/)
  })

  it('refuses an inbox from another account', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('set_csat_enabled')!.handler(
      { inboxId: 'x', enabled: true },
      CTX,
    )
    expect(out.output.error).toMatch(/no such inbox/)
  })
})

describe('create_label', () => {
  it('creates one with a default colour', async () => {
    const p = makePrisma()
    p.label.findFirst.mockResolvedValue(null)
    p.label.create.mockResolvedValue({ id: 'l1', title: 'Urgente', color: '#6366F1' })
    const out = await tools(p).byName('create_label')!.handler({ title: 'Urgente' }, CTX)
    expect(p.label.create.mock.calls[0][0].data).toMatchObject({
      accountId: 'acc1', title: 'Urgente', color: '#6366F1',
    })
    expect(out.output.created).toMatchObject({ title: 'Urgente' })
  })

  it('rejects a malformed colour', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('create_label')!.handler(
      { title: 'X', color: 'red' },
      CTX,
    )
    expect(out.output.error).toMatch(/hex colour/)
    expect(p.label.create).not.toHaveBeenCalled()
  })

  it('refuses a duplicate title', async () => {
    const p = makePrisma()
    p.label.findFirst.mockResolvedValue({ id: 'l0' })
    const out = await tools(p).byName('create_label')!.handler({ title: 'Urgente' }, CTX)
    expect(out.output.error).toMatch(/already exists/)
    expect(p.label.create).not.toHaveBeenCalled()
  })

  it('requires a title', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('create_label')!.handler({ title: '  ' }, CTX)
    expect(out.output.error).toMatch(/title is required/)
  })
})

describe('create_canned_response', () => {
  it('strips a leading slash from the shortcode', async () => {
    const p = makePrisma()
    p.cannedResponse.findFirst.mockResolvedValue(null)
    p.cannedResponse.create.mockResolvedValue({ id: 'c1', shortcode: 'refund' })
    await tools(p).byName('create_canned_response')!.handler(
      { shortcode: '/refund', content: 'We will refund you.' },
      CTX,
    )
    expect(p.cannedResponse.create.mock.calls[0][0].data.shortcode).toBe('refund')
  })

  it('rejects a shortcode with spaces', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('create_canned_response')!.handler(
      { shortcode: 'two words', content: 'x' },
      CTX,
    )
    expect(out.output.error).toMatch(/letters, digits/)
  })

  it('refuses a duplicate shortcode', async () => {
    const p = makePrisma()
    p.cannedResponse.findFirst.mockResolvedValue({ id: 'c0' })
    const out = await tools(p).byName('create_canned_response')!.handler(
      { shortcode: 'refund', content: 'x' },
      CTX,
    )
    expect(out.output.error).toMatch(/already exists/)
  })

  it('requires both fields', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('create_canned_response')!.handler(
      { shortcode: 'refund' },
      CTX,
    )
    expect(out.output.error).toMatch(/both required/)
  })
})

describe('analytics reads', () => {
  it('summarises CSAT with an average and a spread', async () => {
    const p = makePrisma()
    p.csatSurvey.findMany.mockResolvedValue([
      { rating: 5, respondedAt: new Date() },
      { rating: 4, respondedAt: new Date() },
      { rating: null, respondedAt: null },
    ])
    const out = await tools(p).byName('csat_summary')!.handler({ days: 7 }, CTX)
    expect(out.output).toMatchObject({
      windowDays: 7, sent: 3, responded: 2, averageRating: 4.5,
      ratingSpread: { '4': 1, '5': 1 },
    })
  })

  it('reports no average when nobody responded', async () => {
    const p = makePrisma()
    p.csatSurvey.findMany.mockResolvedValue([{ rating: null, respondedAt: null }])
    const out = await tools(p).byName('csat_summary')!.handler({}, CTX)
    expect(out.output.averageRating).toBeNull()
  })

  it('clamps the csat window to a year', async () => {
    const p = makePrisma()
    await tools(p).byName('csat_summary')!.handler({ days: 99999 }, CTX)
    const since = p.csatSurvey.findMany.mock.calls[0][0].where.promptedAt.gte as Date
    expect(Math.round((Date.now() - since.getTime()) / 86_400_000)).toBe(365)
  })

  it('refuses a search query too short to be meaningful', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('search_conversations')!.handler({ query: 'a' }, CTX)
    expect(out.output.error).toMatch(/too short/)
    expect(p.message.findMany).not.toHaveBeenCalled()
  })

  it('searches only public messages in this account', async () => {
    const p = makePrisma()
    p.message.findMany.mockResolvedValue([
      {
        content: 'boleto vencido', senderType: 'CONTACT', createdAt: new Date(),
        conversation: { id: 'c1', displayId: 7, status: 'OPEN' },
      },
    ])
    const out = await tools(p).byName('search_conversations')!.handler({ query: 'boleto' }, CTX)
    expect(p.message.findMany.mock.calls[0][0].where).toMatchObject({
      accountId: 'acc1', isPrivate: false,
    })
    expect((out.output.hits as unknown[]).length).toBe(1)
  })

  it('counts label usage', async () => {
    const p = makePrisma()
    p.label.findMany.mockResolvedValue([
      { id: 'l1', title: 'Urgente', color: '#fff', conversationLabels: [{}, {}] },
    ])
    const out = await tools(p).byName('list_labels')!.handler({}, CTX)
    expect((out.output.labels as Array<Record<string, unknown>>)[0].usedBy).toBe(2)
  })

  it('counts team members', async () => {
    const p = makePrisma()
    p.team.findMany.mockResolvedValue([{ id: 't1', name: 'N1', members: [{ userId: 'u' }] }])
    const out = await tools(p).byName('list_teams')!.handler({}, CTX)
    expect((out.output.teams as Array<Record<string, unknown>>)[0].memberCount).toBe(1)
  })

  it('truncates canned response bodies', async () => {
    const p = makePrisma()
    p.cannedResponse.findMany.mockResolvedValue([
      { id: 'c1', shortcode: 'x', content: 'y'.repeat(1000) },
    ])
    const out = await tools(p).byName('list_canned_responses')!.handler({}, CTX)
    const body = (out.output.responses as Array<Record<string, string>>)[0].content
    expect(body.length).toBe(300)
  })

  it('filters tickets by status when asked', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([
      {
        number: 7, subject: 'S', status: 'OPEN', priority: 'NORMAL', category: null,
        createdAt: new Date(),
      },
    ])
    await tools(p).byName('list_tickets')!.handler({ status: 'OPEN', limit: 5 }, CTX)
    expect(p.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', status: 'OPEN',
    })
    expect(p.supportTicket.findMany.mock.calls[0][0].take).toBe(5)
  })

  it('lists tickets unfiltered by default', async () => {
    const p = makePrisma()
    await tools(p).byName('list_tickets')!.handler({}, CTX)
    expect(p.supportTicket.findMany.mock.calls[0][0].where).toEqual({ accountId: 'acc1' })
  })

  it('reports which articles are published', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([
      { id: 'a1', slug: 's', title: 'T', status: 'PUBLISHED', tags: ['x'], updatedAt: new Date() },
    ])
    const out = await tools(p).byName('list_articles')!.handler({}, CTX)
    expect(out.output.count).toBe(1)
    expect((out.output.articles as Array<Record<string, unknown>>)[0].status).toBe('PUBLISHED')
  })
})

describe('list_flows and archived flows', () => {
  it('hides archived flows by default, matching what the operator sees', async () => {
    // An imported account can have most of its flow list archived. An
    // assistant that counts them contradicts the screen the admin is on.
    const p = makePrisma()
    p.flow.findMany.mockResolvedValue([])
    p.flow.count.mockResolvedValue(62)
    const out = await tools(p).byName('list_flows')!.handler({}, CTX)
    expect(p.flow.findMany.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', status: { not: 'ARCHIVED' },
    })
    expect(out.output).toMatchObject({ archivedCount: 62, includingArchived: false })
  })

  it('includes them when explicitly asked', async () => {
    const p = makePrisma()
    p.flow.findMany.mockResolvedValue([])
    p.flow.count.mockResolvedValue(62)
    const out = await tools(p).byName('list_flows')!.handler({ includeArchived: true }, CTX)
    expect(p.flow.findMany.mock.calls[0][0].where).toEqual({ accountId: 'acc1' })
    expect(out.output.includingArchived).toBe(true)
  })

  it('reports each flow status and which inboxes use it', async () => {
    const p = makePrisma()
    p.flow.findMany.mockResolvedValue([
      { id: 'f1', name: 'Boas Vindas', externalId: '3351', published: {}, status: 'PUBLISHED' },
      { id: 'f2', name: 'Rascunho', externalId: '9', published: null, status: 'DRAFT' },
    ])
    p.flow.count.mockResolvedValue(0)
    p.inbox.findMany.mockResolvedValue([{ name: 'Suporte', defaultFlowId: 'f1' }])
    const out = await tools(p).byName('list_flows')!.handler({}, CTX)
    const flows = out.output.flows as Array<Record<string, unknown>>
    expect(flows[0]).toMatchObject({
      status: 'PUBLISHED', published: true, usedByInboxes: ['Suporte'],
    })
    expect(flows[1]).toMatchObject({ status: 'DRAFT', published: false, usedByInboxes: [] })
  })

  it('leaves archived flows out of the account overview count too', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue({
      name: 'X', slug: 's', plan: 'ROCKET', status: 'ACTIVE', defaultLocale: 'pt-BR',
      defaultTimezone: 'UTC', monthlyAiBudgetUsd: 15, adminAgentRequiresApproval: true,
    })
    await tools(p).byName('account_overview')!.handler({}, CTX)
    const flowCountCall = p.flow.count.mock.calls[0][0]
    expect(flowCountCall.where).toEqual({
      accountId: 'acc1', status: { not: 'ARCHIVED' },
    })
  })
})

// ── Flow editing ──────────────────────────────────────────────────────
// Editing a flow is the most dangerous thing the assistant does: a broken
// graph doesn't throw, it strands real customers mid-conversation on
// WhatsApp. So the theme here is that a bad edit must not be saved, and a
// draft edit must never reach a live customer on its own.

const DEF = () => ({
  groups: [
    { id: 'g1', blocks: [{ id: 'b1', type: 'text', content: 'Olá', outgoingEdgeId: 'e1' }] },
    { id: 'g2', blocks: [{ id: 'b2', type: 'text', content: 'Tchau' }] },
  ],
  edges: [{ id: 'e1', from: { blockId: 'b1' }, to: { groupId: 'g2' } }],
  variables: [],
  startGroupId: 'g1',
})

const flowRow = (over: Record<string, unknown> = {}) => ({
  id: 'f1', name: 'Boas Vindas', externalId: '3351', status: 'PUBLISHED',
  definition: DEF(), published: DEF(), accountId: 'acc1', ...over,
})

const savedDraft = (p: Prisma) =>
  p.flow.update.mock.calls[0][0].data.definition as ReturnType<typeof DEF>

describe('get_flow', () => {
  it('summarises the structure without dumping every option', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('get_flow')!.handler({ flowId: '3351' }, CTX)
    expect(out.output).toMatchObject({ flow: 'Boas Vindas', reading: 'draft' })
    const groups = out.output.groups as Array<Record<string, unknown>>
    expect(groups).toHaveLength(2)
    expect((groups[0].blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'b1', type: 'text', says: 'Olá',
    })
  })

  it('accepts an externalId as well as a cuid, since that is what admins see', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    await tools(p).byName('get_flow')!.handler({ flowId: '3351' }, CTX)
    expect(p.flow.findFirst.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', OR: [{ id: '3351' }, { externalId: '3351' }],
    })
  })

  it('says when the draft has diverged from what customers see', async () => {
    const p = makePrisma()
    const edited = DEF()
    edited.groups[0].blocks[0].content = 'Bom dia'
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: edited }))
    const out = await tools(p).byName('get_flow')!.handler({ flowId: 'f1' }, CTX)
    expect(out.output.draftDiffersFromPublished).toBe(true)
  })

  it('returns one block in full when asked', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('get_flow')!.handler(
      { flowId: 'f1', blockId: 'b1' }, CTX,
    )
    expect(out.output.block).toMatchObject({ id: 'b1', content: 'Olá' })
  })

  it('reports groups nothing can reach', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups.push({ id: 'orphan', blocks: [] })
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    const out = await tools(p).byName('get_flow')!.handler({ flowId: 'f1' }, CTX)
    expect(out.output.unreachableGroups).toEqual(['orphan'])
  })

  it('refuses a flow from another account', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('get_flow')!.handler({ flowId: 'x' }, CTX)
    expect(out.output.error).toMatch(/no such flow/)
  })
})

describe('update_flow_block', () => {
  it('changes the text and saves to the draft, not the live flow', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', content: 'Bom dia' }, CTX,
    )
    expect(savedDraft(p).groups[0].blocks[0].content).toBe('Bom dia')
    // The live column is untouched by an edit.
    expect(p.flow.update.mock.calls[0][0].data.published).toBeUndefined()
    expect(out.output).toMatchObject({ before: 'Olá', after: 'Bom dia', savedTo: 'draft' })
    expect(String(out.output.publishHint)).toMatch(/Not live yet/)
  })

  it('writes the text where the flow already keeps it', async () => {
    // Imported flows nest content under `options`; writing to the top level
    // would leave the engine reading the old value forever.
    const p = makePrisma()
    const d = DEF()
    d.groups[0].blocks[0] = { id: 'b1', type: 'text', options: { content: 'Antigo' } } as never
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', content: 'Novo' }, CTX,
    )
    const block = savedDraft(p).groups[0].blocks[0] as Record<string, never>
    expect((block.options as Record<string, unknown>).content).toBe('Novo')
    expect(block.content).toBeUndefined()
  })

  it('merges options rather than replacing them wholesale', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups[0].blocks[0] = { id: 'b1', type: 'x', options: { a: 1, b: 2 } } as never
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', options: { b: 99 } }, CTX,
    )
    const opts = (savedDraft(p).groups[0].blocks[0] as Record<string, never>)
      .options as Record<string, unknown>
    expect(opts).toEqual({ a: 1, b: 99 })
  })

  it('refuses an unknown block', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'nope', content: 'x' }, CTX,
    )
    expect(out.output.error).toMatch(/no block "nope"/)
    expect(p.flow.update).not.toHaveBeenCalled()
  })

  it('says so when asked to change nothing', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1' }, CTX,
    )
    expect(out.output.error).toMatch(/nothing to change/)
  })
})

describe('add_flow_block', () => {
  it('appends to a group and reports the new id', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('add_flow_block')!.handler(
      { flowId: 'f1', groupId: 'g2', type: 'text', content: 'Mais' }, CTX,
    )
    expect(savedDraft(p).groups[1].blocks).toHaveLength(2)
    expect(out.output).toMatchObject({ added: 'blk_1', group: 'g2' })
  })

  it('inserts after a named block', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups[1].blocks.push({ id: 'b3', type: 'text', content: 'Fim' } as never)
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    await tools(p).byName('add_flow_block')!.handler(
      { flowId: 'f1', groupId: 'g2', type: 'text', afterBlockId: 'b2' }, CTX,
    )
    expect(savedDraft(p).groups[1].blocks.map((b) => b.id)).toEqual(['b2', 'blk_1', 'b3'])
  })

  it('refuses an unknown group', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('add_flow_block')!.handler(
      { flowId: 'f1', groupId: 'ghost', type: 'text' }, CTX,
    )
    expect(out.output.error).toMatch(/no group "ghost"/)
  })
})

describe('delete_flow_block', () => {
  it('removes the block and the edges that started at it', async () => {
    // Leaving the edge behind would be the dangling reference that strands
    // customers, so it goes in the same operation.
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('delete_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1' }, CTX,
    )
    const saved = savedDraft(p)
    expect(saved.groups[0].blocks).toHaveLength(0)
    expect(saved.edges).toHaveLength(0)
    expect(out.output).toMatchObject({ deleted: 'b1', removedEdges: ['e1'] })
  })

  it('warns that what followed is now unreachable', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('delete_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1' }, CTX,
    )
    expect(out.output.unreachableGroups).toEqual(['g2'])
  })
})

describe('connect_flow_blocks', () => {
  it('creates the edge and points the block at it', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups[1].blocks.push({ id: 'b3', type: 'text' } as never)
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    await tools(p).byName('connect_flow_blocks')!.handler(
      { flowId: 'f1', fromBlockId: 'b3', toGroupId: 'g1' }, CTX,
    )
    const saved = savedDraft(p)
    const added = saved.edges.find((e) => e.from.blockId === 'b3')!
    expect(added.to.groupId).toBe('g1')
    expect(saved.groups[1].blocks[1].outgoingEdgeId).toBe(added.id)
  })

  it('replaces an existing outgoing edge rather than leaving two', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('connect_flow_blocks')!.handler(
      { flowId: 'f1', fromBlockId: 'b1', toGroupId: 'g1' }, CTX,
    )
    expect(savedDraft(p).edges.filter((e) => e.from.blockId === 'b1')).toHaveLength(1)
    expect(out.output.replaced).toEqual(['e1'])
  })

  it('refuses a target group that does not exist', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('connect_flow_blocks')!.handler(
      { flowId: 'f1', fromBlockId: 'b1', toGroupId: 'ghost' }, CTX,
    )
    expect(out.output.error).toMatch(/no group "ghost"/)
    expect(p.flow.update).not.toHaveBeenCalled()
  })
})

describe('publish_flow', () => {
  it('copies the draft to the live column and names the inboxes affected', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    p.inbox.findMany.mockResolvedValue([{ name: 'Suporte' }])
    const out = await tools(p).byName('publish_flow')!.handler({ flowId: 'f1' }, CTX)
    expect(p.flow.update.mock.calls[0][0].data).toMatchObject({ status: 'PUBLISHED' })
    expect(out.output.liveOnInboxes).toEqual(['Suporte'])
  })

  it('refuses to publish an invalid draft', async () => {
    // This is the last gate before real customers see it.
    const p = makePrisma()
    const broken = DEF()
    broken.edges[0].to.groupId = 'ghost'
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: broken }))
    const out = await tools(p).byName('publish_flow')!.handler({ flowId: 'f1' }, CTX)
    expect(out.output.error).toMatch(/not valid/)
    expect(p.flow.update).not.toHaveBeenCalled()
  })

  it('publishes but warns when part of the flow is unreachable', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups.push({ id: 'orphan', blocks: [] })
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    const out = await tools(p).byName('publish_flow')!.handler({ flowId: 'f1' }, CTX)
    expect(p.flow.update).toHaveBeenCalled()
    expect(out.output.unreachableGroups).toEqual(['orphan'])
  })
})

describe('revert_flow_draft', () => {
  it('restores the draft from the live version', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('revert_flow_draft')!.handler({ flowId: 'f1' }, CTX)
    expect(p.flow.update.mock.calls[0][0].data.definition).toEqual(DEF())
    expect(out.output.reverted).toBe('Boas Vindas')
  })

  it('says there is nothing to restore for a never-published flow', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow({ published: null }))
    const out = await tools(p).byName('revert_flow_draft')!.handler({ flowId: 'f1' }, CTX)
    expect(out.output.error).toMatch(/never been published/)
    expect(p.flow.update).not.toHaveBeenCalled()
  })
})

describe('set_inbox_default_flow', () => {
  it('refuses to point an inbox at a flow that was never published', async () => {
    // The runner requires `published`; attaching an unpublished flow would
    // silently make the inbox run nothing.
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', flowMode: 'GUIDED' })
    p.flow.findFirst.mockResolvedValue(flowRow({ published: null }))
    const out = await tools(p).byName('set_inbox_default_flow')!.handler(
      { inboxId: 'i1', flowId: 'f1' }, CTX,
    )
    expect(out.output.error).toMatch(/never been published/)
    expect(p.inbox.update).not.toHaveBeenCalled()
  })

  it('attaches a published flow', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', flowMode: 'GUIDED' })
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('set_inbox_default_flow')!.handler(
      { inboxId: 'i1', flowId: 'f1' }, CTX,
    )
    expect(p.inbox.update).toHaveBeenCalledWith({
      where: { id: 'i1' }, data: { defaultFlowId: 'f1' },
    })
    expect(out.output).toMatchObject({ inbox: 'Suporte', flow: 'Boas Vindas' })
  })

  it('points out when flowMode OFF means it still will not run', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Comercial', flowMode: 'OFF' })
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('set_inbox_default_flow')!.handler(
      { inboxId: 'i1', flowId: 'f1' }, CTX,
    )
    expect(String(out.output.note)).toMatch(/flowMode OFF/)
  })

  it('detaches when given null', async () => {
    const p = makePrisma()
    p.inbox.findFirst.mockResolvedValue({ id: 'i1', name: 'Suporte', flowMode: 'GUIDED' })
    const out = await tools(p).byName('set_inbox_default_flow')!.handler(
      { inboxId: 'i1', flowId: null }, CTX,
    )
    expect(p.inbox.update).toHaveBeenCalledWith({
      where: { id: 'i1' }, data: { defaultFlowId: null },
    })
    expect(out.output.detached).toBe(true)
  })
})

describe('set_agent_bot_prompt', () => {
  it('replaces the prompt and names the inboxes it affects', async () => {
    const p = makePrisma()
    p.agentBot.findFirst.mockResolvedValue({
      id: 'b1', name: 'Suporte CosmoBots', systemPrompt: 'x'.repeat(5379),
    })
    p.inbox.findMany.mockResolvedValue([{ name: 'Suporte' }, { name: 'Financeiro' }])
    const prompt = 'You are a helpful support agent for CosmoBots.'
    const out = await tools(p).byName('set_agent_bot_prompt')!.handler(
      { botId: 'b1', systemPrompt: prompt }, CTX,
    )
    expect(p.agentBot.update).toHaveBeenCalledWith({
      where: { id: 'b1' }, data: { systemPrompt: prompt },
    })
    expect(out.output).toMatchObject({
      previousLength: 5379, newLength: prompt.length,
      affectsInboxes: ['Suporte', 'Financeiro'],
    })
  })

  it('refuses a prompt too short to steer a bot', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('set_agent_bot_prompt')!.handler(
      { botId: 'b1', systemPrompt: 'be nice' }, CTX,
    )
    expect(out.output.error).toMatch(/unpredictably/)
    expect(p.agentBot.update).not.toHaveBeenCalled()
  })

  it('refuses a bot from another account', async () => {
    const p = makePrisma()
    p.agentBot.findFirst.mockResolvedValue(null)
    const out = await tools(p).byName('set_agent_bot_prompt')!.handler(
      { botId: 'elsewhere', systemPrompt: 'a'.repeat(50) }, CTX,
    )
    expect(out.output.error).toMatch(/no such agent bot/)
  })
})

describe('a bad edit is never saved', () => {
  it('rejects an edit that would break the graph', async () => {
    // Belt and braces: the mutators are careful, but the validator is the
    // thing standing between a model mistake and a broken live bot.
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', options: {} }, CTX,
    )
    // A no-op options merge is valid, so this one saves...
    expect(out.output.error).toBeUndefined()

    // ...whereas a definition that fails validation must not.
    const p2 = makePrisma()
    p2.flow.findFirst.mockResolvedValue(flowRow({ definition: { groups: [], edges: [] } }))
    const out2 = await tools(p2).byName('add_flow_block')!.handler(
      { flowId: 'f1', groupId: 'g1', type: 'text' }, CTX,
    )
    expect(out2.output.error).toMatch(/no group/)
    expect(p2.flow.update).not.toHaveBeenCalled()
  })
})

describe('create_flow', () => {
  it('creates a valid draft that reaches nobody yet', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(null)
    p.flow.create.mockResolvedValue({ id: 'new1', name: 'Triagem' })
    const out = await tools(p).byName('create_flow')!.handler(
      { name: 'Triagem', firstMessage: 'Olá! Como posso ajudar?' }, CTX,
    )
    const data = p.flow.create.mock.calls[0][0].data
    expect(data.status).toBe('DRAFT')
    expect(data.accountId).toBe('acc1')
    // Whatever we generate must itself pass the validator we gate edits on.
    expect(validateDefinition(data.definition)).toEqual([])
    expect(out.output).toMatchObject({ created: { name: 'Triagem' }, firstBlockId: 'blk_1' })
  })

  it('refuses a duplicate name, since this account already drowns in them', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue({ id: 'old' })
    const out = await tools(p).byName('create_flow')!.handler(
      { name: 'Boas Vindas', firstMessage: 'Oi' }, CTX,
    )
    expect(out.output.error).toMatch(/already exists/)
    expect(p.flow.create).not.toHaveBeenCalled()
  })

  it('requires both a name and an opening message', async () => {
    const p = makePrisma()
    const out = await tools(p).byName('create_flow')!.handler(
      { name: '  ', firstMessage: 'Oi' }, CTX,
    )
    expect(out.output.error).toMatch(/both required/)
  })
})

describe('list_inboxes surfaces automatic messaging', () => {
  // Flagged by the other Cosmika session: the inbox-level out-of-office fires
  // independently of a business-hours branch inside the flow, and neither
  // knows about the other — so a customer can be told "we're closed" twice.
  // The assistant cannot cause that (it has no working-hours tool), but it
  // was previously blind to it, which made the question undiagnosable.
  const inbox = (over: Record<string, unknown> = {}) => ({
    id: 'i1', name: 'Suporte', channelType: 'WHATSAPP', aiAutoreplyMode: 'AUTO_SAFE',
    flowMode: 'GUIDED', defaultFlowId: 'f1', csatEnabled: true, agentBot: null,
    channelConfig: {}, greetingEnabled: false, workingHoursEnabled: false,
    outOfOfficeMessage: null, ...over,
  })
  const read = async (over: Record<string, unknown> = {}) => {
    const p = makePrisma()
    p.inbox.findMany.mockResolvedValue([inbox(over)])
    const out = await tools(p).byName('list_inboxes')!.handler({}, CTX)
    return (out.output.inboxes as Array<Record<string, unknown>>)[0]
      .automaticMessages as Record<string, unknown>
  }

  it('reports every automatic sender in one place', async () => {
    expect(await read()).toEqual({
      greetingEnabled: false,
      workingHoursEnabled: false,
      outOfOfficeMessageSet: false,
      csatOnResolve: true,
    })
  })

  it('shows the combination that double-messages a customer', async () => {
    expect(
      await read({ workingHoursEnabled: true, outOfOfficeMessage: 'Estamos fechados' }),
    ).toMatchObject({ workingHoursEnabled: true, outOfOfficeMessageSet: true })
  })

  it('reports the out-of-office as set without quoting it back', async () => {
    const m = await read({ outOfOfficeMessage: 'Estamos fechados' })
    expect(m.outOfOfficeMessageSet).toBe(true)
    expect(JSON.stringify(m)).not.toContain('Estamos fechados')
  })
})

// ─── Building a menu end to end (Gabriel, 2026-09-10) ──────────────────────
//
// The request that could not be done: a welcome message and a menu with
// three options, each leading to its own step. Drive the tools in the order
// the assistant would, against a store that persists between calls, then run
// the saved draft through the real flow engine.

import { FlowEngine } from '../flows/flow-engine'

describe('building a menu flow through the tools', () => {
  function persistentFlow() {
    const p = makePrisma()
    const row = {
      id: 'f1', name: 'Teste_Flow_Gabriel', externalId: null, status: 'DRAFT',
      accountId: 'acc1', published: null,
      definition: {
        groups: [{ id: 'start', title: 'Start', blocks: [] }],
        edges: [],
        variables: [],
        startGroupId: 'start',
      } as Record<string, unknown>,
    }
    p.flow.findFirst.mockImplementation(async () => row)
    p.flow.update.mockImplementation(async ({ data }: { data: { definition: Record<string, unknown> } }) => {
      row.definition = data.definition
      return row
    })
    return { p, row }
  }
  const call = async (p: Prisma, name: string, input: Record<string, unknown>) => {
    const out = await tools(p).byName(name)!.handler(input, CTX)
    expect(out.output.error, `${name}: ${JSON.stringify(out.output)}`).toBeUndefined()
    return out.output as Record<string, unknown>
  }

  it('builds, validates and runs: each option reaches its own step', async () => {
    const { p, row } = persistentFlow()

    // Welcome text + the menu block in the start group.
    await call(p, 'add_flow_block', { flowId: 'f1', groupId: 'start', type: 'text', content: 'Olá! Bem-vindo ao teste.' })
    const menu = await call(p, 'add_flow_block', {
      flowId: 'f1', groupId: 'start', type: 'choice input', content: 'Como posso ajudar?',
    })
    // Three destination steps, each with its reply, one call each.
    const ia = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Como funciona a IA',
      blocks: [{ type: 'text', content: 'Nossa IA responde com base na sua base de conhecimento.' }],
    })
    const artigo = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Ver um artigo', blocks: [{ type: 'text', content: 'Aqui está um artigo de exemplo.' }],
    })
    const humano = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Falar com atendente', blocks: [{ type: 'text', content: 'Vou chamar um atendente.' }],
    })
    const set = await call(p, 'set_flow_choice_options', {
      flowId: 'f1',
      blockId: menu.added,
      options: [
        { label: 'Como funciona a IA', toGroupId: ia.added },
        { label: 'Ver um artigo', toGroupId: artigo.added },
        { label: 'Falar com atendente', toGroupId: humano.added },
      ],
    })
    expect(set.shownAs).toBe('buttons')

    // The saved draft is valid, nothing is unreachable, and it lays out
    // three new steps to the right of the start instead of on top of it.
    expect(validateDefinition(row.definition)).toEqual([])
    const def = row.definition as { groups: Array<{ id: string; graphCoordinates?: { x: number; y: number } }> }
    expect(new Set(def.groups.map((g) => JSON.stringify(g.graphCoordinates))).size).toBe(4)

    // get_flow shows the assistant every option and where it leads.
    const read = await call(p, 'get_flow', { flowId: 'f1' })
    const menuRead = (read.groups as Array<{ blocks: Array<{ id: string; options?: unknown }> }>)[0]!
      .blocks.find((b) => b.id === menu.added) as { options: Array<{ label: string; toGroupId: string }> }
    expect(menuRead.options.map((o) => o.toGroupId)).toEqual([ia.added, artigo.added, humano.added])
    expect(read.unreachableGroups).toEqual([])

    // The real engine: the menu goes out with its question, and the second
    // option lands on the article reply.
    const engine = new FlowEngine(row.definition as never, 'STRICT')
    const started = await engine.start()
    expect(started.emissions).toEqual([
      { kind: 'text', text: 'Olá! Bem-vindo ao teste.' },
      {
        kind: 'interactive',
        content: {
          kind: 'buttons',
          body: 'Como posso ajudar?',
          buttons: (set.options as Array<{ itemId: string; label: string }>).map((o) => ({
            id: o.itemId,
            label: o.label,
          })),
        },
      },
    ])
    const second = (set.options as Array<{ itemId: string }>)[1]!.itemId
    const tapped = await engine.resume(started.state, { text: '', interactiveReplyId: second })
    expect(tapped.emissions).toEqual([{ kind: 'text', text: 'Aqui está um artigo de exemplo.' }])

    // And re-routing a single option works on the same draft.
    await call(p, 'connect_flow_option', {
      flowId: 'f1', blockId: menu.added, optionId: second, toGroupId: humano.added,
    })
    const again = new FlowEngine(row.definition as never, 'STRICT')
    const s2 = await again.start()
    const r2 = await again.resume(s2.state, { text: '', interactiveReplyId: second })
    expect(r2.emissions).toEqual([{ kind: 'text', text: 'Vou chamar um atendente.' }])
  })

  it('a menu that drops the units that already closed, built the way a lab would ask', async () => {
    const { p, row } = persistentFlow()
    p.account.findUnique.mockResolvedValue({ defaultTimezone: 'America/Sao_Paulo' })

    const five = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Todas as unidades', blocks: [{ type: 'text', content: 'Matriz, Filial 1, 2, 3 ou 4?' }],
    })
    const two = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Só matriz e filial 1', blocks: [{ type: 'text', content: 'Matriz ou Filial 1?' }],
    })
    const closed = await call(p, 'add_flow_group', {
      flowId: 'f1', title: 'Fechado', blocks: [{ type: 'text', content: 'Estamos fechados.' }],
    })
    // A step that only holds the second check, reached when the first says no.
    const later = await call(p, 'add_flow_group', { flowId: 'f1', title: 'Depois da manhã' })

    const week = ['mon', 'tue', 'wed', 'thu', 'fri']
    // Branches 2, 3 and 4 only work mornings: while they are open, all five.
    const morning = await call(p, 'set_flow_hours_condition', {
      flowId: 'f1', groupId: 'start', openLabel: 'Filiais abertas',
      windows: [{ days: week, open: '07:00', close: '11:30' }],
      openGroupId: five.added, closedGroupId: later.added,
    })
    // No timezone given: the account's own is used, not UTC.
    expect(morning.timezone).toBe('America/Sao_Paulo')
    expect(morning.created).toBe(true)
    // Otherwise, head office hours (morning and afternoon) decide the rest.
    await call(p, 'set_flow_hours_condition', {
      flowId: 'f1', groupId: later.added, timezone: ' America/Sao_Paulo ',
      windows: [
        { days: week, open: '07:00', close: '12:00' },
        { days: week, open: '13:30', close: '18:00' },
      ],
      openGroupId: two.added, closedGroupId: closed.added,
    })

    expect(validateDefinition(row.definition)).toEqual([])
    const read = await call(p, 'get_flow', { flowId: 'f1' })
    expect(read.unreachableGroups).toEqual([])
    const startBlocks = (read.groups as Array<{ blocks: Array<{ id: string; says: string }> }>)[0]!.blocks
    expect(startBlocks.find((b) => b.id === morning.blockId)!.says).toMatch(/^opening hours \(America\/Sao_Paulo\): mon 07:00-11:30/)

    // The real engine, across one Tuesday in São Paulo (UTC-3).
    const at = async (utc: string) => {
      vi.setSystemTime(new Date(utc))
      const out = await new FlowEngine(row.definition as never, 'STRICT').start()
      return out.emissions.map((e) => (e as { text: string }).text)
    }
    vi.useFakeTimers()
    try {
      expect(await at('2026-08-04T13:00:00Z')).toEqual(['Matriz, Filial 1, 2, 3 ou 4?']) // 10:00
      expect(await at('2026-08-04T14:45:00Z')).toEqual(['Matriz ou Filial 1?']) // 11:45
      expect(await at('2026-08-04T15:30:00Z')).toEqual(['Estamos fechados.']) // 12:30, lunch
      expect(await at('2026-08-04T18:00:00Z')).toEqual(['Matriz ou Filial 1?']) // 15:00
      expect(await at('2026-08-04T22:00:00Z')).toEqual(['Estamos fechados.']) // 19:00
      expect(await at('2026-08-08T13:00:00Z')).toEqual(['Estamos fechados.']) // Saturday
    } finally {
      vi.useRealTimers()
    }

    // Changing the hours later edits the same check instead of adding one.
    const changed = await call(p, 'set_flow_hours_condition', {
      flowId: 'f1', blockId: morning.blockId,
      windows: [{ days: week, open: '07:00', close: '10:00' }],
      openGroupId: five.added, closedGroupId: later.added,
    })
    expect(changed).toMatchObject({ blockId: morning.blockId, created: false })
    expect(validateDefinition(row.definition)).toEqual([])
  })

  it('set_flow_hours_condition falls back to UTC when the account has no timezone', async () => {
    const { p } = persistentFlow()
    p.account.findUnique.mockResolvedValue(null)
    const g = await call(p, 'add_flow_group', { flowId: 'f1', title: 'A' })
    const out = await call(p, 'set_flow_hours_condition', {
      flowId: 'f1', groupId: 'start', windows: [{ days: ['mon'], open: '09:00', close: '18:00' }],
      openGroupId: g.added, closedGroupId: g.added,
    })
    expect(out.timezone).toBe('UTC')
  })

  it('set_flow_hours_condition saves nothing when the request cannot be honoured', async () => {
    const { p } = persistentFlow()
    const handler = tools(p).byName('set_flow_hours_condition')!.handler
    const base = { flowId: 'f1', windows: [{ days: ['mon'], open: '09:00', close: '18:00' }], openGroupId: 'start', closedGroupId: 'start', timezone: 'UTC' }
    // Neither a place to add it nor a check to change.
    expect((await handler(base, CTX)).output.error).toMatch(/give groupId .* or blockId/)
    expect((await handler({ ...base, groupId: '', blockId: '' }, CTX)).output.error).toMatch(/give groupId/)
    // Windows that are not a list, and missing destinations.
    expect((await handler({ ...base, groupId: 'start', windows: 'weekdays' }, CTX)).output.error).toMatch(/at least one opening window/)
    expect((await handler({ ...base, groupId: 'start', openGroupId: undefined }, CTX)).output.error).toMatch(/no group ""/)
    expect((await handler({ ...base, groupId: 'start', closedGroupId: undefined }, CTX)).output.error).toMatch(/no group ""/)
    expect((await handler({ ...base, groupId: 'start', flowId: undefined }, CTX)).output.error).toBeDefined()
    expect(p.flow.update).not.toHaveBeenCalled()
  })

  it('never saves an edit that would leave the draft broken', async () => {
    const { p } = persistentFlow()
    const bad = await tools(p).byName('set_flow_choice_options')!.handler(
      { flowId: 'f1', blockId: 'ghost', options: [{ label: 'x' }] }, CTX,
    )
    expect(bad.output.error).toMatch(/no block "ghost"/)
    expect(p.flow.update).not.toHaveBeenCalled()
  })
})

describe('group and menu tools: refusals', () => {
  const run = async (name: string, input: Record<string, unknown>) => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName(name)!.handler({ flowId: 'f1', ...input }, CTX)
    return { out: out.output as Record<string, unknown>, p }
  }

  it('add_flow_group needs a title and a type for every block', async () => {
    expect((await run('add_flow_group', { title: '  ' })).out.error).toMatch(/needs a title/)
    expect((await run('add_flow_group', { title: 'X', blocks: [{ content: 'no type' }] })).out.error).toMatch(/needs a type/)
  })

  it('add_flow_group with no blocks makes an empty step', async () => {
    const { out, p } = await run('add_flow_group', { title: 'Vazio' })
    expect(out.blocks).toEqual([])
    expect(savedDraft(p).groups.at(-1)).toMatchObject({ title: 'Vazio', blocks: [] })
  })

  it('rename_flow_group renames, and refuses an unknown group or empty title', async () => {
    const { out, p } = await run('rename_flow_group', { groupId: 'g2', title: 'Despedida' })
    expect(out).toMatchObject({ before: null, after: 'Despedida' })
    expect(savedDraft(p).groups[1]).toMatchObject({ title: 'Despedida' })
    expect((await run('rename_flow_group', { groupId: 'x', title: 'y' })).out.error).toMatch(/no group/)
    expect((await run('rename_flow_group', { groupId: 'g2', title: ' ' })).out.error).toMatch(/needs a title/)
  })

  it('delete_flow_group removes a step and refuses the start', async () => {
    const { out } = await run('delete_flow_group', { groupId: 'g2' })
    expect(out).toMatchObject({ deleted: 'g2', removedEdges: ['e1'] })
    expect((await run('delete_flow_group', { groupId: 'g1' })).out.error).toMatch(/start group/)
  })

  it('set_flow_choice_options wants a list', async () => {
    expect((await run('set_flow_choice_options', { blockId: 'b1', options: 'nope' })).out.error).toMatch(/must be a list/)
  })

  it('set_flow_choice_options ignores malformed option fields rather than trusting them', async () => {
    const p = makePrisma()
    const d = DEF()
    d.groups[0]!.blocks.push({ id: 'm', type: 'choice input' } as never)
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    const out = await tools(p).byName('set_flow_choice_options')!.handler(
      { flowId: 'f1', blockId: 'm', options: [{ label: 'Ok', value: 7, toGroupId: '' }, { label: 3 }] }, CTX,
    )
    // A non-string label is refused, not coerced into "3".
    expect(out.output.error).toMatch(/24 characters/)
  })

  it('connect_flow_option refuses an unknown option', async () => {
    expect((await run('connect_flow_option', { blockId: 'b1', optionId: 'x', toGroupId: 'g2' })).out.error).toMatch(/no option/)
  })

  it('add_flow_block stores options it is given', async () => {
    const { p } = await run('add_flow_block', { groupId: 'g2', type: 'text input', options: { variableId: 'v1' } })
    expect(savedDraft(p).groups[1]!.blocks.at(-1)).toMatchObject({ type: 'text input', options: { variableId: 'v1' } })
  })
})

describe('update_flow_block reports honestly', () => {
  // Found on production: an edit past the 160-char preview cutoff came back
  // as "before: X, after: X", which reads as "nothing happened" on a change
  // that did apply.
  it('says it changed even when the preview looks identical', async () => {
    const p = makePrisma()
    const long = 'x'.repeat(300)
    const d = DEF()
    d.groups[0].blocks[0].content = long
    p.flow.findFirst.mockResolvedValue(flowRow({ definition: d }))
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', content: long + ' extra' }, CTX,
    )
    expect(out.output.changed).toBe(true)
    expect(out.output.before).toEqual(out.output.after)
    expect(String(out.output.note)).toMatch(/past the preview cutoff/)
  })

  it('says plainly when the values were already what was asked for', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', content: 'Olá' }, CTX,
    )
    expect(out.output.changed).toBe(false)
    expect(String(out.output.note)).toMatch(/already had those values/)
  })

  it('reports a visible change without the caveat', async () => {
    const p = makePrisma()
    p.flow.findFirst.mockResolvedValue(flowRow())
    const out = await tools(p).byName('update_flow_block')!.handler(
      { flowId: 'f1', blockId: 'b1', content: 'Bom dia' }, CTX,
    )
    expect(out.output).toMatchObject({ changed: true, before: 'Olá', after: 'Bom dia' })
    expect(out.output.note).toBeUndefined()
  })
})
