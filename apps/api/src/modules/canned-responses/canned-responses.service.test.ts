import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CannedResponsesService } from './canned-responses.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    cannedResponse: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const makeService = (p: Prisma) => new CannedResponsesService(p as never)

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }

describe('CannedResponsesService.list', () => {
  it('403 non-member', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('returns rows sorted by shortcode for any active member', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.cannedResponse.findMany.mockResolvedValue([{ shortcode: 'hi' }])
    expect(await makeService(prisma).list('u1', 'acc1')).toEqual([{ shortcode: 'hi' }])
    expect(prisma.cannedResponse.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { shortcode: 'asc' },
    })
  })
})

describe('CannedResponsesService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', { shortcode: 'HI', content: 'Hello' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('SUPERVISOR can create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    prisma.cannedResponse.create.mockResolvedValue({ id: 'cr1' })
    await makeService(prisma).create('u1', 'acc1', { shortcode: 'HI', content: 'Hello' })
    expect(prisma.cannedResponse.create).toHaveBeenCalled()
  })

  it('lowercases shortcode before persisting', async () => {
    prisma.cannedResponse.create.mockResolvedValue({ id: 'cr1' })
    await makeService(prisma).create('u1', 'acc1', { shortcode: 'HELLO', content: 'Hi' })
    expect(prisma.cannedResponse.create).toHaveBeenCalledWith({
      data: { accountId: 'acc1', shortcode: 'hello', content: 'Hi' },
    })
  })

  it('409 on P2002 (shortcode collision)', async () => {
    prisma.cannedResponse.create.mockRejectedValue({ code: 'P2002' })
    await expect(
      makeService(prisma).create('u1', 'acc1', { shortcode: 'dup', content: 'x' }),
    ).rejects.toThrow(ConflictException)
  })

  it('rethrows non-P2002 errors', async () => {
    prisma.cannedResponse.create.mockRejectedValue(new Error('other'))
    await expect(
      makeService(prisma).create('u1', 'acc1', { shortcode: 'x', content: 'y' }),
    ).rejects.toThrow('other')
  })

  it('rethrows non-prisma error shapes', async () => {
    prisma.cannedResponse.create.mockRejectedValue('a string')
    await expect(
      makeService(prisma).create('u1', 'acc1', { shortcode: 'x', content: 'y' }),
    ).rejects.toBe('a string')
  })
})

describe('CannedResponsesService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'cr1', { content: 'x' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'cr1', { content: 'x' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'cr1', { content: 'x' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('applies partial shortcode (lowercased)', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.cannedResponse.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'cr1', { shortcode: 'NEW' })
    expect(prisma.cannedResponse.update).toHaveBeenCalledWith({
      where: { id: 'cr1' },
      data: { shortcode: 'new' },
    })
  })

  it('applies partial content', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.cannedResponse.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'cr1', { content: 'updated' })
    expect(prisma.cannedResponse.update).toHaveBeenCalledWith({
      where: { id: 'cr1' },
      data: { content: 'updated' },
    })
  })

  it('sends empty data when nothing to change', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.cannedResponse.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'cr1', {})
    expect(prisma.cannedResponse.update).toHaveBeenCalledWith({
      where: { id: 'cr1' },
      data: {},
    })
  })

  it('409 on P2002 collision', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.cannedResponse.update.mockRejectedValue({ code: 'P2002' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'cr1', { shortcode: 'dup' }),
    ).rejects.toThrow(ConflictException)
  })

  it('rethrows non-P2002 errors on update', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.cannedResponse.update.mockRejectedValue(new Error('weird'))
    await expect(
      makeService(prisma).update('u1', 'acc1', 'cr1', { content: 'x' }),
    ).rejects.toThrow('weird')
  })
})

describe('CannedResponsesService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).remove('u1', 'acc1', 'cr1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'cr1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'cr1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes when authorised', async () => {
    prisma.cannedResponse.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(prisma).remove('u1', 'acc1', 'cr1')
    expect(prisma.cannedResponse.delete).toHaveBeenCalledWith({ where: { id: 'cr1' } })
  })
})

describe('CannedResponsesService.toDTO', () => {
  it('maps every field with ISO timestamps', () => {
    const svc = new CannedResponsesService(makePrisma() as never)
    expect(
      svc.toDTO({
        id: 'cr1',
        accountId: 'acc1',
        shortcode: 'hi',
        content: 'Hello',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'cr1',
      accountId: 'acc1',
      shortcode: 'hi',
      content: 'Hello',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })
})
