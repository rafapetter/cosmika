import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TelegramChannelAdapter } from './telegram-channel.adapter'
import { TelegramService, callbackDataFor, menuOptions, type TgUpdate } from './telegram.service'
import { TelegramApiError, tgCall, tgDownload, telegramApiBase } from './telegram.api'

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_-12'
const SECRET = 'a'.repeat(48)

function inbox(over: Record<string, unknown> = {}) {
  return {
    id: 'inb-tg',
    accountId: 'acc1',
    channelType: 'TELEGRAM',
    channelConfig: { botToken: TOKEN, webhookSecret: SECRET },
    ...over,
  }
}

function makePrisma() {
  return {
    inbox: {
      findUnique: vi.fn().mockResolvedValue(inbox()),
      update: vi.fn().mockImplementation(async ({ data }) => ({ ...inbox(), ...data })),
    },
    conversation: { findUnique: vi.fn() },
    message: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

function makeInbound() {
  return {
    alreadyIngested: vi.fn().mockResolvedValue(false),
    resolve: vi.fn().mockResolvedValue({
      kind: 'ok',
      contact: { id: 'ct1' },
      contactInbox: { id: 'ci1' },
      conversation: { id: 'cv1' },
    }),
    ingest: vi.fn().mockResolvedValue({ id: 'm1' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
  }
}

function makeAttachments() {
  return { ingestFromChannel: vi.fn().mockResolvedValue({ id: 'att1' }) }
}

function make() {
  const prisma = makePrisma()
  const inbound = makeInbound()
  const attachments = makeAttachments()
  const svc = new TelegramService(prisma as never, attachments as never, inbound as never)
  return { svc, prisma, inbound, attachments }
}

/** A fetch double answering Bot API calls by method name. */
function mockTelegram(results: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/file/bot')) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }
    const method = u.slice(u.lastIndexOf('/') + 1)
    const result =
      method in results
        ? results[method]
        : method === 'getFile'
          ? { file_path: 'voice/file_7.oga' }
          : { message_id: 42, chat: { id: 777 } }
    if (result instanceof Error) {
      return new Response(JSON.stringify({ ok: false, description: result.message }), { status: 400 })
    }
    void init
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodyOf(fetchMock: ReturnType<typeof mockTelegram>, method: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith(`/${method}`))
  if (!call) return undefined
  const body = call[1]?.body
  return typeof body === 'string' ? JSON.parse(body) : body
}

beforeEach(() => {
  delete process.env.COSMIKA_TELEGRAM_STUB
  delete process.env.TELEGRAM_API_BASE
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('telegram.api', () => {
  it('defaults to the public Bot API, overridable for tests', () => {
    expect(telegramApiBase()).toBe('https://api.telegram.org')
    process.env.TELEGRAM_API_BASE = 'http://tg.local/'
    expect(telegramApiBase()).toBe('http://tg.local')
  })

  it('surfaces Telegram errors and non-JSON answers', async () => {
    mockTelegram({ getMe: new Error('Unauthorized') })
    await expect(tgCall(TOKEN, 'getMe')).rejects.toThrow(/getMe failed \(400\): Unauthorized/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })))
    await expect(tgCall(TOKEN, 'getMe')).rejects.toBeInstanceOf(TelegramApiError)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })))
    await expect(tgCall(TOKEN, 'getMe')).rejects.toThrow(/unknown error/)
  })

  it('downloads a file, and says so when Telegram has no path for it', async () => {
    mockTelegram()
    await expect(tgDownload(TOKEN, 'f1')).resolves.toMatchObject({ filePath: 'voice/file_7.oga' })
    mockTelegram({ getFile: {} })
    await expect(tgDownload(TOKEN, 'f1')).rejects.toThrow(/no file_path/)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) =>
        String(u).includes('/file/')
          ? new Response('', { status: 404, statusText: 'Not Found' })
          : new Response(JSON.stringify({ ok: true, result: { file_path: 'x' } })),
      ),
    )
    await expect(tgDownload(TOKEN, 'f1')).rejects.toThrow(/file download failed \(404\)/)
  })
})

describe('callbackDataFor / menuOptions', () => {
  it('keeps short ids and hashes long ones under 64 bytes', () => {
    expect(callbackDataFor('opt-1')).toBe('opt-1')
    const long = 'x'.repeat(200)
    const data = callbackDataFor(long)
    expect(data.startsWith('h:')).toBe(true)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(callbackDataFor(long)).toBe(data)
  })

  it('flattens buttons and list rows', () => {
    expect(menuOptions({ kind: 'buttons', body: 'b', buttons: [{ id: 'a', label: 'A' }] } as never)).toEqual([
      { id: 'a', label: 'A' },
    ])
    expect(
      menuOptions({
        kind: 'list',
        body: 'b',
        buttonText: 'Ver',
        sections: [{ rows: [{ id: 'r1', title: 'Um' }] }, { rows: [{ id: 'r2', title: 'Dois' }] }],
      } as never),
    ).toEqual([
      { id: 'r1', label: 'Um' },
      { id: 'r2', label: 'Dois' },
    ])
  })
})

describe('TelegramService setup', () => {
  it('verifyToken returns the bot, or a 400 the admin can act on', async () => {
    const { svc } = make()
    mockTelegram({ getMe: { id: 9, is_bot: true, username: 'support_bot' } })
    await expect(svc.verifyToken(TOKEN)).resolves.toMatchObject({ username: 'support_bot' })
    mockTelegram({ getMe: new Error('Unauthorized') })
    await expect(svc.verifyToken(TOKEN)).rejects.toThrow(/did not accept this bot token/)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('network down'))
    await expect(svc.verifyToken(TOKEN)).rejects.toThrow(/did not accept/)
  })

  it('connect registers the webhook with our secret and stores who the bot is', async () => {
    const { svc, prisma } = make()
    const fetchMock = mockTelegram({ setWebhook: true })
    await svc.connect(inbox() as never, { id: 9, username: 'support_bot' }, 'https://app.cosmobots.io/api/')
    expect(bodyOf(fetchMock, 'setWebhook')).toEqual({
      url: 'https://app.cosmobots.io/api/webhooks/telegram/inb-tg',
      secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    })
    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig).toMatchObject({
      botUsername: 'support_bot',
      botId: 9,
      webhookUrl: 'https://app.cosmobots.io/api/webhooks/telegram/inb-tg',
    })
  })

  it('connect turns a refused webhook into a 502 and stores nothing', async () => {
    const { svc, prisma } = make()
    mockTelegram({ setWebhook: new Error('bad webhook: HTTPS url must be provided') })
    await expect(svc.connect(inbox() as never, { id: 9 }, 'http://localhost')).rejects.toThrow(/refused the webhook/)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'))
    await expect(svc.connect(inbox() as never, { id: 9 }, 'http://localhost')).rejects.toThrow(/boom/)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('stub mode skips Telegram entirely', async () => {
    process.env.COSMIKA_TELEGRAM_STUB = '1'
    const { svc, prisma } = make()
    const fetchMock = mockTelegram()
    await expect(svc.verifyToken(TOKEN)).resolves.toMatchObject({ username: 'stub_bot' })
    await svc.connect(inbox({ channelConfig: null }) as never, { id: 1 }, 'http://x')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig.botUsername).toBeNull()
  })
})

describe('TelegramService.ingestWebhook', () => {
  const textUpdate = (over: Record<string, unknown> = {}): TgUpdate => ({
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_760_000_000,
      chat: { id: 777, type: 'private' },
      from: { id: 555, first_name: 'Ana', last_name: 'Souza', username: 'anas' },
      text: 'Oi',
      ...over,
    },
  })

  it('rejects a call without the secret Telegram echoes back', async () => {
    const { svc, inbound } = make()
    await expect(svc.ingestWebhook('inb-tg', undefined, textUpdate())).rejects.toThrow(/Unauthorized/)
    await expect(svc.ingestWebhook('inb-tg', 'wrong', textUpdate())).rejects.toThrow(/Unauthorized/)
    expect(inbound.resolve).not.toHaveBeenCalled()
  })

  it('404s for an inbox that is not a Telegram one', async () => {
    const { svc, prisma } = make()
    prisma.inbox.findUnique.mockResolvedValue(inbox({ channelType: 'WHATSAPP' }))
    await expect(svc.ingestWebhook('inb-tg', SECRET, textUpdate())).rejects.toThrow(/Not Found/)
    prisma.inbox.findUnique.mockResolvedValue(null)
    await expect(svc.ingestWebhook('x', SECRET, textUpdate())).rejects.toThrow(/Not Found/)
  })

  it('400s when the inbox lost its token', async () => {
    const { svc, prisma } = make()
    prisma.inbox.findUnique.mockResolvedValue(inbox({ channelConfig: {} }))
    await expect(svc.ingestWebhook('inb-tg', SECRET, textUpdate())).rejects.toThrow(/missing its bot token/)
  })

  it('ingests a text message under the chat id, with the provider time', async () => {
    const { svc, inbound } = make()
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate())
    expect(inbound.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'inb-tg' }), {
      sourceId: '777',
      identifier: 'telegram:555',
      name: 'Ana Souza',
      additionalAttributes: { telegramUsername: 'anas' },
    })
    expect(inbound.ingest).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      content: 'Oi',
      contentType: 'TEXT',
      contentAttributes: { external_created_at: new Date(1_760_000_000 * 1000).toISOString() },
      externalSourceId: 'tg:777:10',
      attachmentIds: undefined,
    })
  })

  it('ignores groups, retries and blocked contacts', async () => {
    const { svc, inbound } = make()
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ chat: { id: -1, type: 'group' } }))
    expect(inbound.resolve).not.toHaveBeenCalled()
    inbound.alreadyIngested.mockResolvedValueOnce(true)
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate())
    expect(inbound.resolve).not.toHaveBeenCalled()
    inbound.resolve.mockResolvedValueOnce({ kind: 'blocked' })
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate())
    expect(inbound.ingest).not.toHaveBeenCalled()
  })

  it('names a contact by username, or not at all', async () => {
    const { svc, inbound } = make()
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ from: { id: 1, username: 'only_user' }, date: undefined }))
    expect(inbound.resolve.mock.calls[0]![1].name).toBe('only_user')
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ from: undefined, text: undefined }))
    expect(inbound.resolve.mock.calls[1]![1]).toMatchObject({ identifier: 'telegram:777', name: null })
    expect(inbound.ingest.mock.calls[1]![0]).toMatchObject({ content: '', contentAttributes: {} })
  })

  it('downloads media into storage before the message exists', async () => {
    const { svc, inbound, attachments } = make()
    mockTelegram()
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, voice: { file_id: 'v1' } }))
    expect(attachments.ingestFromChannel).toHaveBeenCalledWith('acc1', {
      buffer: Buffer.from([1, 2, 3]),
      mimeType: 'audio/ogg',
      fileName: 'file_7.oga',
    })
    expect(inbound.ingest.mock.calls[0]![0]).toMatchObject({ contentType: 'AUDIO', attachmentIds: ['att1'] })
  })

  it('maps every media kind and keeps the caption', async () => {
    const { svc, inbound } = make()
    mockTelegram()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ photo: [{ file_id: 's' }, { file_id: 'l' }], caption: 'foto' }, 'IMAGE'],
      [{ audio: { file_id: 'a', mime_type: 'audio/mpeg', file_name: 'x.mp3' } }, 'AUDIO'],
      [{ video: { file_id: 'v' } }, 'VIDEO'],
      [{ document: { file_id: 'd', mime_type: 'application/pdf', file_name: 'b.pdf' } }, 'FILE'],
    ]
    for (const [over] of cases) {
      await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, ...over }))
    }
    expect(inbound.ingest.mock.calls.map((c) => c[0].contentType)).toEqual(cases.map((c) => c[1]))
    expect(inbound.ingest.mock.calls[0]![0].content).toBe('foto')
  })

  it('records why a file is missing instead of dropping the message', async () => {
    const { svc, inbound } = make()
    mockTelegram({ getFile: new Error('file is too big') })
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, document: { file_id: 'd' } }))
    expect(inbound.ingest.mock.calls[0]![0].contentAttributes.mediaDownloadError).toMatch(/too big/)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'))
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, document: { file_id: 'd' } }))
    expect(inbound.ingest.mock.calls[1]![0].contentAttributes.mediaDownloadError).toBe('offline')
  })

  it('keeps a location and a sticker', async () => {
    const { svc, inbound } = make()
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, location: { latitude: -23.5, longitude: -46.6 } }))
    expect(inbound.ingest.mock.calls[0]![0]).toMatchObject({
      contentType: 'LOCATION',
      contentAttributes: { latitude: -23.5, longitude: -46.6 },
    })
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, sticker: { emoji: '👍' } }))
    await svc.ingestWebhook('inb-tg', SECRET, textUpdate({ text: undefined, sticker: {} }))
    expect(inbound.ingest.mock.calls.slice(1).map((c) => c[0].content)).toEqual(['👍', ''])
  })

  it('answers 200 even when ingestion blows up, so Telegram does not redeliver forever', async () => {
    const { svc, inbound } = make()
    inbound.resolve.mockRejectedValueOnce(new Error('db down'))
    await expect(svc.ingestWebhook('inb-tg', SECRET, textUpdate())).resolves.toBeUndefined()
    inbound.resolve.mockRejectedValueOnce('string throw')
    await expect(svc.ingestWebhook('inb-tg', SECRET, textUpdate())).resolves.toBeUndefined()
  })

  it('ignores updates it has nothing to do with', async () => {
    const { svc, inbound } = make()
    await svc.ingestWebhook('inb-tg', SECRET, { update_id: 3 })
    expect(inbound.resolve).not.toHaveBeenCalled()
  })

  describe('button taps', () => {
    const tap = (data: string | undefined, chatType = 'private'): TgUpdate => ({
      update_id: 2,
      callback_query: {
        id: 'cbq1',
        from: { id: 555, first_name: 'Ana' },
        ...(data !== undefined && { data }),
        message: { message_id: 11, chat: { id: 777, type: chatType } },
      },
    })

    it('answers the tap and ingests the option label with its id', async () => {
      const { svc, prisma, inbound } = make()
      const fetchMock = mockTelegram({ answerCallbackQuery: true })
      const longId = 'grp-'.repeat(30)
      prisma.message.findMany.mockResolvedValue([
        { contentAttributes: { not: 'a menu' } },
        {
          contentAttributes: {
            kind: 'buttons',
            body: 'Setor?',
            buttons: [
              { id: 'fin', label: 'Financeiro' },
              { id: longId, label: 'Cadastro' },
            ],
          },
        },
      ])
      await svc.ingestWebhook('inb-tg', SECRET, tap(callbackDataFor(longId)))
      expect(bodyOf(fetchMock, 'answerCallbackQuery')).toEqual({ callback_query_id: 'cbq1' })
      expect(inbound.ingest).toHaveBeenCalledWith({
        accountId: 'acc1',
        conversationId: 'cv1',
        content: 'Cadastro',
        contentType: 'TEXT',
        contentAttributes: { interactiveReplyId: longId },
        externalSourceId: 'tgcb:cbq1',
      })
    })

    it('falls back to the raw data when no menu matches', async () => {
      const { svc, inbound } = make()
      mockTelegram({ answerCallbackQuery: new Error('query is too old') })
      await svc.ingestWebhook('inb-tg', SECRET, tap('unknown'))
      expect(inbound.ingest.mock.calls[0]![0]).toMatchObject({
        content: 'unknown',
        contentAttributes: { interactiveReplyId: 'unknown' },
      })
    })

    it('skips taps without data, outside a private chat, repeated or from a blocked contact', async () => {
      process.env.COSMIKA_TELEGRAM_STUB = '1'
      const { svc, inbound } = make()
      await svc.ingestWebhook('inb-tg', SECRET, tap(undefined))
      await svc.ingestWebhook('inb-tg', SECRET, tap('x', 'group'))
      await svc.ingestWebhook('inb-tg', SECRET, {
        update_id: 4,
        callback_query: { id: 'c', from: { id: 1 }, data: 'x' },
      })
      expect(inbound.resolve).not.toHaveBeenCalled()
      inbound.alreadyIngested.mockResolvedValueOnce(true)
      await svc.ingestWebhook('inb-tg', SECRET, tap('x'))
      expect(inbound.resolve).not.toHaveBeenCalled()
      inbound.resolve.mockResolvedValueOnce({ kind: 'blocked' })
      await svc.ingestWebhook('inb-tg', SECRET, tap('x'))
      expect(inbound.ingest).not.toHaveBeenCalled()
    })
  })
})

describe('TelegramService outbound', () => {
  it('finds the chat id of a Telegram conversation only', async () => {
    const { svc, prisma } = make()
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'TELEGRAM' }, contactInbox: { sourceId: '777' } })
    await expect(svc.recipientForConversation('cv1')).resolves.toBe('777')
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'TELEGRAM' }, contactInbox: null })
    await expect(svc.recipientForConversation('cv1')).resolves.toBeNull()
    prisma.conversation.findUnique.mockResolvedValueOnce({ inbox: { channelType: 'WHATSAPP' }, contactInbox: { sourceId: '1' } })
    await expect(svc.recipientForConversation('cv1')).resolves.toBeNull()
    prisma.conversation.findUnique.mockResolvedValueOnce(null)
    await expect(svc.recipientForConversation('cv1')).resolves.toBeNull()
  })

  it('sends text, splitting past 4096 characters', async () => {
    const { svc } = make()
    const fetchMock = mockTelegram()
    await expect(svc.sendText('inb-tg', '777', 'oi')).resolves.toEqual({ externalId: '777:42' })
    await svc.sendText('inb-tg', '777', 'x'.repeat(5000))
    const texts = fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/sendMessage'))
      .map(([, init]) => JSON.parse(String(init!.body)).text.length)
    expect(texts).toEqual([2, 4096, 904])
  })

  it('draws a menu as an inline keyboard, one option per row', async () => {
    const { svc } = make()
    const fetchMock = mockTelegram()
    await svc.sendInteractive('inb-tg', '777', {
      kind: 'buttons',
      body: 'Setor?',
      buttons: [
        { id: 'fin', label: 'Financeiro' },
        { id: 'cad', label: 'Cadastro' },
      ],
    } as never)
    expect(bodyOf(fetchMock, 'sendMessage')).toEqual({
      chat_id: '777',
      text: 'Setor?',
      reply_markup: {
        inline_keyboard: [[{ text: 'Financeiro', callback_data: 'fin' }], [{ text: 'Cadastro', callback_data: 'cad' }]],
      },
    })
  })

  it('picks the Bot API method per media kind, voice notes included', async () => {
    const { svc } = make()
    const fetchMock = mockTelegram()
    await svc.sendMedia('inb-tg', '777', { kind: 'image', source: { link: 'https://x/a.png' }, caption: 'c' })
    await svc.sendMedia('inb-tg', '777', { kind: 'video', source: { link: 'https://x/a.mp4' } })
    await svc.sendMedia('inb-tg', '777', { kind: 'audio', source: { link: 'https://x/a.ogg' } })
    await svc.sendMedia('inb-tg', '777', { kind: 'audio', source: { link: 'https://x/a.mp3' } })
    await svc.sendMedia('inb-tg', '777', { kind: 'document', source: { link: 'https://x/a.pdf' } })
    const methods = fetchMock.mock.calls.map(([u]) => String(u).slice(String(u).lastIndexOf('/') + 1))
    expect(methods).toEqual(['sendPhoto', 'sendVideo', 'sendVoice', 'sendAudio', 'sendDocument'])
    expect(bodyOf(fetchMock, 'sendPhoto')).toEqual({ chat_id: '777', photo: 'https://x/a.png', caption: 'c' })
  })

  it('uploads bytes as multipart when there is no public link', async () => {
    const { svc } = make()
    const fetchMock = mockTelegram()
    await svc.sendMedia('inb-tg', '777', {
      kind: 'audio',
      source: { buffer: Buffer.from('x'), mimeType: 'audio/ogg', fileName: 'v.ogg' },
      caption: 'ouça',
    })
    await svc.sendMedia('inb-tg', '777', {
      kind: 'document',
      source: { buffer: Buffer.from('x'), mimeType: 'application/pdf', fileName: 'b.pdf' },
      fileName: 'Boleto.pdf',
    })
    const [voiceCall, docCall] = fetchMock.mock.calls
    expect(String(voiceCall![0])).toMatch(/sendVoice$/)
    const voiceForm = voiceCall![1]!.body as FormData
    expect(voiceForm.get('caption')).toBe('ouça')
    expect(voiceForm.get('chat_id')).toBe('777')
    const docForm = docCall![1]!.body as FormData
    expect((docForm.get('document') as File).name).toBe('Boleto.pdf')
    expect(docForm.get('caption')).toBeNull()
  })

  it('stub mode answers without calling Telegram', async () => {
    process.env.COSMIKA_TELEGRAM_STUB = '1'
    const { svc } = make()
    const fetchMock = mockTelegram()
    const r = await svc.sendText('inb-tg', '777', 'oi')
    expect(r.externalId).toMatch(/^stub-tg-/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to send through an inbox that is not Telegram', async () => {
    const { svc, prisma } = make()
    prisma.inbox.findUnique.mockResolvedValue(inbox({ channelType: 'WHATSAPP' }))
    await expect(svc.sendText('inb-tg', '777', 'oi')).rejects.toThrow(/Not Found/)
  })
})

describe('TelegramChannelAdapter', () => {
  it('delegates to the service and has no reply window', async () => {
    const telegram = {
      recipientForConversation: vi.fn().mockResolvedValue('777'),
      sendText: vi.fn().mockResolvedValue({ externalId: 'a' }),
      sendMedia: vi.fn().mockResolvedValue({ externalId: 'b' }),
      sendInteractive: vi.fn().mockResolvedValue({ externalId: 'c' }),
    }
    const inbound = { stampOutbound: vi.fn().mockResolvedValue(undefined) }
    const a = new TelegramChannelAdapter(telegram as never, inbound as never)
    await expect(a.recipientFor('cv1')).resolves.toBe('777')
    await expect(a.windowFor()).resolves.toBeNull()
    await expect(a.sendText('i', '777', 't')).resolves.toEqual({ externalId: 'a' })
    await expect(a.sendMedia('i', '777', { kind: 'image', source: { link: 'u' } })).resolves.toEqual({ externalId: 'b' })
    await expect(a.sendInteractive('i', '777', {} as never)).resolves.toEqual({ externalId: 'c' })
    await a.stampOutbound('m1', ['x'])
    expect(inbound.stampOutbound).toHaveBeenCalledWith('m1', ['x'])
    expect(a.captionFits()).toBe(true)
    expect(a.mediaMaxBytes('image')).toBe(10 * 1024 * 1024)
  })

  it('sends a photo only when Telegram will take it as one', () => {
    const a = new TelegramChannelAdapter({} as never, {} as never)
    expect(a.mediaKindFor('IMAGE', 'image/png', 1000)).toBe('image')
    expect(a.mediaKindFor('IMAGE', 'image/svg+xml')).toBe('document')
    expect(a.mediaKindFor('IMAGE', 'image/jpeg', 20 * 1024 * 1024)).toBe('document')
    expect(a.mediaKindFor('IMAGE', null)).toBe('document')
    expect(a.mediaKindFor('VIDEO', 'video/mp4; codecs=avc1')).toBe('video')
    expect(a.mediaKindFor('VIDEO', 'video/quicktime')).toBe('document')
    expect(a.mediaKindFor('AUDIO', 'audio/ogg')).toBe('audio')
    expect(a.mediaKindFor('FILE', 'application/pdf')).toBe('document')
  })
})
