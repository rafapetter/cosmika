import { describe, expect, it, vi } from 'vitest'
import { ForbiddenException } from '@nestjs/common'

import {
  SupportTicketsService,
  parsePriority,
  ticketFilterToWhere,
} from './support-tickets.service'

function makePrisma() {
  return {
    supportTicket: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    supportTicketEvent: { create: vi.fn() },
    accountMember: { findUnique: vi.fn() },
  }
}
const member = (role = 'AGENT', isActive = true) => ({ role, isActive })
type Prisma = ReturnType<typeof makePrisma>
const svc = (p: Prisma) => new SupportTicketsService(p as never)

const BASE = {
  accountId: 'acc1',
  conversationId: 'cv1',
  contactId: 'ct1',
  subject: 'Erro no relatório',
  description: 'O download não completa',
  category: 'relatorios',
  priority: 'alta',
}

describe('parsePriority', () => {
  it('maps the PT-BR and English words the flows actually use', () => {
    expect(parsePriority('alta')).toBe('HIGH')
    expect(parsePriority(' URGENTE ')).toBe('URGENT')
    expect(parsePriority('Low')).toBe('LOW')
    expect(parsePriority('média')).toBe('NORMAL')
  })

  it('falls back to NORMAL rather than losing the ticket', () => {
    expect(parsePriority('gravíssimo')).toBe('NORMAL')
    expect(parsePriority(undefined)).toBe('NORMAL')
    expect(parsePriority(3)).toBe('NORMAL')
  })
})

describe('SupportTicketsService.create', () => {
  it('stores the interpolated fields with a mapped priority', async () => {
    const p = makePrisma()
    p.supportTicket.create.mockResolvedValue({ id: 't1', number: 42 })
    await svc(p).create(BASE)
    expect(p.supportTicket.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        conversationId: 'cv1',
        contactId: 'ct1',
        subject: 'Erro no relatório',
        description: 'O download não completa',
        category: 'relatorios',
        priority: 'HIGH',
      },
    })
  })

  it('falls back to the description, then to a label, when subject is empty', async () => {
    const p = makePrisma()
    p.supportTicket.create.mockResolvedValue({ id: 't1', number: 1 })
    await svc(p).create({ ...BASE, subject: '   ' })
    expect(p.supportTicket.create.mock.calls[0][0].data.subject).toBe('O download não completa')

    p.supportTicket.create.mockClear()
    await svc(p).create({ ...BASE, subject: null, description: null })
    expect(p.supportTicket.create.mock.calls[0][0].data.subject).toBe('Chamado sem assunto')
  })

  it('truncates an overlong subject and nulls a blank category', async () => {
    const p = makePrisma()
    p.supportTicket.create.mockResolvedValue({ id: 't1', number: 1 })
    await svc(p).create({ ...BASE, subject: 'x'.repeat(300), category: '  ' })
    const data = p.supportTicket.create.mock.calls[0][0].data
    expect(data.subject).toHaveLength(200)
    expect(data.category).toBeNull()
  })
})

describe('SupportTicketsService.appendUpdate', () => {
  it('appends an event and moves the ticket to PENDING', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue({ id: 't1' })
    p.supportTicket.update.mockResolvedValue({ id: 't1', status: 'PENDING' })
    const out = await svc(p).appendUpdate('acc1', 'cv1', ' cliente respondeu ')
    expect(p.supportTicketEvent.create).toHaveBeenCalledWith({
      data: { ticketId: 't1', body: 'cliente respondeu' },
    })
    expect(out).toEqual({ id: 't1', status: 'PENDING' })
    // Only open work is updatable — a closed ticket must not silently reopen.
    expect(p.supportTicket.findFirst.mock.calls[0][0].where.status).toEqual({
      in: ['OPEN', 'PENDING'],
    })
  })

  it('returns null when there is no conversation, no text, or no open ticket', async () => {
    const p = makePrisma()
    expect(await svc(p).appendUpdate('acc1', null, 'oi')).toBeNull()
    expect(await svc(p).appendUpdate('acc1', 'cv1', '   ')).toBeNull()
    p.supportTicket.findFirst.mockResolvedValue(null)
    expect(await svc(p).appendUpdate('acc1', 'cv1', 'oi')).toBeNull()
    expect(p.supportTicketEvent.create).not.toHaveBeenCalled()
  })
})

describe('SupportTicketsService.list', () => {
  it('scopes to the conversation by default', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([{ id: 't1' }])
    const out = await svc(p).list('acc1', {
      conversationId: 'cv1', contactId: 'ct1', byContact: false,
    })
    expect(out).toEqual([{ id: 't1' }])
    expect(p.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', conversationId: 'cv1',
    })
  })

  it('scopes to the contact when asked', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).list('acc1', { conversationId: 'cv1', contactId: 'ct1', byContact: true })
    expect(p.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', contactId: 'ct1',
    })
  })

  it('returns nothing rather than every ticket when the scope key is missing', async () => {
    const p = makePrisma()
    expect(
      await svc(p).list('acc1', { conversationId: null, contactId: 'ct1', byContact: false }),
    ).toEqual([])
    expect(
      await svc(p).list('acc1', { conversationId: 'cv1', contactId: null, byContact: true }),
    ).toEqual([])
    expect(p.supportTicket.findMany).not.toHaveBeenCalled()
  })
})

// ---------- account-scoped read + triage ----------
// Ticket ids come from the client, so account scoping is the boundary that
// stops one workspace reading or moving another's tickets.

describe('SupportTicketsService account access', () => {
  it('lets any active member read', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(member('AGENT'))
    await expect(svc(p).assertMember('u1', 'acc1')).resolves.toBeUndefined()
  })

  it('refuses a non-member and a deactivated member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc(p).assertMember('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    p.accountMember.findUnique.mockResolvedValue(member('ADMINISTRATOR', false))
    await expect(svc(p).assertMember('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('only lets an admin or supervisor change a ticket', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(member('ADMINISTRATOR'))
    await expect(svc(p).assertMutator('u1', 'acc1')).resolves.toBeUndefined()
    p.accountMember.findUnique.mockResolvedValue(member('SUPERVISOR'))
    await expect(svc(p).assertMutator('u1', 'acc1')).resolves.toBeUndefined()
    p.accountMember.findUnique.mockResolvedValue(member('AGENT'))
    await expect(svc(p).assertMutator('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    // Not a member at all, and a deactivated admin.
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc(p).assertMutator('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    p.accountMember.findUnique.mockResolvedValue(member('ADMINISTRATOR', false))
    await expect(svc(p).assertMutator('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })
})

describe('SupportTicketsService.listForAccount', () => {
  it('scopes to the account and returns newest first', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).listForAccount('acc1')
    const arg = p.supportTicket.findMany.mock.calls[0][0]
    expect(arg.where).toEqual({ accountId: 'acc1' })
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
  })

  it('filters by status when asked', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).listForAccount('acc1', { status: 'OPEN' })
    expect(p.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      accountId: 'acc1', status: 'OPEN',
    })
  })

  it('sorts by the requested column in the plain orderBy form', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).listForAccount('acc1', { sort: 'priority', dir: 'asc' })
    // Plain form pinned on purpose: `{ sort, nulls }` 500s on non-nullable
    // columns, and every ticket sort column is non-nullable.
    expect(p.supportTicket.findMany.mock.calls[0][0].orderBy).toEqual({
      priority: 'asc',
    })
  })

  it('searches subject and description case-insensitively', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).listForAccount('acc1', { q: 'boleto' })
    expect(p.supportTicket.findMany.mock.calls[0][0].where.OR).toEqual([
      { subject: { contains: 'boleto', mode: 'insensitive' } },
      { description: { contains: 'boleto', mode: 'insensitive' } },
    ])
  })

  it('ANDs composable filters into the where clause', async () => {
    const p = makePrisma()
    p.supportTicket.findMany.mockResolvedValue([])
    await svc(p).listForAccount('acc1', {
      filters: [
        { field: 'status', op: 'is', value: 'OPEN' },
        { field: 'category', op: 'isEmpty' },
      ],
    })
    expect(p.supportTicket.findMany.mock.calls[0][0].where.AND).toEqual([
      { status: 'OPEN' },
      { category: null },
    ])
  })
})

describe('ticketFilterToWhere', () => {
  it('maps enum fields to plain equality (no insensitive mode)', () => {
    expect(ticketFilterToWhere({ field: 'priority', op: 'is', value: 'URGENT' }))
      .toEqual({ priority: 'URGENT' })
    expect(ticketFilterToWhere({ field: 'status', op: 'isNot', value: 'CLOSED' }))
      .toEqual({ NOT: { status: 'CLOSED' } })
  })

  it('maps text equality case-insensitively', () => {
    expect(ticketFilterToWhere({ field: 'category', op: 'is', value: 'nf' }))
      .toEqual({ category: { equals: 'nf', mode: 'insensitive' } })
    expect(ticketFilterToWhere({ field: 'category', op: 'isNot', value: 'nf' }))
      .toEqual({ NOT: { category: { equals: 'nf', mode: 'insensitive' } } })
  })

  it('maps text ops like the contacts grid', () => {
    expect(ticketFilterToWhere({ field: 'subject', op: 'contains', value: 'nf' }))
      .toEqual({ subject: { contains: 'nf', mode: 'insensitive' } })
    expect(ticketFilterToWhere({ field: 'category', op: 'notContains', value: 'x' }))
      .toEqual({ NOT: { category: { contains: 'x', mode: 'insensitive' } } })
    expect(ticketFilterToWhere({ field: 'category', op: 'isNotEmpty' }))
      .toEqual({ category: { not: null } })
  })
})

describe('SupportTicketsService.getForAccount', () => {
  it('scopes the lookup to the account and pulls the update trail in order', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue({ id: 'tk1', events: [] })
    await svc(p).getForAccount('acc1', 'tk1')
    const arg = p.supportTicket.findFirst.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'tk1', accountId: 'acc1' })
    expect(arg.include.events).toEqual({ orderBy: { createdAt: 'asc' } })
  })

  it('returns null for a ticket that belongs to another account', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue(null)
    expect(await svc(p).getForAccount('acc1', 'tk-elsewhere')).toBeNull()
  })
})

describe('SupportTicketsService.updateForAccount', () => {
  it('refuses a ticket from another account without touching it', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue(null)
    expect(await svc(p).updateForAccount('acc1', 'tk-elsewhere', { status: 'CLOSED' }))
      .toBeNull()
    expect(p.supportTicket.update).not.toHaveBeenCalled()
  })

  it('applies only the fields supplied', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue({ id: 'tk1' })
    p.supportTicket.update.mockResolvedValue({ id: 'tk1', status: 'CLOSED' })
    await svc(p).updateForAccount('acc1', 'tk1', { status: 'CLOSED' })
    expect(p.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'tk1' }, data: { status: 'CLOSED' },
    })
    p.supportTicket.update.mockClear()
    await svc(p).updateForAccount('acc1', 'tk1', {})
    expect(p.supportTicket.update).toHaveBeenCalledWith({ where: { id: 'tk1' }, data: {} })

    // Priority alone, without touching status.
    p.supportTicket.update.mockClear()
    await svc(p).updateForAccount('acc1', 'tk1', { priority: 'URGENT' })
    expect(p.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'tk1' }, data: { priority: 'URGENT' },
    })
  })

  it('sets, trims, and clears category — absent leaves it untouched', async () => {
    const p = makePrisma()
    p.supportTicket.findFirst.mockResolvedValue({ id: 'tk1' })
    p.supportTicket.update.mockResolvedValue({ id: 'tk1' })
    await svc(p).updateForAccount('acc1', 'tk1', { category: ' Financeiro ' })
    expect(p.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'tk1' }, data: { category: 'Financeiro' },
    })
    // Empty string and null both clear; absent must not appear in data.
    p.supportTicket.update.mockClear()
    await svc(p).updateForAccount('acc1', 'tk1', { category: '' })
    expect(p.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'tk1' }, data: { category: null },
    })
    p.supportTicket.update.mockClear()
    await svc(p).updateForAccount('acc1', 'tk1', { status: 'CLOSED' })
    expect(p.supportTicket.update).toHaveBeenCalledWith({
      where: { id: 'tk1' }, data: { status: 'CLOSED' },
    })
  })
})

describe('SupportTicketsService.toDTO', () => {
  it('serialises dates and flattens the contact name', () => {
    const now = new Date('2026-08-06T12:00:00Z')
    const dto = svc(makePrisma()).toDTO({
      id: 'tk1', accountId: 'acc1', number: 42, subject: 's', description: 'd',
      category: null, priority: 'HIGH', status: 'OPEN', conversationId: 'cv1',
      contactId: 'ct1', createdAt: now, updatedAt: now,
      contact: { name: 'Ana' },
    } as never)
    expect(dto.number).toBe(42)
    expect(dto.contactName).toBe('Ana')
    expect(dto.createdAt).toBe(now.toISOString())
  })

  it('tolerates a ticket whose contact is gone', () => {
    const now = new Date()
    const dto = svc(makePrisma()).toDTO({
      id: 'tk1', accountId: 'acc1', number: 1, subject: 's', description: 'd',
      category: null, priority: 'NORMAL', status: 'OPEN', conversationId: null,
      contactId: null, createdAt: now, updatedAt: now,
    } as never)
    expect(dto.contactName).toBeNull()
  })
})
