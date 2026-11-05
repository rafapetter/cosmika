import { createHmac } from 'node:crypto'

import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppWebhookPayload, WhatsappAppWebhookService } from './whatsapp-app-webhook.service'

const APP_SECRET = 'app-secret-value-123'
// The signup flag is deliberately off: the app callback must work without it.
const ENV = {
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: '0',
  META_APP_SECRET: APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: 'app-verify-token',
}

const ES_INBOX = {
  id: 'inb_es',
  accountId: 'acc1',
  channelConfig: { businessAccountId: '1111', onboarding: 'embedded_signup' },
}
const COEX_INBOX = {
  id: 'inb_coex',
  accountId: 'acc2',
  channelConfig: { businessAccountId: '1111', onboarding: 'coexistence' },
}
// Same WABA, but still on the customer's own Meta app: never touched here.
const LEGACY_INBOX = { id: 'inb_legacy', accountId: 'acc3', channelConfig: { businessAccountId: '1111' } }

function sign(raw: Buffer, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}

function setup(rows: unknown[] = [ES_INBOX, LEGACY_INBOX]) {
  const prisma = {
    inbox: { findMany: vi.fn().mockResolvedValue(rows) },
    whatsappTemplate: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  const audit = { record: vi.fn().mockResolvedValue({}) }
  const whatsapp = { ingestWebhook: vi.fn().mockResolvedValue({ processed: 1 }) }
  const svc = new WhatsappAppWebhookService(prisma as never, audit as never, whatsapp as never)
  return { svc, prisma, audit, whatsapp }
}

function deliver(svc: WhatsappAppWebhookService, payload: AppWebhookPayload, signature?: string) {
  const raw = Buffer.from(JSON.stringify(payload))
  return svc.ingest(raw, signature ?? sign(raw), payload)
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
})
afterEach(() => vi.unstubAllEnvs())

describe('verifyChallenge', () => {
  it('echoes the challenge for our app verify token', () => {
    const { svc } = setup()
    expect(svc.verifyChallenge('subscribe', 'app-verify-token', '42')).toBe('42')
  })

  it.each([
    ['wrong token', 'subscribe', 'other', '42'],
    ['same length wrong token', 'subscribe', 'app-verify-tokeX', '42'],
    ['wrong mode', 'unsubscribe', 'app-verify-token', '42'],
    ['no token', 'subscribe', undefined, '42'],
    ['no challenge', 'subscribe', 'app-verify-token', undefined],
  ])('%s is a 403', (_l, mode, token, challenge) => {
    const { svc } = setup()
    expect(() => svc.verifyChallenge(mode, token, challenge)).toThrow(ForbiddenException)
  })

  it.each(['META_WEBHOOK_VERIFY_TOKEN', 'META_APP_SECRET'])('404 while %s is not configured', (missing) => {
    vi.stubEnv(missing, '')
    const { svc } = setup()
    expect(() => svc.verifyChallenge('subscribe', 'app-verify-token', '42')).toThrow(NotFoundException)
  })
})

describe('ingest: signature', () => {
  const payload: AppWebhookPayload = { object: 'whatsapp_business_account', entry: [] }

  it('404 while the app secret is not configured', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    const { svc } = setup()
    await expect(deliver(svc, payload)).rejects.toThrow(NotFoundException)
  })

  it('refuses a missing or wrong X-Hub-Signature-256', async () => {
    const { svc } = setup()
    const raw = Buffer.from(JSON.stringify(payload))
    await expect(svc.ingest(raw, undefined, payload)).rejects.toThrow(ForbiddenException)
    await expect(svc.ingest(raw, sign(raw, 'another-secret'), payload)).rejects.toThrow(ForbiddenException)
    await expect(svc.ingest(raw, 'sha256=short', payload)).rejects.toThrow(ForbiddenException)
  })

  it('acknowledges another object without processing it', async () => {
    const { svc, prisma } = setup()
    await expect(deliver(svc, { object: 'page', entry: [] })).resolves.toEqual({ processed: 0, ignored: 1 })
    expect(prisma.inbox.findMany).not.toHaveBeenCalled()
  })

  it('copes with a payload that has no entries', async () => {
    const { svc } = setup()
    await expect(deliver(svc, { object: 'whatsapp_business_account' })).resolves.toEqual({
      processed: 0,
      ignored: 0,
    })
  })
})

describe('ingest: routing by WABA', () => {
  it('records account_update on every Embedded Signup inbox of the WABA, never on a legacy one', async () => {
    const { svc, prisma, audit } = setup([ES_INBOX, COEX_INBOX, LEGACY_INBOX])
    const value = { event: 'ACCOUNT_VIOLATION', violation_info: { violation_type: 'SPAM' } }
    const out = await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [{ field: 'account_update', value }] }],
    })
    expect(out).toEqual({ processed: 1, ignored: 0 })
    expect(prisma.inbox.findMany.mock.calls[0]![0].where).toEqual({
      channelType: 'WHATSAPP',
      channelConfig: { path: ['businessAccountId'], equals: '1111' },
    })
    expect(audit.record).toHaveBeenCalledTimes(2)
    expect(audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: null,
      action: 'whatsapp.waba_event',
      target: 'inbox:inb_es',
      metadata: { field: 'account_update', wabaId: '1111', event: 'ACCOUNT_VIOLATION', value },
    })
    expect(audit.record.mock.calls.map((c) => c[0].target)).not.toContain('inbox:inb_legacy')
  })

  it('updates the template status, then records the review', async () => {
    const { svc, prisma, audit } = setup()
    await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1111',
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'REJECTED',
                message_template_name: 'boas_vindas',
                message_template_language: 'pt_BR',
                reason: 'INVALID_FORMAT',
              },
            },
          ],
        },
      ],
    })
    expect(prisma.whatsappTemplate.updateMany).toHaveBeenCalledWith({
      where: { inboxId: { in: ['inb_es'] }, name: 'boas_vindas', language: 'pt_BR' },
      data: { status: 'REJECTED', syncedAt: expect.any(Date) },
    })
    expect(audit.record.mock.calls[0]![0].metadata.event).toBe('REJECTED')
  })

  it('a template update missing its name, language or status changes no row', async () => {
    const { svc, prisma, audit } = setup()
    await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [{ field: 'message_template_status_update' }] }],
    })
    expect(prisma.whatsappTemplate.updateMany).not.toHaveBeenCalled()
    expect(audit.record.mock.calls[0]![0].metadata).toEqual({
      field: 'message_template_status_update',
      wabaId: '1111',
      event: null,
      value: {},
    })
  })

  it('a very large event value is not copied into the audit log', async () => {
    const { svc, audit } = setup()
    await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [{ field: 'account_alerts', value: { blob: 'x'.repeat(5000) } }] }],
    })
    expect(audit.record.mock.calls[0]![0].metadata).toEqual({
      field: 'account_alerts',
      wabaId: '1111',
      event: null,
      truncated: true,
    })
  })

  it('ignores a WABA with no Embedded Signup inbox, an entry without id and a change without field', async () => {
    const { svc, prisma, audit } = setup([LEGACY_INBOX])
    const out = await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [
        { id: '1111', changes: [{ field: 'account_update', value: {} }] },
        { changes: [{ field: 'account_update' }] },
        { id: '2222' },
      ],
    })
    expect(out).toEqual({ processed: 0, ignored: 2 })
    expect(prisma.inbox.findMany).toHaveBeenCalledTimes(2)
    expect(audit.record).not.toHaveBeenCalled()

    const withInbox = setup([ES_INBOX])
    await expect(
      deliver(withInbox.svc, { object: 'whatsapp_business_account', entry: [{ id: '1111', changes: [{}] }] }),
    ).resolves.toEqual({ processed: 0, ignored: 1 })
  })

  it('messages that missed the override are handed to each inbox, scoped to that change', async () => {
    const { svc, whatsapp, audit } = setup([ES_INBOX, COEX_INBOX])
    const change = { field: 'messages', value: { metadata: { phone_number_id: '2222' }, messages: [] } }
    const payload: AppWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [change] }],
    }
    const raw = Buffer.from(JSON.stringify(payload))
    const out = await svc.ingest(raw, sign(raw), payload)
    expect(out).toEqual({ processed: 2, ignored: 0 })
    expect(whatsapp.ingestWebhook).toHaveBeenCalledWith('inb_es', raw, sign(raw), {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [change] }],
    })
    expect(whatsapp.ingestWebhook.mock.calls[1]![0]).toBe('inb_coex')
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('one inbox refusing the fallback does not fail the delivery for the others', async () => {
    const { svc, whatsapp } = setup([ES_INBOX, COEX_INBOX])
    whatsapp.ingestWebhook.mockRejectedValueOnce(new ForbiddenException()).mockRejectedValueOnce('odd')
    const out = await deliver(svc, {
      object: 'whatsapp_business_account',
      entry: [{ id: '1111', changes: [{ field: 'messages', value: {} }] }],
    })
    expect(out).toEqual({ processed: 0, ignored: 2 })
  })
})
