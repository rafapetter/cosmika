// The WhatsApp credentials route: the request body is filtered to the allowed
// fields with blanks meaning "keep", the audit entry names fields but never
// values, and the response is the redacted DTO.
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { UpdateWhatsappCredentialsInput } from '@cosmika/shared'
import { describe, expect, it, vi } from 'vitest'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'

import { InboxesController } from './inboxes.controller'
import { InboxesService } from './inboxes.service'

const AUTH = { user: { id: 'u1' } } as never
const NOW = new Date('2026-09-17T00:00:00.000Z')

const STORED = {
  phoneNumberId: 'phone-old',
  businessAccountId: 'waba-old',
  accessToken: 'STORED-ACCESS-TOKEN',
  appSecret: 'STORED-APP-SECRET',
  webhookVerifyToken: 'STORED-VERIFY',
}

function waInbox(channelConfig: Record<string, unknown>) {
  return {
    id: 'inb1',
    accountId: 'acc1',
    name: 'WhatsApp',
    channelType: 'WHATSAPP',
    channelConfig,
    greetingEnabled: false,
    greetingMessage: null,
    outOfOfficeMessage: null,
    aiAutoreplyMode: 'DRAFT',
    autoResolveMinutes: 10080,
    agentBotId: null,
    csatEnabled: false,
    slaPolicyId: null,
    defaultFlowId: null,
    flowMode: 'OFF',
    deviationPolicy: 'answer_and_return',
    maxDeviations: 3,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function make(role = 'ADMINISTRATOR') {
  const prisma = {
    accountMember: {
      findUnique: vi.fn().mockResolvedValue({ role, isActive: true, accountId: 'acc1' }),
    },
    inbox: {
      findUnique: vi.fn().mockResolvedValue(waInbox({ ...STORED })),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(async ({ data }) => waInbox(data.channelConfig)),
    },
  }
  const audit = { record: vi.fn().mockResolvedValue({}) }
  const service = new InboxesService(prisma as never)
  const ctrl = new InboxesController(service, audit as never)
  return { ctrl, prisma, audit }
}

const pipe = new ZodValidationPipe(UpdateWhatsappCredentialsInput)

describe('UpdateWhatsappCredentialsInput', () => {
  it('turns blank and whitespace-only fields into "keep the stored value"', () => {
    expect(
      pipe.transform({
        phoneNumberId: '',
        businessAccountId: '   ',
        accessToken: '',
        appSecret: '  NEW-APP-SECRET-123 \n',
      }),
    ).toEqual({ appSecret: 'NEW-APP-SECRET-123' })
  })

  it('accepts exactly the fields a WhatsApp channel takes at creation', () => {
    const body = {
      phoneNumberId: 'p',
      businessAccountId: 'b',
      accessToken: 'ACCESS-TOKEN-123',
      appSecret: 'APP-SECRET-123',
      webhookVerifyToken: 'v',
    }
    expect(pipe.transform(body)).toEqual(body)
  })

  // Failures are checked on the schema itself: under vitest the shared
  // package's zod and this app's zod load as two module instances, so the
  // pipe's `instanceof ZodError` cannot match here (it does in the real app).
  it('rejects any other field instead of passing it into the channel config', () => {
    const res = UpdateWhatsappCredentialsInput.safeParse({
      accessToken: 'ACCESS-TOKEN-123',
      widgetHash: 'x',
    })
    expect(res.success).toBe(false)
    expect(res.error!.issues[0]!.code).toBe('unrecognized_keys')
  })

  it('rejects a too-short secret without echoing it back', () => {
    const res = UpdateWhatsappCredentialsInput.safeParse({ accessToken: 'short-tok' })
    expect(res.success).toBe(false)
    const issues = res.error!.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    expect(issues[0]!.path).toBe('accessToken')
    expect(JSON.stringify(issues)).not.toContain('short-tok')
  })
})

describe('InboxesController.updateWhatsappCredentials', () => {
  it('audits the names of the changed fields and never their values', async () => {
    const { ctrl, audit } = make()
    const body = pipe.transform({
      phoneNumberId: '',
      accessToken: 'NEW-ACCESS-TOKEN-123',
      webhookVerifyToken: 'NEW-VERIFY',
    })
    await ctrl.updateWhatsappCredentials(AUTH, 'acc1', 'inb1', body)

    expect(audit.record).toHaveBeenCalledTimes(1)
    expect(audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'inbox.whatsapp_credentials.update',
      target: 'inbox:inb1',
      metadata: { fields: ['accessToken', 'webhookVerifyToken'] },
    })
    const entry = JSON.stringify(audit.record.mock.calls[0])
    for (const value of [
      'NEW-ACCESS-TOKEN-123',
      'NEW-VERIFY',
      'STORED-ACCESS-TOKEN',
      'STORED-APP-SECRET',
      'STORED-VERIFY',
    ]) {
      expect(entry).not.toContain(value)
    }
  })

  it('returns the redacted DTO: no secret, old or new, in the response', async () => {
    const { ctrl } = make()
    const dto = await ctrl.updateWhatsappCredentials(
      AUTH,
      'acc1',
      'inb1',
      pipe.transform({ appSecret: 'NEW-APP-SECRET-123' }),
    )
    const json = JSON.stringify(dto)
    for (const value of ['NEW-APP-SECRET-123', 'STORED-ACCESS-TOKEN', 'STORED-VERIFY']) {
      expect(json).not.toContain(value)
    }
    expect(dto.channelConfig).toEqual({ phoneNumberId: 'phone-old', businessAccountId: 'waba-old' })
    expect(dto.whatsappSecrets).toEqual({ accessToken: true, appSecret: true, webhookVerifyToken: true })
  })

  it('keeps the stored secrets when the form sends them blank', async () => {
    const { ctrl, prisma, audit } = make()
    await ctrl.updateWhatsappCredentials(
      AUTH,
      'acc1',
      'inb1',
      pipe.transform({
        phoneNumberId: 'phone-new',
        businessAccountId: 'waba-old',
        accessToken: '',
        appSecret: '',
        webhookVerifyToken: '',
      }),
    )
    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig).toEqual({
      ...STORED,
      phoneNumberId: 'phone-new',
    })
    expect(audit.record.mock.calls[0]![0].metadata).toEqual({ fields: ['phoneNumberId'] })
  })

  it('writes no audit entry when nothing changed', async () => {
    const { ctrl, prisma, audit } = make()
    await ctrl.updateWhatsappCredentials(AUTH, 'acc1', 'inb1', pipe.transform({ accessToken: '' }))
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('refuses a supervisor on the server and records nothing', async () => {
    const { ctrl, prisma, audit } = make('SUPERVISOR')
    await expect(
      ctrl.updateWhatsappCredentials(
        AUTH,
        'acc1',
        'inb1',
        pipe.transform({ accessToken: 'NEW-ACCESS-TOKEN-123' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('does not let a supervisor route credentials through the general inbox update', async () => {
    const { ctrl, prisma, audit } = make('SUPERVISOR')
    await expect(
      ctrl.update(AUTH, 'acc1', 'inb1', { channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123' } }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })
})

// PATCH :id accepts channelConfig on a WhatsApp channel again. It must be the
// dedicated route wearing a different URL: same role, same allow-list, same
// blank-means-keep, same audit entry.
describe('InboxesController.update: WhatsApp credentials through the general route', () => {
  it('lets an administrator replace a secret and audits the field names only', async () => {
    const { ctrl, prisma, audit } = make()
    const dto = await ctrl.update(AUTH, 'acc1', 'inb1', {
      channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123', webhookVerifyToken: 'NEW-VERIFY' },
    })

    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig).toEqual({
      ...STORED,
      accessToken: 'NEW-ACCESS-TOKEN-123',
      webhookVerifyToken: 'NEW-VERIFY',
    })
    expect(audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'inbox.whatsapp_credentials.update',
      target: 'inbox:inb1',
      metadata: { fields: ['accessToken', 'webhookVerifyToken'] },
    })
    const trace = JSON.stringify([audit.record.mock.calls, dto])
    for (const value of [
      'NEW-ACCESS-TOKEN-123',
      'NEW-VERIFY',
      'STORED-ACCESS-TOKEN',
      'STORED-APP-SECRET',
      'STORED-VERIFY',
    ]) {
      expect(trace).not.toContain(value)
    }
  })

  it('treats a blank field as "keep", so a form that posts every field wipes nothing', async () => {
    const { ctrl, prisma, audit } = make()
    await ctrl.update(AUTH, 'acc1', 'inb1', {
      channelConfig: {
        phoneNumberId: 'phone-new',
        accessToken: '',
        appSecret: '   ',
        webhookVerifyToken: '',
      },
    })
    expect(prisma.inbox.update.mock.calls[0]![0].data.channelConfig).toEqual({
      ...STORED,
      phoneNumberId: 'phone-new',
    })
    expect(audit.record.mock.calls[0]![0].metadata).toEqual({ fields: ['phoneNumberId'] })
  })

  it('needs no administrator, and writes no audit entry, when every field is blank', async () => {
    const { ctrl, prisma, audit } = make('SUPERVISOR')
    await ctrl.update(AUTH, 'acc1', 'inb1', { channelConfig: { accessToken: '' } })
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('refuses an unknown field instead of writing it into the channel config', async () => {
    const { ctrl, prisma } = make()
    await expect(
      ctrl.update(AUTH, 'acc1', 'inb1', {
        channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123', widgetHash: 'evil' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('writes the rest of the PATCH in the same statement as the credential', async () => {
    const { ctrl, prisma } = make()
    await ctrl.update(AUTH, 'acc1', 'inb1', {
      name: 'Renamed',
      channelConfig: { accessToken: 'NEW-ACCESS-TOKEN-123' },
    })
    expect(prisma.inbox.update).toHaveBeenCalledTimes(1)
    const data = prisma.inbox.update.mock.calls[0]![0].data
    expect(data.name).toBe('Renamed')
    expect(data.channelConfig).toEqual({ ...STORED, accessToken: 'NEW-ACCESS-TOKEN-123' })
  })
})
