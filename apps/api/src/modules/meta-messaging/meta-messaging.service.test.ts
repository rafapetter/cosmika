import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MetaChannelAdapter } from './meta-channel.adapter'
import { metaGraphBase, metaMessagingSettings } from './meta-messaging.config'
import { MetaMessagingService, type MetaWebhookPayload } from './meta-messaging.service'

const APP_SECRET = 'app-secret-for-tests'
const PAGE_TOKEN = 'EAAG-page-token-long-enough'

function fbInbox(over: Record<string, unknown> = {}) {
  return {
    id: 'inb-fb',
    accountId: 'acc1',
    channelType: 'FACEBOOK',
    channelConfig: { pageId: '111', pageAccessToken: PAGE_TOKEN, pageName: 'CosmoBots' },
    ...over,
  }
}
function igInbox() {
  return fbInbox({
    id: 'inb-ig',
    channelType: 'INSTAGRAM',
    channelConfig: { pageId: '111', pageAccessToken: PAGE_TOKEN, instagramId: '1784' },
  })
}

function makePrisma() {
  return {
    inbox: {
      findFirst: vi.fn().mockResolvedValue(fbInbox()),
      findUnique: vi.fn().mockResolvedValue(fbInbox()),
    },
    conversation: { findUnique: vi.fn() },
    message: { findFirst: vi.fn().mockResolvedValue(null) },
  }
}
function makeInbound() {
  return {
    alreadyIngested: vi.fn().mockResolvedValue(false),
    // Runs the name lookup like the real resolver does for a new contact.
    resolve: vi.fn().mockImplementation(async (_inbox, sender) => {
      if (typeof sender.name === 'function') sender.resolvedName = await sender.name()
      return { kind: 'ok', conversation: { id: 'cv1' } }
    }),
    ingest: vi.fn().mockResolvedValue({ id: 'm1' }),
    stampOutbound: vi.fn(),
  }
}
function make() {
  const prisma = makePrisma()
  const inbound = makeInbound()
  const attachments = { ingestFromChannel: vi.fn().mockResolvedValue({ id: 'att1' }) }
  const inboxes = {
    createMetaInbox: vi.fn().mockImplementation(async (_u, _a, input) => ({ id: `new-${input.channelType}`, ...input })),
  }
  const svc = new MetaMessagingService(prisma as never, attachments as never, inbound as never, inboxes as never)
  return { svc, prisma, inbound, attachments, inboxes }
}

type Route = { status?: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> }
/** fetch double: the first matching substring decides the answer. */
function mockFetch(routes: Record<string, Route | Error> = {}) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    void init
    for (const [needle, r] of Object.entries(routes)) {
      if (!u.includes(needle)) continue
      if (r instanceof Error) throw r
      if (r.body !== undefined) return new Response(r.body, { status: r.status ?? 200, headers: r.headers })
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 })
    }
    return new Response(JSON.stringify({ message_id: 'mid.out' }), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
const jsonBody = (fn: ReturnType<typeof mockFetch>, i: number) => JSON.parse(String(fn.mock.calls[i]![1]!.body))

function sign(raw: string) {
  return `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`
}
function deliver(svc: MetaMessagingService, payload: MetaWebhookPayload, sig?: string) {
  const raw = JSON.stringify(payload)
  return svc.ingestWebhook(Buffer.from(raw), { sha256: sig ?? sign(raw), sha1: 'sha1=abc' }, payload)
}

beforeEach(() => {
  process.env.META_APP_SECRET = APP_SECRET
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me'
  delete process.env.META_RELAY_PAGE_URL
  delete process.env.META_RELAY_INSTAGRAM_URL
  delete process.env.COSMIKA_META_STUB
  delete process.env.META_GRAPH_BASE_URL
  delete process.env.META_GRAPH_API_VERSION
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.META_APP_SECRET
  delete process.env.META_WEBHOOK_VERIFY_TOKEN
})

describe('meta-messaging config', () => {
  it('is off without the app secret, and reads the rest when present', () => {
    delete process.env.META_APP_SECRET
    expect(metaMessagingSettings()).toBeNull()
    process.env.META_APP_SECRET = ' s '
    process.env.META_GRAPH_BASE_URL = 'http://graph.local/'
    process.env.META_GRAPH_API_VERSION = 'v99.0'
    process.env.META_RELAY_PAGE_URL = 'https://desk/bot'
    process.env.META_WEBHOOK_VERIFY_TOKEN = ''
    expect(metaMessagingSettings()).toEqual({
      appSecret: 's',
      verifyToken: null,
      graphBase: 'http://graph.local/v99.0',
      relay: { page: 'https://desk/bot', instagram: null },
    })
    expect(metaGraphBase()).toBe('http://graph.local/v99.0')
  })

  it('defaults the Graph base', () => {
    expect(metaGraphBase()).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+$/)
  })
})

describe('MetaMessagingService.verifyChallenge', () => {
  it('echoes the challenge for our token only', () => {
    const { svc } = make()
    expect(svc.verifyChallenge('subscribe', 'verify-me', '42')).toBe('42')
    expect(() => svc.verifyChallenge('subscribe', 'nope', '42')).toThrow(/Forbidden/)
    expect(() => svc.verifyChallenge('unsubscribe', 'verify-me', '42')).toThrow(/Forbidden/)
    expect(() => svc.verifyChallenge('subscribe', undefined, '42')).toThrow(/Forbidden/)
    expect(() => svc.verifyChallenge('subscribe', 'verify-me', undefined)).toThrow(/Forbidden/)
    delete process.env.META_WEBHOOK_VERIFY_TOKEN
    expect(() => svc.verifyChallenge('subscribe', 'verify-me', '42')).toThrow(/Not Found/)
  })
})

describe('MetaMessagingService.ingestWebhook', () => {
  const textEvent = (over: Record<string, unknown> = {}) => ({
    sender: { id: 'psid-1' },
    recipient: { id: '111' },
    timestamp: 1_760_640_000_000,
    message: { mid: 'mid.1', text: 'Olá' },
    ...over,
  })
  const page = (events: unknown[], id = '111'): MetaWebhookPayload => ({
    object: 'page',
    entry: [{ id, messaging: events as never }],
  })

  it('refuses a body Meta did not sign, and is off without the app secret', async () => {
    const { svc, inbound } = make()
    await expect(deliver(svc, page([textEvent()]), 'sha256=forged')).rejects.toThrow(/Forbidden/)
    const raw = JSON.stringify(page([]))
    await expect(svc.ingestWebhook(Buffer.from(raw), {}, page([]))).rejects.toThrow(/Forbidden/)
    delete process.env.META_APP_SECRET
    await expect(deliver(svc, page([]))).rejects.toThrow(/Not Found/)
    expect(inbound.resolve).not.toHaveBeenCalled()
  })

  it('ingests a Messenger text, with the sender profile name', async () => {
    const { svc, inbound, prisma } = make()
    mockFetch({ 'psid-1?': { json: { first_name: 'Ana', last_name: 'Souza' } } })
    await expect(deliver(svc, page([textEvent()]))).resolves.toEqual({ processed: 1, relayed: false })
    expect(prisma.inbox.findFirst).toHaveBeenCalledWith({
      where: { channelType: 'FACEBOOK', channelConfig: { path: ['pageId'], equals: '111' } },
    })
    expect(inbound.resolve.mock.calls[0]![1]).toMatchObject({
      sourceId: 'psid-1',
      identifier: 'messenger:psid-1',
      resolvedName: 'Ana Souza',
    })
    expect(inbound.ingest).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      content: 'Olá',
      contentType: 'TEXT',
      contentAttributes: { external_created_at: new Date(1_760_640_000_000).toISOString() },
      externalSourceId: 'fb:mid.1',
      attachmentIds: undefined,
    })
  })

  it('routes Instagram by account id and names by username', async () => {
    const { svc, inbound, prisma } = make()
    prisma.inbox.findFirst.mockResolvedValue(igInbox())
    mockFetch({ 'igsid?': { json: { username: 'ana.ig' } } })
    await deliver(svc, {
      object: 'instagram',
      entry: [{ id: '1784', messaging: [textEvent({ sender: { id: 'igsid' }, timestamp: undefined })] }],
    })
    expect(prisma.inbox.findFirst.mock.calls[0]![0].where.channelConfig.path).toEqual(['instagramId'])
    expect(inbound.resolve.mock.calls[0]![1]).toMatchObject({ identifier: 'instagram:igsid', resolvedName: 'ana.ig' })
    expect(inbound.ingest.mock.calls[0]![0]).toMatchObject({ externalSourceId: 'ig:mid.1', contentAttributes: {} })
  })

  it('a tapped quick reply or postback carries its option id', async () => {
    const { svc, inbound } = make()
    mockFetch({ '?': { status: 400, json: { error: { message: 'no profile' } } } })
    await deliver(
      svc,
      page([
        textEvent({ message: { mid: 'mid.2', text: 'Financeiro', quick_reply: { payload: 'fin' } } }),
        textEvent({ message: undefined, postback: { mid: 'mid.3', title: 'Cadastro', payload: 'cad' } }),
        textEvent({ message: undefined, postback: { title: 'Sem mid', payload: 'x' } }),
      ]),
    )
    const calls = inbound.ingest.mock.calls.map((c) => c[0])
    expect(calls[0]).toMatchObject({ content: 'Financeiro', contentAttributes: { interactiveReplyId: 'fin' } })
    expect(calls[1]).toMatchObject({ content: 'Cadastro', contentAttributes: { interactiveReplyId: 'cad' } })
    expect(calls[2].externalSourceId).toBe('fb:psid-1:1760640000000')
    expect(inbound.resolve.mock.calls[0]![1].resolvedName).toBeNull()
  })

  it('skips echoes, receipts, senderless events, retries and blocked contacts', async () => {
    const { svc, inbound } = make()
    mockFetch()
    await deliver(svc, page([
      textEvent({ message: { mid: 'e', text: 'eco', is_echo: true } }),
      { sender: { id: 'psid-1' }, read: { watermark: 1 } },
      textEvent({ sender: {} }),
    ]))
    expect(inbound.resolve).not.toHaveBeenCalled()
    inbound.alreadyIngested.mockResolvedValueOnce(true)
    await deliver(svc, page([textEvent()]))
    expect(inbound.resolve).not.toHaveBeenCalled()
    inbound.resolve.mockResolvedValueOnce({ kind: 'blocked' })
    await expect(deliver(svc, page([textEvent()]))).resolves.toEqual({ processed: 0, relayed: false })
    expect(inbound.ingest).not.toHaveBeenCalled()
  })

  it('stores a sent image, or records why it could not', async () => {
    const { svc, inbound, attachments } = make()
    mockFetch({
      'cdn.fb/ok/foto.jpg': { body: new Uint8Array([1, 2]), headers: { 'content-type': 'image/jpeg' } },
      'cdn.fb/gone': { status: 404, body: '' },
      'cdn.fb/noname/': { body: new Uint8Array([3]) },
    })
    const withAtt = (url: string, type = 'image') =>
      textEvent({ message: { mid: url, attachments: [{ type, payload: { url } }] } })
    await deliver(svc, page([
      withAtt('https://cdn.fb/ok/foto.jpg'),
      withAtt('https://cdn.fb/gone', 'audio'),
      withAtt('https://cdn.fb/noname/', 'file'),
    ]))
    expect(attachments.ingestFromChannel.mock.calls[0]).toEqual([
      'acc1',
      { buffer: Buffer.from([1, 2]), mimeType: 'image/jpeg', fileName: 'foto.jpg' },
    ])
    const calls = inbound.ingest.mock.calls.map((c) => c[0])
    expect(calls[0]).toMatchObject({ contentType: 'IMAGE', attachmentIds: ['att1'] })
    expect(calls[1]).toMatchObject({ contentType: 'AUDIO', contentAttributes: { mediaDownloadError: 'HTTP 404' } })
    expect(attachments.ingestFromChannel.mock.calls[1]![1]).toMatchObject({ fileName: undefined })
  })

  it('names attachment kinds it cannot store', async () => {
    const { svc, inbound } = make()
    mockFetch()
    await deliver(svc, page([
      textEvent({ message: { mid: 'a', attachments: [{ type: 'fallback' }] } }),
      textEvent({ message: { mid: 'b', attachments: [{}] } }),
      textEvent({ message: { mid: 'c' } }),
    ]))
    expect(inbound.ingest.mock.calls.map((c) => c[0].content)).toEqual(['[fallback]', '[attachment]', ''])
  })

  it('keeps answering 200 when one event fails', async () => {
    const { svc, inbound } = make()
    mockFetch()
    inbound.resolve.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce('string')
    await expect(deliver(svc, page([textEvent(), textEvent({ message: { mid: 'x', text: 'y' } })]))).resolves.toEqual({
      processed: 0,
      relayed: false,
    })
  })

  it('ignores objects that are not page or instagram', async () => {
    const { svc } = make()
    await expect(deliver(svc, { object: 'user', entry: [] })).resolves.toEqual({ processed: 0, relayed: false })
  })

  describe('relay to the system that still owns other pages', () => {
    it('forwards the untouched body and signatures when a page is not ours', async () => {
      process.env.META_RELAY_PAGE_URL = 'https://desk.example/bot'
      const { svc, prisma } = make()
      prisma.inbox.findFirst.mockResolvedValue(null)
      const fetchMock = mockFetch({ 'desk.example': { status: 200, json: {} } })
      const payload = page([textEvent()], '999')
      const raw = JSON.stringify(payload)
      await expect(deliver(svc, payload)).resolves.toEqual({ processed: 0, relayed: true })
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://desk.example/bot')
      expect(Buffer.from(init!.body as Buffer).toString()).toBe(raw)
      expect(init!.headers).toMatchObject({ 'x-hub-signature-256': sign(raw), 'x-hub-signature': 'sha1=abc' })
    })

    it('uses the Instagram relay for instagram events, and never throws on its failure', async () => {
      process.env.META_RELAY_INSTAGRAM_URL = 'https://desk.example/webhooks/instagram'
      const { svc, prisma } = make()
      prisma.inbox.findFirst.mockResolvedValue(null)
      mockFetch({ 'desk.example': { status: 500, json: {} } })
      const ig: MetaWebhookPayload = { object: 'instagram', entry: [{ id: '9', messaging: [] }, {}] }
      await expect(deliver(svc, ig)).resolves.toEqual({ processed: 0, relayed: true })
      mockFetch({ 'desk.example': new Error('down') })
      await expect(deliver(svc, ig)).resolves.toEqual({ processed: 0, relayed: true })
      mockFetch({ 'desk.example': 'boom' as never })
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'))
      await expect(deliver(svc, ig)).resolves.toEqual({ processed: 0, relayed: true })
    })

    it('does nothing for foreign pages when no relay is configured', async () => {
      const { svc, prisma } = make()
      prisma.inbox.findFirst.mockResolvedValue(null)
      const fetchMock = mockFetch()
      await expect(deliver(svc, page([textEvent()], '999'))).resolves.toEqual({ processed: 0, relayed: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe('MetaMessagingService.connectPage', () => {
  const input = { pageId: '111', pageAccessToken: PAGE_TOKEN, messenger: true, instagram: true }

  it('checks the Page, subscribes it and opens both inboxes', async () => {
    const { svc, inboxes } = make()
    const fetchMock = mockFetch({
      'subscribed_apps': { json: { success: true } },
      '/111?': { json: { id: '111', name: 'CosmoBots', instagram_business_account: { id: '1784', username: 'cosmobots' } } },
    })
    const out = await svc.connectPage('u1', 'acc1', input)
    expect(out.map((i) => i.id)).toEqual(['new-FACEBOOK', 'new-INSTAGRAM'])
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/111/subscribed_apps?subscribed_fields=messages%2Cmessaging_postbacks')
    expect(inboxes.createMetaInbox.mock.calls[0]![2]).toEqual({
      name: 'Messenger CosmoBots',
      channelType: 'FACEBOOK',
      channelConfig: { pageId: '111', pageAccessToken: PAGE_TOKEN, pageName: 'CosmoBots' },
    })
    expect(inboxes.createMetaInbox.mock.calls[1]![2]).toMatchObject({
      name: 'Instagram @cosmobots',
      channelType: 'INSTAGRAM',
      channelConfig: { instagramId: '1784', instagramUsername: 'cosmobots' },
    })
  })

  it('uses given names and falls back to ids', async () => {
    const { svc, inboxes } = make()
    mockFetch({
      'subscribed_apps': { json: {} },
      '/111?': { json: { id: '111', instagram_business_account: { id: '1784' } } },
    })
    await svc.connectPage('u1', 'acc1', { ...input, messengerName: 'FB', instagramName: undefined })
    expect(inboxes.createMetaInbox.mock.calls.map((c) => c[2].name)).toEqual(['FB', 'Instagram 1784'])
    expect(inboxes.createMetaInbox.mock.calls[0]![2].channelConfig.pageName).toBeNull()
    mockFetch({ 'subscribed_apps': { json: {} }, '/111?': { json: { id: '111' } } })
    await svc.connectPage('u1', 'acc1', { ...input, instagram: false })
    expect(inboxes.createMetaInbox.mock.calls[2]![2].name).toBe('Messenger 111')
  })

  it('refuses nothing chosen, a bad token, a Page without Instagram, and a refused subscription', async () => {
    const { svc, inboxes } = make()
    await expect(svc.connectPage('u1', 'acc1', { ...input, messenger: false, instagram: false })).rejects.toThrow(/Choose/)
    mockFetch({ '/111?': { status: 400, json: { error: { message: 'Invalid OAuth access token' } } } })
    await expect(svc.connectPage('u1', 'acc1', input)).rejects.toThrow(/Invalid OAuth/)
    mockFetch({ '/111?': { json: { id: '111' } } })
    await expect(svc.connectPage('u1', 'acc1', input)).rejects.toThrow(/no Instagram/)
    mockFetch({ 'subscribed_apps': { status: 403, json: { error: { message: 'pages_messaging missing' } } }, '/111?': { json: { id: '111' } } })
    await expect(svc.connectPage('u1', 'acc1', { ...input, instagram: false })).rejects.toThrow(/pages_messaging missing/)
    mockFetch({ 'subscribed_apps': { json: { success: false } }, '/111?': { json: { id: '111' } } })
    await expect(svc.connectPage('u1', 'acc1', { ...input, instagram: false })).rejects.toThrow(/refused to subscribe/)
    expect(inboxes.createMetaInbox).not.toHaveBeenCalled()
  })

  it('stub mode never calls Meta', async () => {
    process.env.COSMIKA_META_STUB = '1'
    const { svc } = make()
    const fetchMock = mockFetch()
    await expect(svc.connectPage('u1', 'acc1', input)).resolves.toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('MetaMessagingService outbound', () => {
  it('finds the PSID of a conversation on the right channel only', async () => {
    const { svc, prisma } = make()
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'FACEBOOK' }, contactInbox: { sourceId: 'psid' } })
    await expect(svc.recipientForConversation('FACEBOOK', 'cv1')).resolves.toBe('psid')
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'FACEBOOK' }, contactInbox: null })
    await expect(svc.recipientForConversation('FACEBOOK', 'cv1')).resolves.toBeNull()
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'INSTAGRAM' }, contactInbox: { sourceId: 'x' } })
    await expect(svc.recipientForConversation('FACEBOOK', 'cv1')).resolves.toBeNull()
    prisma.conversation.findUnique.mockResolvedValueOnce(null)
    await expect(svc.recipientForConversation('INSTAGRAM', 'cv1')).resolves.toBeNull()
  })

  it('opens the reply window for 24 h after the last contact message', async () => {
    const { svc, prisma } = make()
    await expect(svc.windowFor('cv1')).resolves.toEqual({ open: false, lastInboundAt: null, expiresAt: null })
    prisma.message.findFirst.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 60_000) })
    await expect(svc.windowFor('cv1')).resolves.toMatchObject({ open: true })
    prisma.message.findFirst.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 25 * 3600_000) })
    await expect(svc.windowFor('cv1')).resolves.toMatchObject({ open: false })
  })

  it('sends text as a RESPONSE, split at the product limit', async () => {
    const { svc } = make()
    const fetchMock = mockFetch()
    await expect(svc.sendText('FACEBOOK', 'inb-fb', 'psid', 'oi')).resolves.toEqual({ externalId: 'mid.out' })
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/111/messages')
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ authorization: `Bearer ${PAGE_TOKEN}` })
    expect(jsonBody(fetchMock, 0)).toEqual({ recipient: { id: 'psid' }, messaging_type: 'RESPONSE', message: { text: 'oi' } })
    await svc.sendText('INSTAGRAM', 'inb-fb', 'igsid', 'x'.repeat(1500))
    expect([jsonBody(fetchMock, 1).message.text.length, jsonBody(fetchMock, 2).message.text.length]).toEqual([1000, 500])
  })

  it('surfaces a refused send', async () => {
    const { svc } = make()
    mockFetch({ '/messages': { status: 400, json: { error: { message: 'outside the window' } } } })
    await expect(svc.sendText('FACEBOOK', 'inb-fb', 'psid', 'oi')).rejects.toThrow(/outside the window/)
  })

  it('draws menus as quick replies, numbered text past 13 options', async () => {
    const { svc } = make()
    const fetchMock = mockFetch()
    await svc.sendInteractive('inb-fb', 'psid', {
      kind: 'buttons',
      body: 'Setor?',
      buttons: [
        { id: 'fin', label: 'Financeiro' },
        { id: 'long', label: 'Um rótulo bem comprido demais' },
      ],
    } as never)
    expect(jsonBody(fetchMock, 0).message).toEqual({
      text: 'Setor?',
      quick_replies: [
        { content_type: 'text', title: 'Financeiro', payload: 'fin' },
        { content_type: 'text', title: 'Um rótulo bem compr…', payload: 'long' },
      ],
    })
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, title: `Opção ${i + 1}` }))
    await svc.sendInteractive('inb-fb', 'psid', { kind: 'list', body: 'Escolha', buttonText: 'Ver', sections: [{ rows }] } as never)
    expect(jsonBody(fetchMock, 1).message.text).toMatch(/^Escolha\n1\. Opção 1\n2\. Opção 2/)
  })

  it('sends media by link, caption first, files as Messenger files', async () => {
    const { svc } = make()
    const fetchMock = mockFetch()
    await svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', { kind: 'image', source: { link: 'https://x/a.png' }, caption: 'veja' })
    await svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', { kind: 'document', source: { link: 'https://x/b.pdf' } })
    expect(jsonBody(fetchMock, 0).message).toEqual({ text: 'veja' })
    expect(jsonBody(fetchMock, 1).message).toEqual({ attachment: { type: 'image', payload: { url: 'https://x/a.png', is_reusable: true } } })
    expect(jsonBody(fetchMock, 2).message.attachment.type).toBe('file')
  })

  it('sends a link instead of a document on Instagram', async () => {
    const { svc } = make()
    const fetchMock = mockFetch()
    await svc.sendMedia('INSTAGRAM', 'inb-fb', 'igsid', { kind: 'document', source: { link: 'https://x/b.pdf' }, fileName: 'Boleto.pdf', caption: 'boleto' })
    await svc.sendMedia('INSTAGRAM', 'inb-fb', 'igsid', { kind: 'document', source: { buffer: Buffer.from('x'), mimeType: 'application/pdf', fileName: 'b.pdf' } })
    expect(jsonBody(fetchMock, 0).message.text).toBe('boleto\nBoleto.pdf\nhttps://x/b.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uploads bytes as multipart when there is no public link', async () => {
    const { svc } = make()
    const fetchMock = mockFetch({ '/messages': { json: { message_id: 'mid.up' } } })
    const r = await svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', {
      kind: 'audio',
      source: { buffer: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a.mp3' },
      fileName: 'aviso.mp3',
    })
    expect(r).toEqual({ externalId: 'mid.up' })
    const form = fetchMock.mock.calls[0]![1]!.body as FormData
    expect(JSON.parse(String(form.get('message')))).toEqual({ attachment: { type: 'audio', payload: { is_reusable: true } } })
    expect((form.get('filedata') as File).name).toBe('aviso.mp3')
    await svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', {
      kind: 'video',
      source: { buffer: Buffer.from('x'), mimeType: 'video/mp4', fileName: 'v.mp4' },
    })
    expect(((fetchMock.mock.calls[1]![1]!.body as FormData).get('filedata') as File).name).toBe('v.mp4')
    mockFetch({ '/messages': { status: 400, json: {} } })
    await expect(
      svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', { kind: 'audio', source: { buffer: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a.mp3' } }),
    ).rejects.toThrow(/upload failed \(400\): unknown error/)
    mockFetch({ '/messages': { status: 200, body: 'not json' } })
    await expect(
      svc.sendMedia('FACEBOOK', 'inb-fb', 'psid', { kind: 'audio', source: { buffer: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a.mp3' } }),
    ).resolves.toEqual({ externalId: null })
  })

  it('refuses inboxes that are not Messenger or Instagram, or lost their token', async () => {
    const { svc, prisma } = make()
    prisma.inbox.findUnique.mockResolvedValueOnce(fbInbox({ channelType: 'TELEGRAM' }))
    await expect(svc.sendText('FACEBOOK', 'x', 'p', 'oi')).rejects.toThrow(/Not Found/)
    prisma.inbox.findUnique.mockResolvedValueOnce(null)
    await expect(svc.sendText('FACEBOOK', 'x', 'p', 'oi')).rejects.toThrow(/Not Found/)
    prisma.inbox.findUnique.mockResolvedValueOnce(fbInbox({ channelConfig: { pageId: '111' } }))
    await expect(svc.sendText('FACEBOOK', 'x', 'p', 'oi')).rejects.toThrow(/missing its Page token/)
    prisma.inbox.findUnique.mockResolvedValueOnce(fbInbox({ channelConfig: null }))
    await expect(svc.sendText('FACEBOOK', 'x', 'p', 'oi')).rejects.toThrow(/missing its Page token/)
  })

  it('stub mode answers without calling Meta', async () => {
    process.env.COSMIKA_META_STUB = '1'
    const { svc } = make()
    const fetchMock = mockFetch()
    expect((await svc.sendText('FACEBOOK', 'inb-fb', 'p', 'oi')).externalId).toMatch(/^stub-meta-/)
    expect(
      (await svc.sendMedia('FACEBOOK', 'inb-fb', 'p', { kind: 'audio', source: { buffer: Buffer.from('x'), mimeType: 'audio/mpeg', fileName: 'a' } })).externalId,
    ).toMatch(/^stub-meta-/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('MetaChannelAdapter', () => {
  it('delegates with its channel type and never puts a caption on media', async () => {
    const meta = {
      recipientForConversation: vi.fn().mockResolvedValue('psid'),
      windowFor: vi.fn().mockResolvedValue({ open: true, lastInboundAt: null, expiresAt: null }),
      sendText: vi.fn().mockResolvedValue({ externalId: 'a' }),
      sendMedia: vi.fn().mockResolvedValue({ externalId: 'b' }),
      sendInteractive: vi.fn().mockResolvedValue({ externalId: 'c' }),
    }
    const inbound = { stampOutbound: vi.fn().mockResolvedValue(undefined) }
    const a = new MetaChannelAdapter('INSTAGRAM', meta as never, inbound as never)
    await a.recipientFor('cv1')
    expect(meta.recipientForConversation).toHaveBeenCalledWith('INSTAGRAM', 'cv1')
    await expect(a.windowFor('cv1')).resolves.toMatchObject({ open: true })
    await a.sendText('i', 'p', 't')
    expect(meta.sendText).toHaveBeenCalledWith('INSTAGRAM', 'i', 'p', 't')
    await a.sendMedia('i', 'p', { kind: 'image', source: { link: 'u' } })
    expect(meta.sendMedia.mock.calls[0]![0]).toBe('INSTAGRAM')
    await expect(a.sendInteractive('i', 'p', {} as never)).resolves.toEqual({ externalId: 'c' })
    await a.stampOutbound('m', ['x'])
    expect(inbound.stampOutbound).toHaveBeenCalledWith('m', ['x'])
    expect(a.captionMax).toBe(0)
    expect(a.captionFits()).toBe(false)
    expect(a.mediaMaxBytes('video')).toBe(25 * 1024 * 1024)
  })

  it('maps attachment types', () => {
    const a = new MetaChannelAdapter('FACEBOOK', {} as never, {} as never)
    expect(a.mediaKindFor('IMAGE', 'image/png')).toBe('image')
    expect(a.mediaKindFor('IMAGE', 'image/webp')).toBe('document')
    expect(a.mediaKindFor('IMAGE', 'image/jpeg', 9 * 1024 * 1024)).toBe('document')
    expect(a.mediaKindFor('IMAGE', null)).toBe('document')
    expect(a.mediaKindFor('VIDEO', 'video/mp4')).toBe('video')
    expect(a.mediaKindFor('AUDIO', 'audio/ogg')).toBe('audio')
    expect(a.mediaKindFor('FILE', 'application/pdf')).toBe('document')
  })
})
