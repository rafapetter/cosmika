import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SavedViewsService } from './saved-views.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    savedView: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const makeService = (p: Prisma) => new SavedViewsService(p as never)

const MEMBER = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'AGENT', isActive: true }

describe('SavedViewsService.list', () => {
  it('403 non-member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('403 inactive member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ ...MEMBER, isActive: false })
    await expect(makeService(p).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('scopes to (accountId, userId) — saved views are per-user', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(MEMBER)
    p.savedView.findMany.mockResolvedValue([])
    await makeService(p).list('u1', 'acc1')
    expect(p.savedView.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', userId: 'u1', entity: 'CONVERSATIONS' },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })
  })
})

describe('SavedViewsService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
  })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).create('u1', 'acc1', { name: 'X', filters: {} } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('persists with defaults (icon=null, position=0)', async () => {
    prisma.savedView.create.mockResolvedValue({ id: 'sv1' })
    await makeService(prisma).create('u1', 'acc1', {
      name: 'My open',
      filters: { status: 'OPEN' },
    } as never)
    expect(prisma.savedView.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        userId: 'u1',
        name: 'My open',
        icon: null,
          entity: 'CONVERSATIONS',
        filters: { status: 'OPEN' },
        position: 0,
      },
    })
  })

  it('respects icon + position when provided', async () => {
    prisma.savedView.create.mockResolvedValue({})
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Urgent',
      filters: { priority: 'URGENT' },
      icon: '🔥',
      position: 3,
    } as never)
    const arg = prisma.savedView.create.mock.calls[0]![0]
    expect(arg.data.icon).toBe('🔥')
    expect(arg.data.position).toBe(3)
  })
})

describe('SavedViewsService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
  })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sv1', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.savedView.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sv1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR account', async () => {
    prisma.savedView.findUnique.mockResolvedValue({
      accountId: 'other-acc',
      userId: 'u1',
    })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sv1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 when view belongs to another user (per-user privacy)', async () => {
    prisma.savedView.findUnique.mockResolvedValue({
      accountId: 'acc1',
      userId: 'other-user',
    })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sv1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('applies partial fields independently', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    prisma.savedView.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'sv1', { name: 'Renamed' } as never)
    expect(prisma.savedView.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { name: 'Renamed' },
    })
  })

  it('icon can be set to null explicitly', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    prisma.savedView.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'sv1', { icon: null } as never)
    expect(prisma.savedView.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { icon: null },
    })
  })

  it('replaces filters JSON wholesale', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    prisma.savedView.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'sv1', {
      filters: { status: 'PENDING' },
    } as never)
    expect(prisma.savedView.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { filters: { status: 'PENDING' } },
    })
  })

  it('applies position', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    prisma.savedView.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'sv1', { position: 7 } as never)
    expect(prisma.savedView.update).toHaveBeenCalledWith({
      where: { id: 'sv1' },
      data: { position: 7 },
    })
  })

  it('sends empty data when nothing to update', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    prisma.savedView.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'sv1', {} as never)
    expect(prisma.savedView.update).toHaveBeenCalledWith({ where: { id: 'sv1' }, data: {} })
  })
})

describe('SavedViewsService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
  })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'sv1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.savedView.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'sv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR account', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'other', userId: 'u1' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'sv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR user (per-user privacy)', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'other-user' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'sv1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes when authorised', async () => {
    prisma.savedView.findUnique.mockResolvedValue({ accountId: 'acc1', userId: 'u1' })
    await makeService(prisma).remove('u1', 'acc1', 'sv1')
    expect(prisma.savedView.delete).toHaveBeenCalledWith({ where: { id: 'sv1' } })
  })
})

describe('SavedViewsService.toDTO', () => {
  const svc = new SavedViewsService(makePrisma() as never)

  it('maps every field with ISO timestamps', () => {
    expect(
      svc.toDTO({
        id: 'sv1',
        accountId: 'acc1',
        userId: 'u1',
        name: 'My open',
        icon: '📥',
        entity: 'CONVERSATIONS',
        filters: { status: 'OPEN' },
        position: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'sv1',
      accountId: 'acc1',
      userId: 'u1',
      name: 'My open',
      icon: '📥',
      // toEqual ignores undefined properties, so without this line a DTO
      // that silently drops `entity` still passes. expect the literal.
      entity: 'CONVERSATIONS',
      filters: { status: 'OPEN' },
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('defaults filters to {} when row.filters is null', () => {
    const dto = svc.toDTO({
      id: 'sv1',
      accountId: 'acc1',
      userId: 'u1',
      name: 'X',
      icon: null,
      filters: null,
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    expect(dto.filters).toEqual({})
  })
})


describe('SavedViewsService — entity scoping (contact views)', () => {
  it('lists only the requested entity, so contact views never leak into the conversations sidebar', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.savedView.findMany.mockResolvedValue([])
    const svc = new SavedViewsService(prisma as never)
    await svc.list('u1', 'acc1', 'CONTACTS')
    expect(prisma.savedView.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'acc1', userId: 'u1', entity: 'CONTACTS' },
      }),
    )
  })

  it('stores the entity on create', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.savedView.create.mockResolvedValue({} as never)
    const svc = new SavedViewsService(prisma as never)
    await svc.create('u1', 'acc1', {
      name: 'Sem e-mail',
      entity: 'CONTACTS',
      filters: {
        filters: [{ field: 'email', op: 'isEmpty' }],
        sort: 'createdAt',
        dir: 'desc',
        hiddenColumns: [],
      },
    } as never)
    expect(prisma.savedView.create.mock.calls[0]![0].data).toMatchObject({
      entity: 'CONTACTS',
    })
  })

  it('rejects an update whose filters do not fit the STORED entity', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.savedView.findUnique.mockResolvedValue({
      id: 'v1',
      accountId: 'acc1',
      userId: 'u1',
      entity: 'CONTACTS',
    } as never)
    const svc = new SavedViewsService(prisma as never)
    await expect(
      svc.update('u1', 'acc1', 'v1', {
        filters: { status: 'OPEN' }, // a conversations payload
      } as never),
    ).rejects.toThrow(/invalid filters/)
    expect(prisma.savedView.update).not.toHaveBeenCalled()
  })
})
