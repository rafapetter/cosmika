import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decryptSecretsIn, isEncryptedSecret } from '../../common/secret-crypto'

import {
  isEmbeddedSignupConfig,
  WhatsappEmbeddedSignupService,
} from './whatsapp-embedded-signup.service'

const SECRET_FIELDS = ['accessToken', 'appSecret', 'webhookVerifyToken', 'registrationPin']

const ENV = {
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: '1',
  WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS: 'acc0,acc1',
  META_APP_ID: '100000000000001',
  META_APP_SECRET: 'app-secret-value-123',
  META_ES_CONFIG_ID: '999000111',
  API_PUBLIC_URL: 'https://app.cosmobots.io/api/',
  META_GRAPH_BASE_URL: 'https://graph.test',
  META_GRAPH_API_VERSION: 'v25.0',
  COSMIKA_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
}

const ADMIN = { accountId: 'acc1', userId: 'u1', role: 'ADMINISTRATOR', isActive: true }
const SUPERVISOR = { ...ADMIN, role: 'SUPERVISOR' }

const INPUT = {
  code: 'exchangeable-code-xyz',
  event: 'FINISH' as const,
  wabaId: '1111',
  phoneNumberId: '2222',
  businessId: '3333',
}

type Route = { status?: number; body?: unknown; throws?: Error }
type Call = { method: string; path: string; url: URL; headers: Record<string, string>; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** A fake Graph API: `routes['POST 1111/subscribed_apps']` answers that call. */
function mockGraph(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    'GET oauth/access_token': { body: { access_token: 'business-token-abc' } },
    'GET debug_token': {
      body: {
        data: {
          app_id: ENV.META_APP_ID,
          is_valid: true,
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['1111'] },
            { scope: 'whatsapp_business_messaging', target_ids: ['1111'] },
          ],
        },
      },
    },
    'GET 1111/phone_numbers': {
      body: { data: [{ id: '2222', display_phone_number: '+55 11 4000-0000', verified_name: 'Clinica Exemplo' }] },
    },
    'POST 1111/subscribed_apps': { body: { success: true } },
    'POST 2222': { body: { success: true } },
    'POST 2222/register': { body: { success: true } },
    'DELETE 1111/subscribed_apps': { body: { success: true } },
    ...overrides,
  }
  const calls: Call[] = []
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/v25.0/', '')
    calls.push({
      method,
      path,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const route = routes[`${method} ${path}`]
    if (!route) return json(404, { error: { message: 'no route' } })
    if (route.throws) throw route.throws
    return json(route.status ?? 200, route.body ?? {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn().mockResolvedValue(ADMIN) },
    inbox: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'inb_new', ...data })),
      delete: vi.fn().mockResolvedValue({}),
    },
  }
}

function makeService(prisma = makePrisma()) {
  const audit = { record: vi.fn().mockResolvedValue({}) }
  return { svc: new WhatsappEmbeddedSignupService(prisma as never, audit as never), prisma, audit }
}

function storedConfig(prisma: ReturnType<typeof makePrisma>) {
  return prisma.inbox.create.mock.calls[0]![0].data.channelConfig as Record<string, unknown>
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('isEmbeddedSignupConfig', () => {
  it('is true only for configs our onboarding wrote', () => {
    expect(isEmbeddedSignupConfig({ onboarding: 'embedded_signup' })).toBe(true)
    expect(isEmbeddedSignupConfig({ onboarding: 'coexistence' })).toBe(true)
    expect(isEmbeddedSignupConfig({ onboarding: 'manual' })).toBe(false)
    expect(isEmbeddedSignupConfig({ phoneNumberId: '1' })).toBe(false)
    expect(isEmbeddedSignupConfig(null)).toBe(false)
    expect(isEmbeddedSignupConfig([])).toBe(false)
    expect(isEmbeddedSignupConfig('x')).toBe(false)
  })
})

describe('publicConfig', () => {
  it('hands the screen the app id, config id and SDK version when on', async () => {
    const { svc } = makeService()
    await expect(svc.publicConfig('u1', 'acc1')).resolves.toEqual({
      enabled: true,
      appId: ENV.META_APP_ID,
      configId: ENV.META_ES_CONFIG_ID,
      graphApiVersion: 'v25.0',
    })
  })

  it('says disabled, and nothing else, when the flag is off', async () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', '')
    const { svc } = makeService()
    await expect(svc.publicConfig('u1', 'acc1')).resolves.toEqual({ enabled: false })
  })

  it('says disabled to an account outside the allowlist, and to everyone when it is empty', async () => {
    const { svc } = makeService()
    await expect(svc.publicConfig('u1', 'acc9')).resolves.toEqual({ enabled: false })
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', '')
    await expect(svc.publicConfig('u1', 'acc1')).resolves.toEqual({ enabled: false })
  })

  it('"*" shows it to every account', async () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', '*')
    const { svc } = makeService()
    await expect(svc.publicConfig('u1', 'acc9')).resolves.toMatchObject({ enabled: true })
  })

  it('refuses someone who is not an active member', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    const { svc } = makeService(prisma)
    await expect(svc.publicConfig('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.publicConfig('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })
})

describe('complete: happy path', () => {
  it('exchanges the code, creates the inbox, routes the WABA to it and registers the number', async () => {
    const { calls } = mockGraph()
    const { svc, prisma, audit } = makeService()

    const inbox = await svc.complete('u1', 'acc1', INPUT)
    expect(inbox.id).toBe('inb_new')

    // 1. code exchange with our app credentials, before anything else at Meta.
    expect(calls[0]!.path).toBe('oauth/access_token')
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      client_id: ENV.META_APP_ID,
      client_secret: ENV.META_APP_SECRET,
      code: INPUT.code,
    })
    // 2. the token is checked with an app token, the number with the business token.
    expect(calls[1]!.url.searchParams.get('access_token')).toBe(`${ENV.META_APP_ID}|${ENV.META_APP_SECRET}`)
    expect(calls[2]!.headers.authorization).toBe('Bearer business-token-abc')

    // 3. inbox stored with encrypted secrets and the onboarding marker.
    const create = prisma.inbox.create.mock.calls[0]![0].data
    expect(create).toMatchObject({ accountId: 'acc1', name: 'Clinica Exemplo', channelType: 'WHATSAPP' })
    const stored = storedConfig(prisma)
    for (const f of SECRET_FIELDS) expect(isEncryptedSecret(stored[f])).toBe(true)
    const plain = decryptSecretsIn(stored, SECRET_FIELDS)
    expect(plain).toMatchObject({
      phoneNumberId: '2222',
      businessAccountId: '1111',
      accessToken: 'business-token-abc',
      appSecret: ENV.META_APP_SECRET,
      onboarding: 'embedded_signup',
      businessId: '3333',
      displayPhoneNumber: '+55 11 4000-0000',
    })
    expect(plain.registrationPin).toMatch(/^\d{6}$/)
    expect(plain.webhookVerifyToken).toMatch(/^[0-9a-f]{48}$/)

    // 4. WABA override to this inbox's own URL with its verify token.
    const sub = calls.find((c) => c.path === '1111/subscribed_apps')!
    expect(sub.method).toBe('POST')
    expect(sub.headers.authorization).toBe('Bearer business-token-abc')
    expect(sub.body).toEqual({
      override_callback_uri: 'https://app.cosmobots.io/api/webhooks/whatsapp/inb_new',
      verify_token: plain.webhookVerifyToken,
    })
    // 5. register with the PIN we stored.
    const reg = calls.find((c) => c.path === '2222/register')!
    expect(reg.body).toEqual({ messaging_product: 'whatsapp', pin: plain.registrationPin })
    expect(calls.indexOf(sub)).toBeLessThan(calls.indexOf(reg))

    expect(prisma.inbox.delete).not.toHaveBeenCalled()
    expect(audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'inbox.whatsapp_embedded_signup',
      target: 'inbox:inb_new',
      metadata: { wabaId: '1111', phoneNumberId: '2222', onboarding: 'embedded_signup', webhookRouting: 'waba' },
    })
  })

  it('coexistence keeps the number on the Business app: no register, no PIN', async () => {
    const { calls } = mockGraph()
    const { svc, prisma, audit } = makeService()
    await svc.complete('u1', 'acc1', { ...INPUT, event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' })
    expect(calls.some((c) => c.path.endsWith('/register'))).toBe(false)
    const stored = storedConfig(prisma)
    expect(stored.registrationPin).toBeUndefined()
    expect(stored.onboarding).toBe('coexistence')
    expect(audit.record.mock.calls[0]![0].metadata.onboarding).toBe('coexistence')
  })

  it('a second number of an onboarded WABA gets a phone-level override instead', async () => {
    const { calls } = mockGraph()
    const prisma = makePrisma()
    prisma.inbox.findMany.mockResolvedValue([
      { id: 'legacy', channelConfig: { businessAccountId: '1111' } },
      { id: 'first', channelConfig: { businessAccountId: '1111', onboarding: 'embedded_signup' } },
    ])
    const { svc, audit } = makeService(prisma)
    await svc.complete('u1', 'acc1', INPUT)
    expect(calls.some((c) => c.path === '1111/subscribed_apps')).toBe(false)
    const phone = calls.find((c) => c.method === 'POST' && c.path === '2222')!
    expect(phone.body).toEqual({
      webhook_configuration: {
        override_callback_uri: 'https://app.cosmobots.io/api/webhooks/whatsapp/inb_new',
        verify_token: expect.stringMatching(/^[0-9a-f]{48}$/),
      },
    })
    expect(audit.record.mock.calls[0]![0].metadata.webhookRouting).toBe('phone')
  })

  it('a WABA shared only with channels on their own Meta app still gets the WABA override', async () => {
    const { calls } = mockGraph()
    const prisma = makePrisma()
    prisma.inbox.findMany.mockResolvedValue([{ id: 'legacy', channelConfig: { businessAccountId: '1111' } }])
    const { svc } = makeService(prisma)
    await svc.complete('u1', 'acc1', INPUT)
    expect(calls.some((c) => c.path === '1111/subscribed_apps')).toBe(true)
  })

  it('names the channel from the input, then the verified name, then the number', async () => {
    const run = async (input: object, phone: object) => {
      mockGraph({ 'GET 1111/phone_numbers': { body: { data: [{ id: '2222', ...phone }] } } })
      const { svc, prisma } = makeService()
      await svc.complete('u1', 'acc1', { ...INPUT, ...input })
      return prisma.inbox.create.mock.calls[0]![0].data
    }
    expect((await run({ name: 'Recepção' }, { verified_name: 'X' })).name).toBe('Recepção')
    const byNumber = await run({}, { display_phone_number: '+55 11 1' })
    expect(byNumber.name).toBe('+55 11 1')
    const bare = await run({ businessId: undefined }, {})
    expect(bare.name).toBe('WhatsApp')
    expect(bare.channelConfig.displayPhoneNumber).toBeUndefined()
    expect(bare.channelConfig.businessId).toBeUndefined()
  })

  it('accepts a management scope that is not narrowed to particular assets', async () => {
    mockGraph({
      'GET debug_token': {
        body: { data: { app_id: ENV.META_APP_ID, is_valid: true, granular_scopes: [{ scope: 'whatsapp_business_management' }] } },
      },
    })
    const { svc } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).resolves.toMatchObject({ id: 'inb_new' })
  })
})

describe('complete: refusals before Meta is called', () => {
  it('404 while the flag is off or the configuration is incomplete', async () => {
    const { fetchMock } = mockGraph()
    vi.stubEnv('META_ES_CONFIG_ID', '')
    const { svc } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(NotFoundException)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404 for an account outside the allowlist, before Meta is called', async () => {
    const { fetchMock } = mockGraph()
    const { svc, prisma } = makeService()
    await expect(svc.complete('u1', 'acc9', INPUT)).rejects.toThrow(NotFoundException)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })

  it('only administrators connect a number', async () => {
    const { fetchMock } = mockGraph()
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(SUPERVISOR)
    const { svc } = makeService(prisma)
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(ForbiddenException)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('FINISH_ONLY_WABA without a number cannot become a channel', async () => {
    const { fetchMock } = mockGraph()
    const { svc } = makeService()
    await expect(
      svc.complete('u1', 'acc1', { ...INPUT, event: 'FINISH_ONLY_WABA', phoneNumberId: undefined }),
    ).rejects.toMatchObject({ response: { code: 'whatsapp_es_phone_required' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a number that already is a channel anywhere is refused, so existing customers are never re-onboarded', async () => {
    const { fetchMock } = mockGraph()
    const prisma = makePrisma()
    prisma.inbox.findFirst.mockResolvedValue({ id: 'existing' })
    const { svc } = makeService(prisma)
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(ConflictException)
    expect(prisma.inbox.findFirst.mock.calls[0]![0].where).toEqual({
      channelType: 'WHATSAPP',
      channelConfig: { path: ['phoneNumberId'], equals: '2222' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('complete: Meta says no', () => {
  it('an expired or reused code is a 400 with a code the screen translates', async () => {
    mockGraph({ 'GET oauth/access_token': { status: 400, body: { error: { message: 'code expired', code: 100 } } } })
    const { svc, prisma } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_code_rejected' },
    })
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })

  it('an answer without a token is a rejected code too', async () => {
    mockGraph({ 'GET oauth/access_token': { body: {} } })
    const { svc } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(BadRequestException)
  })

  it.each([
    ['debug_token fails', { 'GET debug_token': { status: 500, body: {} } }],
    ['token invalid', { 'GET debug_token': { body: { data: { app_id: ENV.META_APP_ID, is_valid: false } } } }],
    ['token from another app', { 'GET debug_token': { body: { data: { app_id: '1', is_valid: true } } } }],
    ['no debug data', { 'GET debug_token': { body: {} } }],
    [
      'no management scope',
      { 'GET debug_token': { body: { data: { app_id: ENV.META_APP_ID, is_valid: true, granular_scopes: [] } } } },
    ],
    [
      'no granular scopes at all',
      { 'GET debug_token': { body: { data: { app_id: ENV.META_APP_ID, is_valid: true } } } },
    ],
    [
      'WABA not among the shared assets',
      {
        'GET debug_token': {
          body: {
            data: {
              app_id: ENV.META_APP_ID,
              is_valid: true,
              granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['9999'] }],
            },
          },
        },
      },
    ],
    ['phone list fails', { 'GET 1111/phone_numbers': { status: 403, body: { error: { code: 200 } } } }],
    ['number not on the WABA', { 'GET 1111/phone_numbers': { body: { data: [{ id: '7777' }] } } }],
    ['empty phone list', { 'GET 1111/phone_numbers': { body: {} } }],
  ])('%s: the ids the browser sent are not trusted', async (_label, routes) => {
    mockGraph(routes as Record<string, Route>)
    const { svc, prisma } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_waba_not_granted' },
    })
    expect(prisma.inbox.create).not.toHaveBeenCalled()
  })

  it('a refused subscription deletes the inbox again and never registers', async () => {
    const { calls } = mockGraph({
      'POST 1111/subscribed_apps': { status: 400, body: { error: { message: 'nope', code: 100, error_subcode: 33, fbtrace_id: 'T' } } },
    })
    const { svc, prisma, audit } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_subscribe_failed' },
    })
    expect(prisma.inbox.delete).toHaveBeenCalledWith({ where: { id: 'inb_new' } })
    expect(calls.some((c) => c.path.endsWith('/register'))).toBe(false)
    // Nothing was routed, so there is nothing to undo at Meta.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('success=false counts as a refusal', async () => {
    mockGraph({ 'POST 1111/subscribed_apps': { body: { success: false } } })
    const { svc } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(BadGatewayException)
  })

  it('a refused register removes the WABA routing and the inbox', async () => {
    const { calls } = mockGraph({ 'POST 2222/register': { status: 400, body: { error: { code: 133005 } } } })
    const { svc, prisma } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_register_failed' },
    })
    expect(prisma.inbox.delete).toHaveBeenCalled()
    const undo = calls.find((c) => c.method === 'DELETE')!
    expect(undo.path).toBe('1111/subscribed_apps')
    expect(undo.headers.authorization).toBe('Bearer business-token-abc')
  })

  it('a refused register on a phone-level route clears that override', async () => {
    const { calls } = mockGraph({ 'POST 2222/register': { status: 400, body: {} } })
    const prisma = makePrisma()
    prisma.inbox.findMany.mockResolvedValue([{ id: 'first', channelConfig: { onboarding: 'embedded_signup' } }])
    const { svc } = makeService(prisma)
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(BadGatewayException)
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '2222')
    expect(posts.at(-1)!.body).toEqual({ webhook_configuration: { override_callback_uri: '' } })
  })

  it('a failing undo is logged, never thrown over the real error', async () => {
    mockGraph({
      'POST 2222/register': { status: 400, body: {} },
      'DELETE 1111/subscribed_apps': { status: 500, body: {} },
    })
    const prisma = makePrisma()
    prisma.inbox.delete.mockRejectedValue(new Error('db down'))
    const { svc } = makeService(prisma)
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_register_failed' },
    })
  })

  it('a failing phone-override undo is only logged, and a non-Error delete failure too', async () => {
    mockGraph({
      'POST 2222/register': { status: 400, body: {} },
    })
    const prisma = makePrisma()
    prisma.inbox.findMany.mockResolvedValue([{ id: 'first', channelConfig: { onboarding: 'coexistence' } }])
    prisma.inbox.delete.mockRejectedValue('boom')
    const { svc } = makeService(prisma)
    // The register route fails; the clear goes to the same POST 2222 route,
    // which we make fail as well by failing every POST to it after the first.
    let posts = 0
    const real = globalThis.fetch
    vi.stubGlobal('fetch', async (u: URL, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(String(u)).pathname.endsWith('/2222') && ++posts > 1) {
        return json(500, {})
      }
      return real(u, init)
    })
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toThrow(BadGatewayException)
  })

  it('a callback URL over Meta\'s 200-character limit fails before any routing', async () => {
    vi.stubEnv('API_PUBLIC_URL', `https://example.com/${'a'.repeat(200)}`)
    const { calls } = mockGraph()
    const { svc, prisma } = makeService()
    await expect(svc.complete('u1', 'acc1', INPUT)).rejects.toMatchObject({
      response: { code: 'whatsapp_es_subscribe_failed' },
    })
    expect(prisma.inbox.delete).toHaveBeenCalled()
    expect(calls.some((c) => c.path === '1111/subscribed_apps')).toBe(false)
  })
})
