import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WhatsappTemplatesService } from './whatsapp-templates.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    inbox: { findUnique: vi.fn() },
    whatsappTemplate: { findMany: vi.fn(), upsert: vi.fn() },
  }
}

function makeWhatsapp() {
  return { fetchTemplatesFromMeta: vi.fn() }
}

function makeService(prisma: ReturnType<typeof makePrisma>, wa = makeWhatsapp()) {
  return {
    svc: new WhatsappTemplatesService(prisma as never, wa as never),
    prisma,
    wa,
  }
}

const ADMIN = { id: 'm1', userId: 'u1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { id: 'm2', userId: 'u1', role: 'AGENT', isActive: true }
const WA_INBOX = { id: 'inb1', accountId: 'acc1', channelType: 'WHATSAPP' }

// ─── parse ──────────────────────────────────────────────────────────

describe('WhatsappTemplatesService.parse', () => {
  it('extracts BODY text + counts the highest {{n}} placeholder', () => {
    const r = WhatsappTemplatesService.parse({
      name: 't',
      language: 'pt_BR',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [
        { type: 'HEADER', text: 'hi' },
        { type: 'BODY', text: 'Olá {{1}}, em {{2}}.' },
      ],
    })
    expect(r.body).toBe('Olá {{1}}, em {{2}}.')
    expect(r.variableCount).toBe(2)
    expect(r.components).toHaveLength(2)
  })

  it('uses the highest index when placeholders have gaps', () => {
    const r = WhatsappTemplatesService.parse({
      name: 't',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: '{{1}} then {{3}}' }],
    })
    expect(r.variableCount).toBe(3)
  })

  it('keeps the running max when a later placeholder index is smaller', () => {
    const r = WhatsappTemplatesService.parse({
      name: 't',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: '{{2}} then {{1}}' }],
    })
    expect(r.variableCount).toBe(2)
  })

  it('returns empty body + 0 vars when there is no BODY component', () => {
    const r = WhatsappTemplatesService.parse({
      name: 't',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      components: undefined,
    })
    expect(r.body).toBe('')
    expect(r.variableCount).toBe(0)
    expect(r.components).toEqual([])
  })
})

// ─── list ───────────────────────────────────────────────────────────

describe('WhatsappTemplatesService.list', () => {
  let prisma: ReturnType<typeof makePrisma>
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 when caller is not an active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.list('u1', 'acc1', 'inb1')).rejects.toThrow(ForbiddenException)
  })

  it('404 when inbox is missing or cross-account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue({ ...WA_INBOX, accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(svc.list('u1', 'acc1', 'inb1')).rejects.toThrow(NotFoundException)
  })

  it('returns templates for the inbox (any active role)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    prisma.whatsappTemplate.findMany.mockResolvedValue([{ id: 't1' }])
    const { svc } = makeService(prisma)
    const out = await svc.list('u1', 'acc1', 'inb1')
    expect(out).toEqual([{ id: 't1' }])
  })
})

// ─── sync ───────────────────────────────────────────────────────────

describe('WhatsappTemplatesService.sync', () => {
  let prisma: ReturnType<typeof makePrisma>
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 for non-mutator (AGENT) role', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.sync('u1', 'acc1', 'inb1')).rejects.toThrow(
      /Administrator or Supervisor/,
    )
  })

  it('upserts each fetched template and returns the count', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.inbox.findUnique.mockResolvedValue(WA_INBOX)
    const wa = makeWhatsapp()
    wa.fetchTemplatesFromMeta.mockResolvedValue([
      {
        name: 'appt',
        language: 'pt_BR',
        category: 'UTILITY',
        status: 'APPROVED',
        id: 'ext-1',
        components: [{ type: 'BODY', text: 'Olá {{1}}' }],
      },
      {
        name: 'hello',
        language: 'en_US',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Hi' }],
      },
    ])
    const { svc } = makeService(prisma, wa)
    const out = await svc.sync('u1', 'acc1', 'inb1')
    expect(out).toEqual({ synced: 2 })
    expect(prisma.whatsappTemplate.upsert).toHaveBeenCalledTimes(2)
    const firstCall = prisma.whatsappTemplate.upsert.mock.calls[0]![0]
    expect(firstCall.where).toEqual({
      inboxId_name_language: { inboxId: 'inb1', name: 'appt', language: 'pt_BR' },
    })
    expect(firstCall.create.variableCount).toBe(1)
    expect(firstCall.create.externalId).toBe('ext-1')
    // template with no external id → null
    const secondCall = prisma.whatsappTemplate.upsert.mock.calls[1]![0]
    expect(secondCall.create.externalId).toBeNull()
  })
})

// ─── toDTO ──────────────────────────────────────────────────────────

describe('WhatsappTemplatesService.toDTO', () => {
  it('serializes a template row with an ISO syncedAt', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toDTO({
      id: 't1',
      inboxId: 'inb1',
      name: 'appt',
      language: 'pt_BR',
      category: 'UTILITY',
      status: 'APPROVED',
      body: 'Olá {{1}}',
      variableCount: 1,
      components: [],
      externalId: 'ext-1',
      syncedAt: new Date('2026-06-24T00:00:00Z'),
      createdAt: new Date('2026-06-24T00:00:00Z'),
      updatedAt: new Date('2026-06-24T00:00:00Z'),
    } as never)
    expect(dto).toEqual({
      id: 't1',
      inboxId: 'inb1',
      name: 'appt',
      language: 'pt_BR',
      category: 'UTILITY',
      status: 'APPROVED',
      body: 'Olá {{1}}',
      variableCount: 1,
      syncedAt: '2026-06-24T00:00:00.000Z',
    })
  })
})
