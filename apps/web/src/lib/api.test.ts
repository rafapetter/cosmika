// Unit tests for the web app's API client. `request()` is the only shared
// code path; every `api.foo()` method is a 5-line fetch wrapper around it.
// We exhaustively cover request() (headers, body, error shaping, JSON-or-text
// payload, token handling) and then smoke-test the public api methods by
// shape: URL, method, body, query-string construction.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, API_BASE, ApiError } from './api'

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  ;(globalThis as { fetch?: unknown }).fetch = vi.fn()
})

afterEach(() => {
  ;(globalThis as { fetch?: unknown }).fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

function mockOK(payload: unknown, status = 200) {
  ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload),
  } as Response)
}

function mockErr(status: number, payload: unknown) {
  ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload),
  } as Response)
}

function lastFetchCall() {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
  const [url, init] = calls[calls.length - 1] as [
    string,
    RequestInit & { headers?: Record<string, string> },
  ]
  return { url, init }
}

// ─── API_BASE / ApiError ─────────────────────────────────────────

describe('API_BASE', () => {
  it('falls back to localhost when NEXT_PUBLIC_API_URL unset', () => {
    expect(API_BASE).toMatch(/localhost:3110$|cosmobots\.io$/)
  })
})

describe('ApiError', () => {
  it('carries status + payload + message', () => {
    const e = new ApiError(404, 'gone', { code: 'X' })
    expect(e.status).toBe(404)
    expect(e.message).toBe('gone')
    expect(e.payload).toEqual({ code: 'X' })
  })
})

// ─── request() via api.* ─────────────────────────────────────────

describe('request() core behavior', () => {
  it('sets Authorization but NO content-type for a bodyless request', async () => {
    mockOK({ ok: true })
    await api.me('tok123')
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/auth/me`)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok123' })
    // Fastify rejects an empty body carrying a JSON content-type, so bodyless
    // requests (GET, and POSTs like flow publish) must not declare one.
    expect(init.headers).not.toHaveProperty('content-type')
  })

  it('sets JSON content-type only when a body is sent', async () => {
    mockOK({})
    await api.signIn({ email: 'a@e.com', password: 'pw' })
    expect(lastFetchCall().init.headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('omits Authorization when no token is supplied', async () => {
    mockOK({ ok: true })
    await api.signIn({ email: 'a@e.com', password: 'pw' })
    const { init } = lastFetchCall()
    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('returns null payload when the response body is empty', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    } as Response)
    const result = await api.signOut('tok')
    expect(result).toBeNull()
  })

  it('returns plain text payload when body is non-JSON', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'plain text body',
    } as Response)
    const result = await api.me('tok')
    expect(result).toBe('plain text body')
  })

  it('throws ApiError with parsed message on JSON error response', async () => {
    mockErr(403, { message: 'forbidden' })
    await expect(api.me('tok')).rejects.toMatchObject({
      status: 403,
      message: 'forbidden',
      payload: { message: 'forbidden' },
    })
  })

  it('throws ApiError with default message when error payload has none', async () => {
    mockErr(500, { code: 'X' })
    await expect(api.me('tok')).rejects.toMatchObject({
      status: 500,
      message: 'Request failed (500)',
    })
  })

  it('throws ApiError with default message when error body is text', async () => {
    mockErr(502, 'gateway error')
    await expect(api.me('tok')).rejects.toMatchObject({
      status: 502,
      message: 'Request failed (502)',
    })
  })
})

// ─── auth methods ────────────────────────────────────────────────

describe('api.signUp / signIn / signOut / me / updateMe / changePassword', () => {
  it('signUp POSTs the body', async () => {
    mockOK({ token: 't' })
    await api.signUp({
      email: 'a@e.com',
      password: 'pw',
      fullName: 'A',
      accountName: 'Acme',
    })
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/auth/sign-up`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@e.com',
      password: 'pw',
      fullName: 'A',
      accountName: 'Acme',
    })
  })

  it('signIn POSTs the body', async () => {
    mockOK({ token: 't' })
    await api.signIn({ email: 'a@e.com', password: 'pw' })
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/auth/sign-in`)
    expect(init.method).toBe('POST')
  })

  it('signOut POSTs with token', async () => {
    mockOK(null)
    await api.signOut('tok')
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/auth/sign-out`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('updateMe PATCHes /auth/me', async () => {
    mockOK({})
    await api.updateMe('tok', { fullName: 'Bob' } as never)
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/auth/me`)
    expect(init.method).toBe('PATCH')
  })

  it('changePassword POSTs /auth/me/password', async () => {
    mockOK(null)
    await api.changePassword('tok', { oldPassword: 'a', newPassword: 'b' } as never)
    expect(lastFetchCall().url).toBe(`${API_BASE}/auth/me/password`)
  })
})

// ─── account / inboxes / contacts ────────────────────────────────

describe('account, inbox, and contact endpoints', () => {
  it('updateAccount PATCH', async () => {
    mockOK({})
    await api.updateAccount('tok', 'acc1', { name: 'X' } as never)
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1`)
  })

  it('getAccount GET', async () => {
    mockOK({})
    await api.getAccount('tok', 'acc1')
    expect(lastFetchCall().init.method).toBe('GET')
  })

  it('listInboxes GET', async () => {
    mockOK([])
    await api.listInboxes('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/inboxes`)
  })

  it('listFlows GET', async () => {
    mockOK([])
    await api.listFlows('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/flows`)
  })

  it('getFlow / createFlow / updateFlow / publishFlow / deleteFlow', async () => {
    mockOK({})
    await api.getFlow('tok', 'acc1', 'f1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/flows/f1`)

    mockOK({})
    await api.createFlow('tok', 'acc1', { name: 'Menu', definition: {} as never })
    let c = lastFetchCall()
    expect(c.url).toBe(`${API_BASE}/accounts/acc1/flows`)
    expect(c.init.method).toBe('POST')
    expect(JSON.parse(c.init.body as string)).toMatchObject({ name: 'Menu' })

    mockOK({})
    await api.updateFlow('tok', 'acc1', 'f1', { name: 'Menu 2' })
    c = lastFetchCall()
    expect(c.url).toBe(`${API_BASE}/accounts/acc1/flows/f1`)
    expect(c.init.method).toBe('PATCH')

    mockOK({})
    await api.publishFlow('tok', 'acc1', 'f1')
    c = lastFetchCall()
    expect(c.url).toBe(`${API_BASE}/accounts/acc1/flows/f1/publish`)
    expect(c.init.method).toBe('POST')

    mockOK({})
    await api.deleteFlow('tok', 'acc1', 'f1')
    c = lastFetchCall()
    expect(c.url).toBe(`${API_BASE}/accounts/acc1/flows/f1`)
    expect(c.init.method).toBe('DELETE')
  })

  it('createInbox POST + body', async () => {
    mockOK({})
    await api.createInbox('tok', 'acc1', { name: 'X', channelType: 'API' } as never)
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/accounts/acc1/inboxes`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'X' })
  })

  it('getInbox / updateInbox / deleteInbox / addInboxMember / removeInboxMember', async () => {
    mockOK({})
    await api.getInbox('tok', 'acc1', 'inb1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/inboxes/inb1`)
    mockOK({})
    await api.updateInbox('tok', 'acc1', 'inb1', {} as never)
    expect(lastFetchCall().init.method).toBe('PATCH')
    mockOK({})
    await api.updateWhatsappCredentials('tok', 'acc1', 'inb1', { appSecret: 'NEW-APP-SECRET-123' })
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/inboxes/inb1/whatsapp-credentials`,
    )
    expect(lastFetchCall().init.method).toBe('PATCH')
    expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({
      appSecret: 'NEW-APP-SECRET-123',
    })
    mockOK(null)
    await api.deleteInbox('tok', 'acc1', 'inb1')
    expect(lastFetchCall().init.method).toBe('DELETE')
    mockOK({})
    await api.addInboxMember('tok', 'acc1', 'inb1', { userId: 'u1' } as never)
    expect(lastFetchCall().url).toMatch(/\/inboxes\/inb1\/members$/)
    mockOK(null)
    await api.removeInboxMember('tok', 'acc1', 'inb1', 'u1')
    expect(lastFetchCall().url).toMatch(/\/inboxes\/inb1\/members\/u1$/)
  })

  it('listContacts builds query string from q + cursor + limit', async () => {
    mockOK({ items: [] })
    await api.listContacts('tok', 'acc1', { q: 'bob', cursor: 'c1', limit: 25 })
    const { url } = lastFetchCall()
    expect(url).toContain('q=bob')
    expect(url).toContain('cursor=c1')
    expect(url).toContain('limit=25')
  })

  it('listContacts omits query string when no params', async () => {
    mockOK({ items: [] })
    await api.listContacts('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/contacts`)
  })

  it('createContact / getContact / updateContact / deleteContact / mergeContacts', async () => {
    mockOK({})
    await api.createContact('tok', 'acc1', { name: 'X' } as never)
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK({})
    await api.getContact('tok', 'acc1', 'c1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/contacts/c1`)
    mockOK({})
    await api.updateContact('tok', 'acc1', 'c1', {} as never)
    expect(lastFetchCall().init.method).toBe('PATCH')
    mockOK(null)
    await api.deleteContact('tok', 'acc1', 'c1')
    expect(lastFetchCall().init.method).toBe('DELETE')
    mockOK({})
    await api.mergeContacts('tok', 'acc1', 'c1', { intoId: 'c2' } as never)
    expect(lastFetchCall().url).toMatch(/contacts\/c1\/merge$/)
  })

  it('bulkContactAction posts ids + action to /contacts/bulk', async () => {
    mockOK({ action: 'block', affected: 2 })
    await api.bulkContactAction('tok', 'acc1', ['c1', 'c2'], 'block')
    const call = lastFetchCall()
    expect(call.url).toBe(`${API_BASE}/accounts/acc1/contacts/bulk`)
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(call.init.body as string)).toEqual({
      contactIds: ['c1', 'c2'],
      action: 'block',
    })
  })
})

// ─── conversations / messages ────────────────────────────────────

describe('conversation + message endpoints', () => {
  it('listConversations builds full query string', async () => {
    mockOK({ items: [] })
    await api.listConversations('tok', 'acc1', {
      status: 'OPEN',
      controlMode: 'BOT',
      inboxId: 'inb1',
      assigneeId: 'u1',
      teamId: 't1',
      labelId: 'l1',
      contactId: 'c1',
      excludeId: 'x1',
      displayId: 42,
      country: 'BR',
      createdAfter: new Date('2026-01-01T00:00:00.000Z'),
      lastActivityBefore: new Date('2026-02-01T00:00:00.000Z'),
      sort: 'PRIORITY_DESC',
      q: 'help',
      cursor: 'cur',
      limit: 10,
    } as never)
    const { url } = lastFetchCall()
    for (const f of [
      'status=OPEN',
      'controlMode=BOT',
      'inboxId=inb1',
      'assigneeId=u1',
      'teamId=t1',
      'labelId=l1',
      'contactId=c1',
      'excludeId=x1',
      'displayId=42',
      'country=BR',
      'createdAfter=2026-01-01T00%3A00%3A00.000Z',
      'lastActivityBefore=2026-02-01T00%3A00%3A00.000Z',
      'sort=PRIORITY_DESC',
      'q=help',
      'cursor=cur',
      'limit=10',
    ]) {
      expect(url).toContain(f)
    }
  })

  it('listConversations omits suffix when query is empty', async () => {
    mockOK({ items: [] })
    await api.listConversations('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/conversations`)
  })

  it('createConversation / getConversation / updateConversation', async () => {
    mockOK({})
    await api.createConversation('tok', 'acc1', { contactId: 'c1' } as never)
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK({})
    await api.getConversation('tok', 'acc1', 'cv1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/conversations/cv1`)
    mockOK({})
    await api.updateConversation('tok', 'acc1', 'cv1', { status: 'RESOLVED' } as never)
    expect(lastFetchCall().init.method).toBe('PATCH')
  })

  it('listMessages with + without cursor/limit', async () => {
    mockOK({ items: [] })
    await api.listMessages('tok', 'acc1', 'cv1')
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/conversations/cv1/messages`,
    )
    mockOK({ items: [] })
    await api.listMessages('tok', 'acc1', 'cv1', 'cur1', 50)
    expect(lastFetchCall().url).toContain('cursor=cur1')
    expect(lastFetchCall().url).toContain('limit=50')
  })

  it('sendMessage / createInboundMessage', async () => {
    mockOK({})
    await api.sendMessage('tok', 'acc1', 'cv1', { content: 'hi' } as never)
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK({})
    await api.createInboundMessage('tok', 'acc1', 'cv1', { content: 'hi' } as never)
    expect(lastFetchCall().url).toMatch(/messages\/inbound$/)
  })

  it('add/removeConversationParticipant', async () => {
    mockOK({})
    await api.addConversationParticipant('tok', 'acc1', 'cv1', { userId: 'u1' } as never)
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK(null)
    await api.removeConversationParticipant('tok', 'acc1', 'cv1', 'u1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('bulkConversations POST', async () => {
    mockOK({})
    await api.bulkConversations('tok', 'acc1', { ids: ['cv1'], action: 'resolve' } as never)
    expect(lastFetchCall().url).toMatch(/conversations\/bulk$/)
  })

  it('forwardConversation POST', async () => {
    mockOK({})
    await api.forwardConversation('tok', 'acc1', 'cv1', { inboxId: 'inb2' } as never)
    expect(lastFetchCall().url).toMatch(/conversations\/cv1\/forward$/)
  })
})

// ─── reports ─────────────────────────────────────────────────────

describe('reports endpoints', () => {
  it('reportsOverview with full query', async () => {
    mockOK({})
    await api.reportsOverview('tok', 'acc1', {
      from: '2026-01-01',
      to: '2026-01-31',
      inboxId: 'inb1',
      teamId: 't1',
      assigneeId: 'u1',
    } as never)
    const { url } = lastFetchCall()
    for (const f of ['from=2026-01-01', 'to=2026-01-31', 'inboxId=inb1', 'teamId=t1', 'assigneeId=u1']) {
      expect(url).toContain(f)
    }
  })

  it('reportsOverview without params', async () => {
    mockOK({})
    await api.reportsOverview('tok', 'acc1')
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/reports/overview`,
    )
  })

  it('reportsTimeseries always sends metric + bucket', async () => {
    mockOK({})
    await api.reportsTimeseries('tok', 'acc1', {
      metric: 'conversations',
      bucket: 'day',
    } as never)
    const { url } = lastFetchCall()
    expect(url).toContain('metric=conversations')
    expect(url).toContain('bucket=day')
  })

  it('reportsTimeseries with optional filters', async () => {
    mockOK({})
    await api.reportsTimeseries('tok', 'acc1', {
      metric: 'messages',
      bucket: 'week',
      from: '2026-01-01',
      to: '2026-01-31',
      inboxId: 'i1',
      teamId: 't1',
      assigneeId: 'u1',
    } as never)
    const { url } = lastFetchCall()
    for (const f of ['from=2026-01-01', 'to=2026-01-31', 'inboxId=i1', 'teamId=t1', 'assigneeId=u1']) {
      expect(url).toContain(f)
    }
  })

  it('reportsLeaderboard with + without from/to', async () => {
    mockOK({})
    await api.reportsLeaderboard('tok', 'acc1')
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/reports/agent-leaderboard`,
    )
    mockOK({})
    await api.reportsLeaderboard('tok', 'acc1', { from: '2026-01-01', to: '2026-01-31' })
    expect(lastFetchCall().url).toContain('from=2026-01-01')
  })

  it('reportsBreakdown sends dimension + range', async () => {
    mockOK({})
    await api.reportsBreakdown('tok', 'acc1', {
      dimension: 'team',
      from: '2026-01-01',
      to: '2026-01-31',
    } as never)
    const { url } = lastFetchCall()
    expect(url).toContain('/reports/breakdown?')
    for (const f of ['dimension=team', 'from=2026-01-01', 'to=2026-01-31']) {
      expect(url).toContain(f)
    }
  })

  it('reportsBreakdownCsv hits the .csv route and returns raw text', async () => {
    // request() JSON.parse-fails on CSV and falls back to the raw string.
    mockOK('inbox,total\r\nSuporte,10')
    const csv = await api.reportsBreakdownCsv('tok', 'acc1', {
      dimension: 'inbox',
    } as never)
    expect(csv).toBe('inbox,total\r\nSuporte,10')
    expect(lastFetchCall().url).toContain(
      '/reports/breakdown.csv?dimension=inbox',
    )
  })
})

// ─── agent bots / AI / automation ─────────────────────────────

describe('agent-bot, AI session, automation endpoints', () => {
  it('listAgentBots / createAgentBot / getAgentBot / updateAgentBot / deleteAgentBot', async () => {
    mockOK([])
    await api.listAgentBots('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/agent-bots`)
    mockOK({})
    await api.createAgentBot('tok', 'acc1', { name: 'B' } as never)
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK({})
    await api.getAgentBot('tok', 'acc1', 'b1')
    expect(lastFetchCall().url).toMatch(/agent-bots\/b1$/)
    mockOK({})
    await api.updateAgentBot('tok', 'acc1', 'b1', {} as never)
    expect(lastFetchCall().init.method).toBe('PATCH')
    mockOK(null)
    await api.deleteAgentBot('tok', 'acc1', 'b1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('getAiSession / confirmToolCalls', async () => {
    mockOK({ session: null, recentToolCalls: [] })
    await api.getAiSession('tok', 'acc1', 'cv1')
    expect(lastFetchCall().url).toMatch(/conversations\/cv1\/ai$/)
    mockOK([])
    await api.confirmToolCalls('tok', 'acc1', 'cv1', { calls: [] } as never)
    expect(lastFetchCall().url).toMatch(/ai\/confirm-tool-calls$/)
  })

  it('automation CRUD + dry-run', async () => {
    mockOK([])
    await api.listAutomationRules('tok', 'acc1')
    mockOK({})
    await api.createAutomationRule('tok', 'acc1', {} as never)
    mockOK({})
    await api.getAutomationRule('tok', 'acc1', 'r1')
    mockOK({})
    await api.updateAutomationRule('tok', 'acc1', 'r1', {} as never)
    mockOK(null)
    await api.deleteAutomationRule('tok', 'acc1', 'r1')
    mockOK({})
    await api.dryRunAutomationRule('tok', 'acc1', 'r1', 'cv1')
    expect(lastFetchCall().url).toContain('run-dry?conversationId=cv1')
  })
})

// ─── teams / working hours / holidays ─────────────────────────

describe('team + working hours + holiday endpoints', () => {
  it('team CRUD + members', async () => {
    mockOK([])
    await api.listTeams('tok', 'acc1')
    mockOK({})
    await api.createTeam('tok', 'acc1', { name: 'T' } as never)
    mockOK({})
    await api.getTeam('tok', 'acc1', 't1')
    mockOK({})
    await api.updateTeam('tok', 'acc1', 't1', {} as never)
    mockOK(null)
    await api.deleteTeam('tok', 'acc1', 't1')
    mockOK({})
    await api.addTeamMember('tok', 'acc1', 't1', { userId: 'u1' } as never)
    mockOK(null)
    await api.removeTeamMember('tok', 'acc1', 't1', 'u1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('getWorkingHours / setWorkingHours', async () => {
    mockOK([])
    await api.getWorkingHours('tok', 'acc1', 'inb1')
    mockOK([])
    await api.setWorkingHours('tok', 'acc1', 'inb1', { hours: [] } as never)
    expect(lastFetchCall().init.method).toBe('PUT')
  })

  it('listHolidays / createHoliday / deleteHoliday', async () => {
    mockOK([])
    await api.listHolidays('tok', 'acc1')
    mockOK({})
    await api.createHoliday('tok', 'acc1', { date: '2026-12-25' } as never)
    mockOK(null)
    await api.deleteHoliday('tok', 'acc1', 'h1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })
})

// ─── canned + labels + notifications + saved-views ─────────────

describe('canned responses, labels, notifications, saved views', () => {
  it('canned responses CRUD', async () => {
    mockOK([])
    await api.listCannedResponses('tok', 'acc1')
    mockOK({})
    await api.createCannedResponse('tok', 'acc1', { name: 'X', content: 'y' } as never)
    mockOK({})
    await api.updateCannedResponse('tok', 'acc1', 'c1', {} as never)
    mockOK(null)
    await api.deleteCannedResponse('tok', 'acc1', 'c1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('labels CRUD + apply/remove', async () => {
    mockOK([])
    await api.listLabels('tok', 'acc1')
    mockOK({})
    await api.createLabel('tok', 'acc1', { title: 'l' } as never)
    mockOK({})
    await api.updateLabel('tok', 'acc1', 'l1', {} as never)
    mockOK(null)
    await api.deleteLabel('tok', 'acc1', 'l1')
    mockOK(null)
    await api.applyLabel('tok', 'acc1', 'cv1', 'l1')
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK(null)
    await api.removeLabel('tok', 'acc1', 'cv1', 'l1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('notifications endpoints', async () => {
    mockOK([])
    await api.listNotifications('tok', 'acc1', { onlyUnread: true, limit: 10 } as never)
    expect(lastFetchCall().url).toContain('onlyUnread=1')
    expect(lastFetchCall().url).toContain('limit=10')
    mockOK([])
    await api.listNotifications('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/notifications`)
    mockOK({})
    await api.notificationCounts('tok', 'acc1')
    expect(lastFetchCall().url).toMatch(/notifications\/count$/)
    mockOK(null)
    await api.markNotificationRead('tok', 'acc1', 'n1')
    expect(lastFetchCall().init.method).toBe('PATCH')
    mockOK({ updated: 5 })
    await api.markAllNotificationsRead('tok', 'acc1')
    expect(lastFetchCall().url).toMatch(/notifications\/read-all$/)
  })

  it('saved-views CRUD', async () => {
    mockOK([])
    await api.listSavedViews('tok', 'acc1')
    mockOK({})
    await api.createSavedView('tok', 'acc1', { name: 'v' } as never)
    mockOK({})
    await api.updateSavedView('tok', 'acc1', 'sv1', {} as never)
    mockOK(null)
    await api.deleteSavedView('tok', 'acc1', 'sv1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })
})

// ─── custom attrs, audit log, webhooks ─────────────────────────

describe('custom attributes, audit log, webhooks', () => {
  it('listCustomAttributes with + without target filter', async () => {
    mockOK([])
    await api.listCustomAttributes('tok', 'acc1', 'CONTACT')
    expect(lastFetchCall().url).toContain('?target=CONTACT')
    mockOK([])
    await api.listCustomAttributes('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/custom-attributes`)
  })

  it('custom attribute CRUD', async () => {
    mockOK({})
    await api.createCustomAttribute('tok', 'acc1', {} as never)
    mockOK({})
    await api.updateCustomAttribute('tok', 'acc1', 'a1', {} as never)
    mockOK(null)
    await api.deleteCustomAttribute('tok', 'acc1', 'a1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('agent availability list + replace', async () => {
    mockOK([])
    await api.listAgentAvailability('tok', 'acc1', 'm1')
    mockOK([])
    await api.replaceAgentAvailability('tok', 'acc1', 'm1', { slots: [] } as never)
    expect(lastFetchCall().init.method).toBe('PUT')
  })

  it('audit log with + without query', async () => {
    mockOK({ items: [], nextCursor: null })
    await api.listAuditLogs('tok', 'acc1', { cursor: 'c', limit: 50, action: 'X' } as never)
    expect(lastFetchCall().url).toContain('cursor=c')
    expect(lastFetchCall().url).toContain('limit=50')
    expect(lastFetchCall().url).toContain('action=X')
    mockOK({ items: [], nextCursor: null })
    await api.listAuditLogs('tok', 'acc1', {
      actorId: 'u1',
      from: '2026-10-01T03:00:00.000Z',
      to: '2026-10-02T03:00:00.000Z',
    })
    expect(lastFetchCall().url).toContain('actorId=u1')
    expect(lastFetchCall().url).toContain('from=2026-10-01T03%3A00%3A00.000Z')
    expect(lastFetchCall().url).toContain('to=2026-10-02T03%3A00%3A00.000Z')
    mockOK({ items: [] })
    await api.listAuditLogs('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/audit-logs`)
  })

  it('webhooks CRUD + deliveries + retry', async () => {
    mockOK([])
    await api.listWebhooks('tok', 'acc1')
    mockOK({})
    await api.createWebhook('tok', 'acc1', { url: 'u' } as never)
    mockOK({})
    await api.updateWebhook('tok', 'acc1', 'w1', {} as never)
    mockOK(null)
    await api.deleteWebhook('tok', 'acc1', 'w1')
    mockOK([])
    await api.listWebhookDeliveries('tok', 'acc1', 'w1')
    expect(lastFetchCall().url).toMatch(/webhooks\/w1\/deliveries$/)
    mockOK(null)
    await api.retryWebhookDelivery('tok', 'acc1', 'w1', 'd1')
    expect(lastFetchCall().url).toMatch(/deliveries\/d1\/retry$/)
  })
})

// ─── GDPR / import / csat / KB / sla ──────────────────────────

describe('GDPR + import + csat + knowledge-base + sla endpoints', () => {
  it('exportContact / anonymizeContact', async () => {
    mockOK({})
    await api.exportContact('tok', 'acc1', 'c1')
    expect(lastFetchCall().url).toMatch(/contacts\/c1\/export$/)
    mockOK({})
    await api.anonymizeContact('tok', 'acc1', 'c1')
    expect(lastFetchCall().init.method).toBe('POST')
  })

  it('importContacts', async () => {
    mockOK({ created: 0 })
    await api.importContacts('tok', 'acc1', { rows: [] } as never)
    expect(lastFetchCall().url).toMatch(/contacts\/import$/)
  })

  it('getCsatStats with + without filters', async () => {
    mockOK({})
    await api.getCsatStats('tok', 'acc1', {
      inboxId: 'i', agentId: 'u', from: '2026-01-01', to: '2026-01-31',
    } as never)
    const { url } = lastFetchCall()
    for (const f of ['inboxId=i', 'agentId=u', 'from=2026-01-01', 'to=2026-01-31']) {
      expect(url).toContain(f)
    }
    mockOK({})
    await api.getCsatStats('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/csat/stats`)
  })

  it('articles CRUD + search', async () => {
    mockOK([])
    await api.listArticles('tok', 'acc1', { status: 'PUBLISHED', q: 'pricing', limit: 5 } as never)
    const { url } = lastFetchCall()
    for (const f of ['status=PUBLISHED', 'q=pricing', 'limit=5']) {
      expect(url).toContain(f)
    }
    mockOK([])
    await api.listArticles('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/articles`)
    mockOK({})
    await api.getArticle('tok', 'acc1', 'a1')
    mockOK({})
    await api.createArticle('tok', 'acc1', { slug: 's', title: 't', content: 'c' } as never)
    mockOK({})
    await api.updateArticle('tok', 'acc1', 'a1', {} as never)
    mockOK(null)
    await api.deleteArticle('tok', 'acc1', 'a1')
    mockOK([])
    await api.searchArticles('tok', 'acc1', 'refund', 3)
    expect(lastFetchCall().url).toContain('q=refund')
    expect(lastFetchCall().url).toContain('limit=3')
    mockOK([])
    await api.searchArticles('tok', 'acc1', 'refund')
    expect(lastFetchCall().url).not.toContain('limit=')
  })

  it('sla CRUD', async () => {
    mockOK([])
    await api.listSlaPolicies('tok', 'acc1')
    mockOK({})
    await api.createSlaPolicy('tok', 'acc1', {} as never)
    mockOK({})
    await api.updateSlaPolicy('tok', 'acc1', 's1', {} as never)
    mockOK(null)
    await api.deleteSlaPolicy('tok', 'acc1', 's1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })
})

// ─── API keys + 2FA + member mgmt + search + usage ────────────

describe('api keys, 2FA, member management, search, usage', () => {
  it('api keys CRUD', async () => {
    mockOK([])
    await api.listApiKeys('tok', 'acc1')
    mockOK({})
    await api.createApiKey('tok', 'acc1', { name: 'k' } as never)
    mockOK(null)
    await api.revokeApiKey('tok', 'acc1', 'k1')
    expect(lastFetchCall().init.method).toBe('DELETE')
  })

  it('TOTP setup / verify / disable / challenge', async () => {
    mockOK({})
    await api.totpSetup('tok')
    expect(lastFetchCall().url).toMatch(/me\/2fa\/setup$/)
    mockOK({})
    await api.totpVerify('tok', '123456')
    expect(JSON.parse(lastFetchCall().init.body as string)).toEqual({ code: '123456' })
    mockOK(null)
    await api.totpDisable('tok', '123456')
    expect(lastFetchCall().url).toMatch(/me\/2fa\/disable$/)
    mockOK({})
    await api.totpChallenge('ch1', '000000')
    expect(lastFetchCall().url).toMatch(/auth\/2fa\/challenge$/)
  })

  it('inviteMember / removeMember / changeMemberRole', async () => {
    mockOK({})
    await api.inviteMember('tok', 'acc1', {
      email: 'a@e.com', role: 'AGENT', fullName: 'A',
    })
    expect(lastFetchCall().init.method).toBe('POST')
    mockOK(null)
    await api.removeMember('tok', 'acc1', 'u1')
    expect(lastFetchCall().init.method).toBe('DELETE')
    mockOK({})
    await api.changeMemberRole('tok', 'acc1', 'u1', { role: 'SUPERVISOR' } as never)
    expect(lastFetchCall().init.method).toBe('PATCH')
  })

  it('search', async () => {
    mockOK({ hits: [] })
    await api.search('tok', 'acc1', 'q1')
    expect(lastFetchCall().url).toContain('q=q1')
  })

  it('getUsage', async () => {
    mockOK({})
    await api.getUsage('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/usage`)
  })
})

// ---------- 401 handling ----------

describe('request() on 401', () => {
  const setLocation = (pathname: string, search = '') => {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname, search, replace },
    })
    return replace
  }

  beforeEach(() => {
    window.localStorage.setItem('cosmika.session', '{"session":{"token":"t"}}')
  })

  it('clears the dead session and sends the user to sign-in', async () => {
    const replace = setLocation('/conversations', '?status=open')
    mockErr(401, { message: 'Unauthorized' })
    await expect(
      api.listConversations('dead-token', 'acc1'),
    ).rejects.toBeInstanceOf(ApiError)
    expect(window.localStorage.getItem('cosmika.session')).toBeNull()
    expect(replace).toHaveBeenCalledWith(
      '/sign-in?next=%2Fconversations%3Fstatus%3Dopen',
    )
  })

  it('leaves the sign-in form alone — a 401 there is a wrong password', async () => {
    const replace = setLocation('/sign-in')
    mockErr(401, { message: 'Invalid credentials' })
    await expect(
      api.listConversations('whatever', 'acc1'),
    ).rejects.toBeInstanceOf(ApiError)
    expect(replace).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('cosmika.session')).not.toBeNull()
  })

  it('does not touch the session when no token was sent', async () => {
    const replace = setLocation('/sign-up')
    mockErr(401, { message: 'Unauthorized' })
    await expect(api.signIn({ email: 'a@b.c', password: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    )
    expect(replace).not.toHaveBeenCalled()
  })

  it('still surfaces other failures without redirecting', async () => {
    const replace = setLocation('/contacts')
    mockErr(500, { message: 'boom' })
    await expect(api.listConversations('t', 'acc1')).rejects.toBeInstanceOf(ApiError)
    expect(replace).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('cosmika.session')).not.toBeNull()
  })
})

// ---------- 402 handling ----------

describe('request() on 402 payment_required', () => {
  const setLocation = (pathname: string) => {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname, search: '', replace },
    })
    return replace
  }

  it('sends a locked-out account to the subscription screen, keeping the session', async () => {
    window.localStorage.setItem('cosmika.session', '{"session":{"token":"t"}}')
    const replace = setLocation('/conversations')
    mockErr(402, { error: 'payment_required', message: 'This account has no active subscription.' })
    await expect(api.listConversations('t', 'acc1')).rejects.toBeInstanceOf(ApiError)
    expect(replace).toHaveBeenCalledWith('/subscription')
    expect(window.localStorage.getItem('cosmika.session')).not.toBeNull()
  })

  it('does not loop when already on the subscription screen', async () => {
    const replace = setLocation('/subscription')
    mockErr(402, { error: 'payment_required' })
    await expect(api.listConversations('t', 'acc1')).rejects.toBeInstanceOf(ApiError)
    expect(replace).not.toHaveBeenCalled()
  })

  it('ignores a 402 that is not the billing gate, or sent without a token', async () => {
    const replace = setLocation('/contacts')
    mockErr(402, { error: 'something_else' })
    await expect(api.listConversations('t', 'acc1')).rejects.toBeInstanceOf(ApiError)
    mockErr(402, 'plain text')
    await expect(api.listConversations('t', 'acc1')).rejects.toBeInstanceOf(ApiError)
    mockErr(402, { error: 'payment_required' })
    await expect(api.signIn({ email: 'a@b.c', password: 'x' })).rejects.toBeInstanceOf(ApiError)
    expect(replace).not.toHaveBeenCalled()
  })

  it('reads the billing status from the exempt route', async () => {
    mockOK({ accessAllowed: false, paying: false, trialExpiresAt: '2026-09-20', checkoutUrl: null })
    await api.getBillingStatus('t')
    expect(lastFetchCall().url).toBe(`${API_BASE}/billing/status`)
  })
})

describe('onboarding endpoint', () => {
  it('getOnboarding reads the account checklist with the session token', async () => {
    const status = {
      steps: { channel: true, firstMessage: false, automation: false, team: false },
      completed: 1,
      total: 4,
    }
    mockOK(status)
    await expect(api.getOnboarding('tok', 'acc1')).resolves.toEqual(status)
    const { url, init } = lastFetchCall()
    expect(url).toBe(`${API_BASE}/accounts/acc1/onboarding`)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' })
  })
})

describe('api.createInbox', () => {
  it('posts Telegram inboxes to their own route, everything else to /inboxes', async () => {
    mockOK({ id: 'i1' })
    await api.createInbox('tok', 'acc1', {
      name: 'Telegram',
      channelType: 'TELEGRAM',
      channelConfig: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_-12' },
    })
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/inboxes/telegram`)
    mockOK({ id: 'i2' })
    await api.createInbox('tok', 'acc1', { name: 'API', channelType: 'API', channelConfig: {} })
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/inboxes`)
    expect(lastFetchCall().init.method).toBe('POST')
  })
})

describe('api.connectMetaPage', () => {
  it('posts the Page to /inboxes/meta', async () => {
    mockOK([{ id: 'i1' }, { id: 'i2' }])
    const out = await api.connectMetaPage('tok', 'acc1', {
      pageId: '111',
      pageAccessToken: 'EAAG-page-token-long-enough',
      messenger: true,
      instagram: true,
    })
    expect(out).toHaveLength(2)
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/inboxes/meta`)
    expect(JSON.parse(String(lastFetchCall().init.body))).toMatchObject({ pageId: '111', instagram: true })
  })
})

describe('api.slaMisses', () => {
  it('passes only the filters that are set', async () => {
    mockOK([])
    await api.slaMisses('tok', 'acc1', { from: '2026-10-16T00:00:00.000Z', teamId: 't1', inboxId: '' })
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/sla/misses?from=2026-10-16T00%3A00%3A00.000Z&teamId=t1`,
    )
    mockOK('a;b\n')
    await api.slaMissesCsv('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/sla/misses.csv?`)
  })
})

describe('createDataExportLink', () => {
  it('POSTs for a ticket and returns an absolute download URL', async () => {
    mockOK({ url: '/exports/download/tkt' })
    const url = await api.createDataExportLink('tok', 'acc1', 'conversations', {
      format: 'json',
      from: '2026-10-01T03:00:00.000Z',
    })
    expect(url).toBe(`${API_BASE}/exports/download/tkt`)
    const { url: called, init } = lastFetchCall()
    expect(called).toBe(
      `${API_BASE}/accounts/acc1/exports/conversations/ticket?format=json&from=2026-10-01T03%3A00%3A00.000Z`,
    )
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('surfaces the API error message', async () => {
    mockErr(403, { code: 'supervisor_required', message: 'Supervisor or admin required' })
    await expect(
      api.createDataExportLink('tok', 'acc1', 'contacts', { format: 'csv' }),
    ).rejects.toMatchObject({ status: 403, message: 'Supervisor or admin required' })
  })
})

describe('NPS + survey settings', () => {
  it('reads and writes the survey type', async () => {
    mockOK({ surveyType: 'CSAT' })
    await api.getSurveySettings('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/csat/settings`)
    mockOK({ surveyType: 'NPS' })
    await api.updateSurveySettings('tok', 'acc1', { surveyType: 'NPS' })
    expect(lastFetchCall().init.method).toBe('PUT')
    expect(lastFetchCall().init.body).toBe('{"surveyType":"NPS"}')
  })

  it('passes the NPS filters to the stats and CSV endpoints', async () => {
    mockOK({})
    await api.getNpsStats('tok', 'acc1', { teamId: 't1', from: '2026-10-01T03:00:00.000Z' })
    expect(lastFetchCall().url).toBe(
      `${API_BASE}/accounts/acc1/csat/nps?teamId=t1&from=2026-10-01T03%3A00%3A00.000Z`,
    )
    mockOK('dimensao,nome')
    await api.getNpsCsv('tok', 'acc1')
    expect(lastFetchCall().url).toBe(`${API_BASE}/accounts/acc1/csat/nps.csv`)
  })
})
