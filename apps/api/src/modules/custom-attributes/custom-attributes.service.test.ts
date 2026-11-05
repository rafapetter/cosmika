import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CustomAttributesService } from './custom-attributes.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    customAttribute: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const makeService = (p: Prisma) => new CustomAttributesService(p as never)

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { ...ADMIN, role: 'AGENT' }

describe('CustomAttributesService.list', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('403 inactive member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, isActive: false })
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('lists ALL targets when none specified', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.customAttribute.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1')
    expect(prisma.customAttribute.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: [{ target: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    })
  })

  it('filters by target when provided', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.customAttribute.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', 'CONTACT')
    expect(prisma.customAttribute.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', target: 'CONTACT' },
      orderBy: expect.any(Array),
    })
  })
})

describe('CustomAttributesService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 for AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        target: 'CONTACT',
        key: 'k',
        label: 'L',
        type: 'TEXT',
      } as never),
    ).rejects.toThrow('Administrator role required')
  })

  it('409 when key already exists for (target, accountId)', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ id: 'existing' })
    await expect(
      makeService(prisma).create('u1', 'acc1', {
        target: 'CONTACT',
        key: 'tier',
        label: 'L',
        type: 'TEXT',
      } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('creates with defaults (options=null, position=0)', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue(null)
    prisma.customAttribute.create.mockResolvedValue({ id: 'ca1' })
    await makeService(prisma).create('u1', 'acc1', {
      target: 'CONTACT',
      key: 'tier',
      label: 'Tier',
      type: 'TEXT',
    } as never)
    expect(prisma.customAttribute.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        target: 'CONTACT',
        key: 'tier',
        label: 'Tier',
        type: 'TEXT',
        options: null,
        position: 0,
      },
    })
  })

  it('passes options + position when provided', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue(null)
    prisma.customAttribute.create.mockResolvedValue({})
    await makeService(prisma).create('u1', 'acc1', {
      target: 'CONVERSATION',
      key: 'severity',
      label: 'Severity',
      type: 'SELECT',
      options: [{ value: 'low', label: 'Low' }],
      position: 3,
    } as never)
    const arg = prisma.customAttribute.create.mock.calls[0]![0]
    expect(arg.data.options).toEqual([{ value: 'low', label: 'Low' }])
    expect(arg.data.position).toBe(3)
  })
})

describe('CustomAttributesService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'ca1', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'ca1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'ca1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('applies partial label', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', { label: 'New label' } as never)
    expect(prisma.customAttribute.update).toHaveBeenCalledWith({
      where: { id: 'ca1' },
      data: { label: 'New label' },
    })
  })

  it('applies type change', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', { type: 'NUMBER' } as never)
    expect(prisma.customAttribute.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { type: 'NUMBER' } }),
    )
  })

  it('applies options=null (clearing select options)', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', { options: null } as never)
    const arg = prisma.customAttribute.update.mock.calls[0]![0]
    expect(arg.data.options).toBeNull()
  })

  it('applies options array', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', {
      options: [{ value: 'a', label: 'A' }],
    } as never)
    const arg = prisma.customAttribute.update.mock.calls[0]![0]
    expect(arg.data.options).toEqual([{ value: 'a', label: 'A' }])
  })

  it('applies position', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', { position: 5 } as never)
    expect(prisma.customAttribute.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { position: 5 } }),
    )
  })

  it('sends empty data when no fields provided', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.customAttribute.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'ca1', {} as never)
    expect(prisma.customAttribute.update).toHaveBeenCalledWith({ where: { id: 'ca1' }, data: {} })
  })
})

describe('CustomAttributesService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).remove('u1', 'acc1', 'ca1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'ca1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'ca1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes when authorised', async () => {
    prisma.customAttribute.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(prisma).remove('u1', 'acc1', 'ca1')
    expect(prisma.customAttribute.delete).toHaveBeenCalledWith({ where: { id: 'ca1' } })
  })
})

describe('CustomAttributesService.toDTO', () => {
  const svc = new CustomAttributesService(makePrisma() as never)

  it('maps every field + emits options as the typed array shape', () => {
    expect(
      svc.toDTO({
        id: 'ca1',
        accountId: 'acc1',
        target: 'CONTACT',
        key: 'tier',
        label: 'Tier',
        type: 'SELECT',
        options: [{ value: 'gold', label: 'Gold' }],
        position: 2,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'ca1',
      accountId: 'acc1',
      target: 'CONTACT',
      key: 'tier',
      label: 'Tier',
      type: 'SELECT',
      options: [{ value: 'gold', label: 'Gold' }],
      position: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('emits options:null when row.options is null', () => {
    const dto = svc.toDTO({
      id: 'ca1',
      accountId: 'acc1',
      target: 'CONTACT',
      key: 'k',
      label: 'L',
      type: 'TEXT',
      options: null,
      position: 0,
      createdAt: new Date(),
    } as never)
    expect(dto.options).toBeNull()
  })
})
