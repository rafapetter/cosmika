import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminAgentAccountTools } from './admin-agent-account-tools'

const CTX = { accountId: 'acc1', userId: 'admin1' }

function deps() {
  return {
    prisma: {
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'cv1' }) },
      whatsappTemplate: { findMany: vi.fn().mockResolvedValue([{ id: 't1', name: 'promo' }]) },
    },
    inboxes: {
      create: vi.fn().mockResolvedValue({ id: 'in1', name: 'Site', channelType: 'WEB_WIDGET' }),
      update: vi.fn().mockResolvedValue({ inbox: { id: 'in1', name: 'Site' }, whatsappCredentialsChanged: [] }),
      addMember: vi.fn().mockResolvedValue({}),
      removeMember: vi.fn().mockResolvedValue(undefined),
    },
    hours: {
      listForInbox: vi.fn().mockResolvedValue([{ dayOfWeek: 1 }]),
      listHolidays: vi.fn().mockResolvedValue([]),
      setForInbox: vi.fn().mockResolvedValue([{}, {}]),
      createHoliday: vi.fn().mockResolvedValue({ id: 'h1', name: 'Natal' }),
      deleteHoliday: vi.fn().mockResolvedValue(undefined),
    },
    teams: {
      create: vi.fn().mockResolvedValue({ id: 'tm1', name: 'Vendas' }),
      update: vi.fn().mockResolvedValue({ id: 'tm1', name: 'Vendas B2B' }),
      remove: vi.fn().mockResolvedValue(undefined),
      addMember: vi.fn().mockResolvedValue({}),
      removeMember: vi.fn().mockResolvedValue(undefined),
    },
    accounts: {
      inviteMember: vi.fn().mockResolvedValue({ role: 'AGENT', user: { email: 'n@x.com' } }),
      removeMember: vi.fn().mockResolvedValue(undefined),
    },
    automations: {
      list: vi.fn().mockResolvedValue([{ id: 'a1', name: 'VIP', isActive: true, triggerEvent: 'CONVERSATION_CREATED', conditions: [], actions: [], extra: 'x' }]),
      create: vi.fn().mockResolvedValue({ id: 'a1', name: 'VIP', isActive: true }),
      update: vi.fn().mockResolvedValue({ id: 'a1', name: 'VIP', isActive: false }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    articles: {
      get: vi.fn().mockResolvedValue({ id: 'ar1', title: 'T', slug: 't', status: 'DRAFT', tags: [], content: 'c' }),
      create: vi.fn().mockResolvedValue({ id: 'ar1', title: 'T', status: 'PUBLISHED' }),
      update: vi.fn().mockResolvedValue({ id: 'ar1', title: 'T2', status: 'PUBLISHED' }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    sla: {
      list: vi.fn().mockResolvedValue([{ id: 's1' }]),
      create: vi.fn().mockResolvedValue({ id: 's1', name: 'Padrão' }),
      update: vi.fn().mockResolvedValue({ id: 's1', name: 'Rápido' }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    conversations: {
      update: vi.fn().mockResolvedValue({ displayId: 8732, status: 'RESOLVED', priority: 'HIGH', assigneeId: null, teamId: null }),
    },
    tickets: { updateForAccount: vi.fn().mockResolvedValue({ number: 4, status: 'RESOLVED', priority: 'LOW' }) },
    labels: {
      update: vi.fn().mockResolvedValue({ id: 'l1', title: 'VIP' }),
      remove: vi.fn().mockResolvedValue(undefined),
      applyToConversation: vi.fn().mockResolvedValue({}),
      removeFromConversation: vi.fn().mockResolvedValue({}),
    },
    canned: {
      update: vi.fn().mockResolvedValue({ id: 'c1', shortcode: 'oi' }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    broadcasts: {
      create: vi.fn().mockResolvedValue({ id: 'b1', name: 'Promo' }),
      previewAudience: vi.fn().mockResolvedValue({ count: 120 }),
      send: vi.fn().mockResolvedValue({ id: 'b1', status: 'SENDING' }),
    },
    bots: { create: vi.fn().mockResolvedValue({ id: 'bot1', name: 'Vendas', model: 'claude-sonnet-5' }) },
  }
}
type Deps = ReturnType<typeof deps>

const make = (d: Deps) =>
  new AdminAgentAccountTools(
    d.prisma as never, d.inboxes as never, d.hours as never, d.teams as never, d.accounts as never,
    d.automations as never, d.articles as never, d.sla as never, d.conversations as never,
    d.tickets as never, d.labels as never, d.canned as never, d.broadcasts as never, d.bots as never,
  )

describe('AdminAgentAccountTools', () => {
  let d: Deps
  let run: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>
  beforeEach(() => {
    d = deps()
    const tools = make(d)
    run = async (name, input = {}) => (await tools.byName(name)!.handler(input, CTX)).output
  })

  it('never offers webhooks or API keys', () => {
    const names = make(d).all().map((t) => t.name)
    expect(names.some((n) => /webhook|api_key/.test(n))).toBe(false)
    for (const t of make(d).all()) {
      expect(t.description.length).toBeGreaterThan(15)
      expect(t.description).not.toContain('—')
    }
  })

  it('always asks before touching access or messaging customers in bulk', () => {
    const always = make(d).all().filter((t) => t.alwaysApprove).map((t) => t.name).sort()
    expect(always).toEqual(['deactivate_member', 'invite_member', 'send_broadcast'])
  })

  describe('inboxes and hours', () => {
    it('creates a widget inbox through the inboxes service, as the admin', async () => {
      const out = await run('create_inbox', { name: 'Site', channelType: 'WEB_WIDGET', greetingMessage: 'Oi!' })
      expect(out).toEqual({ created: 'in1', name: 'Site', channelType: 'WEB_WIDGET' })
      const [userId, accountId, input] = d.inboxes.create.mock.calls[0]!
      expect([userId, accountId]).toEqual(['admin1', 'acc1'])
      expect(input).toMatchObject({ channelConfig: { websiteName: 'Site' }, greetingEnabled: true, greetingMessage: 'Oi!' })
    })

    it('creates an API inbox without a webhook URL, whatever it is given', async () => {
      await run('create_inbox', { name: 'Integração', channelType: 'API', webhookUrl: 'https://evil.example/x' })
      expect(d.inboxes.create.mock.calls[0]![2].channelConfig).toEqual({})
    })

    it('refuses channels that need credentials', async () => {
      const out = await run('create_inbox', { name: 'Zap', channelType: 'WHATSAPP' })
      expect(out.error).toMatch(/settings screen/)
      expect(d.inboxes.create).not.toHaveBeenCalled()
    })

    it('updates an inbox but never passes channel config through', async () => {
      await run('update_inbox', { inboxId: 'in1', name: 'Site 2', channelConfig: { webhookUrl: 'https://evil.example' }, csatEnabled: true })
      const [, , inboxId, input] = d.inboxes.update.mock.calls[0]!
      expect(inboxId).toBe('in1')
      expect(input).toEqual({ name: 'Site 2', csatEnabled: true })
    })

    it('manages inbox members', async () => {
      await run('add_inbox_member', { inboxId: 'in1', userId: 'u2' })
      expect(d.inboxes.addMember).toHaveBeenCalledWith('admin1', 'acc1', 'in1', { userId: 'u2' })
      await run('remove_inbox_member', { inboxId: 'in1', userId: 'u2' })
      expect(d.inboxes.removeMember).toHaveBeenCalledWith('admin1', 'acc1', 'in1', 'u2')
    })

    it('reads and sets hours, and manages holidays', async () => {
      expect(await run('get_working_hours', { inboxId: 'in1' })).toMatchObject({ hours: [{ dayOfWeek: 1 }], holidays: [] })
      const set = await run('set_working_hours', { inboxId: 'in1', hours: [{ dayOfWeek: 1, openHour: 8, closeHour: 17 }, { dayOfWeek: 0, closedAllDay: true }] })
      expect(set).toEqual({ inbox: 'in1', days: 2 })
      expect(d.hours.setForInbox.mock.calls[0]![3].hours[0]).toMatchObject({ dayOfWeek: 1, openHour: 8, closeHour: 17 })
      expect(await run('add_holiday', { name: 'Natal', date: '2026-12-25' })).toEqual({ created: 'h1', name: 'Natal' })
      expect(await run('delete_holiday', { holidayId: 'h1' })).toEqual({ deleted: 'h1' })
    })

    it('turns an invalid input into an error the model can fix', async () => {
      await expect(run('add_holiday', { name: 'Natal', date: '25/12' })).rejects.toThrow(/invalid input: date: expected YYYY-MM-DD/)
      expect(d.hours.createHoliday).not.toHaveBeenCalled()
    })
  })

  describe('teams and members', () => {
    it('runs the team lifecycle through the teams service', async () => {
      expect(await run('create_team', { name: 'Vendas' })).toEqual({ created: 'tm1', name: 'Vendas' })
      expect(await run('update_team', { teamId: 'tm1', name: 'Vendas B2B' })).toEqual({ updated: 'tm1', name: 'Vendas B2B' })
      await run('add_team_member', { teamId: 'tm1', userId: 'u2' })
      expect(d.teams.addMember).toHaveBeenCalledWith('admin1', 'acc1', 'tm1', { userId: 'u2' })
      await run('remove_team_member', { teamId: 'tm1', userId: 'u2' })
      expect(d.teams.removeMember).toHaveBeenCalledWith('admin1', 'acc1', 'tm1', 'u2')
      expect(await run('delete_team', { teamId: 'tm1' })).toEqual({ deleted: 'tm1' })
    })

    it('invites through the account service, which also e-mails the invitee', async () => {
      expect(await run('invite_member', { email: 'n@x.com', role: 'AGENT' })).toEqual({ invited: 'n@x.com', role: 'AGENT' })
      expect(d.accounts.inviteMember).toHaveBeenCalledWith('acc1', { email: 'n@x.com', role: 'AGENT' })
      expect(await run('deactivate_member', { userId: 'u2' })).toEqual({ deactivated: 'u2' })
      expect(d.accounts.removeMember).toHaveBeenCalledWith('acc1', 'u2')
    })
  })

  describe('automations, knowledge base and SLA', () => {
    it('manages automation rules', async () => {
      const list = await run('list_automations')
      expect((list.automations as Array<Record<string, unknown>>)[0]).not.toHaveProperty('extra')
      const rule = { name: 'VIP', triggerEvent: 'CONVERSATION_CREATED', conditions: [{ field: 'CONTACT_EMAIL_DOMAIN', op: 'equals', value: 'vip.com' }], actions: [{ kind: 'SET_PRIORITY', value: 'HIGH' }] }
      expect(await run('create_automation', rule)).toEqual({ created: 'a1', name: 'VIP', isActive: true })
      expect(await run('update_automation', { automationId: 'a1', isActive: false })).toEqual({ updated: 'a1', name: 'VIP', isActive: false })
      expect(d.automations.update.mock.calls[0]![3]).toEqual({ isActive: false })
      expect(await run('delete_automation', { automationId: 'a1' })).toEqual({ deleted: 'a1' })
    })

    it('manages articles', async () => {
      expect(await run('get_article', { articleId: 'ar1' })).toMatchObject({ content: 'c' })
      expect(await run('create_article', { title: 'T', slug: 't', content: '# T', status: 'PUBLISHED' })).toMatchObject({ created: 'ar1' })
      expect(await run('update_article', { articleId: 'ar1', title: 'T2' })).toMatchObject({ updated: 'ar1' })
      expect(await run('delete_article', { articleId: 'ar1' })).toEqual({ deleted: 'ar1' })
    })

    it('manages SLA policies', async () => {
      expect(await run('list_sla_policies')).toEqual({ policies: [{ id: 's1' }] })
      expect(await run('create_sla_policy', { name: 'Padrão', firstResponseHighMinutes: 30 })).toEqual({ created: 's1', name: 'Padrão' })
      expect(await run('update_sla_policy', { slaPolicyId: 's1', name: 'Rápido' })).toEqual({ updated: 's1', name: 'Rápido' })
      expect(await run('delete_sla_policy', { slaPolicyId: 's1' })).toEqual({ deleted: 's1' })
    })
  })

  describe('conversations, tickets, labels and canned responses', () => {
    it('finds a conversation by the number people see', async () => {
      await run('update_conversation', { conversation: '#8732', status: 'RESOLVED', aiSummary: 'ignored' })
      expect(d.prisma.conversation.findFirst.mock.calls[0]![0].where).toEqual({ accountId: 'acc1', displayId: 8732 })
      expect(d.conversations.update.mock.calls[0]![3]).toEqual({ status: 'RESOLVED' })
    })

    it('finds a conversation by id, and reports one that is not there', async () => {
      await run('label_conversation', { conversation: 'cmx1', labelId: 'l1' })
      expect(d.prisma.conversation.findFirst.mock.calls[0]![0].where).toEqual({ accountId: 'acc1', id: 'cmx1' })
      expect(d.labels.applyToConversation).toHaveBeenCalledWith('admin1', 'acc1', 'cv1', 'l1')
      await run('label_conversation', { conversation: '8732', labelId: 'l1', remove: true })
      expect(d.labels.removeFromConversation).toHaveBeenCalledWith('admin1', 'acc1', 'cv1', 'l1')
      d.prisma.conversation.findFirst.mockResolvedValue(null)
      await expect(run('update_conversation', { conversation: '9999' })).rejects.toThrow(/no conversation "9999"/)
    })

    it('updates a ticket, and reports one from another account', async () => {
      expect(await run('update_ticket', { ticketId: 't1', status: 'RESOLVED' })).toEqual({ ticket: 4, status: 'RESOLVED', priority: 'LOW' })
      d.tickets.updateForAccount.mockResolvedValue(null)
      expect((await run('update_ticket', { ticketId: 'x' })).error).toMatch(/no ticket/)
    })

    it('edits and deletes labels and canned responses', async () => {
      expect(await run('update_label', { labelId: 'l1', title: 'VIP', color: '#ff0000' })).toEqual({ updated: 'l1', title: 'VIP' })
      expect(await run('delete_label', { labelId: 'l1' })).toEqual({ deleted: 'l1' })
      expect(await run('update_canned_response', { cannedResponseId: 'c1', content: 'Olá!' })).toEqual({ updated: 'c1', shortcode: 'oi' })
      expect(await run('delete_canned_response', { cannedResponseId: 'c1' })).toEqual({ deleted: 'c1' })
    })
  })

  describe('broadcasts and bots', () => {
    it('prepares a broadcast and reports its reach without sending', async () => {
      expect(await run('list_broadcast_templates', { inboxId: 'in1' })).toEqual({ templates: [{ id: 't1', name: 'promo' }] })
      const out = await run('create_broadcast', { name: 'Promo', inboxId: 'in1', templateId: 't1', country: 'BR' })
      expect(out).toEqual({ created: 'b1', name: 'Promo', wouldReach: 120, sent: false })
      expect(d.broadcasts.send).not.toHaveBeenCalled()
      expect(await run('send_broadcast', { broadcastId: 'b1' })).toEqual({ broadcast: 'b1', status: 'SENDING' })
    })

    it('creates a bot without custom HTTP tools, whatever it is given', async () => {
      await run('create_agent_bot', {
        name: 'Vendas', systemPrompt: 'Você vende.', customTools: [{ url: 'https://evil.example' }],
      })
      expect(d.bots.create.mock.calls[0]![2]).toEqual({ name: 'Vendas', systemPrompt: 'Você vende.' })
    })
  })
})
