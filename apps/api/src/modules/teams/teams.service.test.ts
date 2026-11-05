import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TeamsService } from './teams.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    team: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    teamMember: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    conversation: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>
function makeService(prisma: Prisma) {
  prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(prisma))
  return new TeamsService(prisma as never)
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }
const TEAM = { id: 'tm1', accountId: 'acc1', name: 'Suporte', description: null }

describe('TeamsService.list', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403s non-members', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('returns teams with member counts for any active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.team.findMany.mockResolvedValue([{ ...TEAM, _count: { members: 3 } }])
    const out = await makeService(prisma).list('u1', 'acc1')
    expect(out).toHaveLength(1)
    expect(out[0]._count.members).toBe(3)
  })
})

describe('TeamsService.getWithMembers', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('404 unknown team', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.team.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).getWithMembers('u1', 'acc1', 'tm1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (other-account team)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.team.findUnique.mockResolvedValue({ ...TEAM, accountId: 'other-acc', members: [] })
    await expect(makeService(prisma).getWithMembers('u1', 'acc1', 'tm1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns the team with members for an authorised member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const result = { ...TEAM, members: [{ id: 'tmm1', userId: 'u2', user: {} }] }
    prisma.team.findUnique.mockResolvedValue(result)
    expect(await makeService(prisma).getWithMembers('u1', 'acc1', 'tm1')).toBe(result)
  })
})

describe('TeamsService.create', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 for AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', { name: 'X' } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('SUPERVISOR can create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    prisma.team.create.mockResolvedValue(TEAM)
    await makeService(prisma).create('u1', 'acc1', { name: 'Suporte' } as never)
    expect(prisma.team.create).toHaveBeenCalledWith({
      data: { accountId: 'acc1', name: 'Suporte', description: null },
    })
  })

  it('persists description when provided', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.team.create.mockResolvedValue(TEAM)
    await makeService(prisma).create('u1', 'acc1', {
      name: 'Suporte',
      description: 'Help desk team',
    } as never)
    expect(prisma.team.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: 'Help desk team' }),
    })
  })
})

describe('TeamsService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'tm1', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.team.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'tm1', { name: 'X' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'other-acc' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'tm1', { name: 'X' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('applies partial fields', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.team.update.mockResolvedValue({ ...TEAM, _count: { members: 0 } })
    await makeService(prisma).update('u1', 'acc1', 'tm1', { name: 'New' } as never)
    const arg = prisma.team.update.mock.calls[0]![0]
    expect(arg.data).toEqual({ name: 'New' })
  })

  it('applies description=null to clear', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.team.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'tm1', { description: null } as never)
    const arg = prisma.team.update.mock.calls[0]![0]
    expect(arg.data).toEqual({ description: null })
  })

  it('sends empty data when nothing to update', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.team.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'tm1', {} as never)
    const arg = prisma.team.update.mock.calls[0]![0]
    expect(arg.data).toEqual({})
  })
})

describe('TeamsService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).remove('u1', 'acc1', 'tm1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.team.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'tm1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'other-acc' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'tm1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('nulls conversation.teamId and deletes the team in a transaction', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.conversation.updateMany.mockResolvedValue({ count: 5 })
    prisma.team.delete.mockResolvedValue({})
    await makeService(prisma).remove('u1', 'acc1', 'tm1')
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { teamId: 'tm1' },
      data: { teamId: null },
    })
    expect(prisma.team.delete).toHaveBeenCalledWith({ where: { id: 'tm1' } })
  })
})

describe('TeamsService.addMember', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique
      .mockResolvedValueOnce(ADMIN) // actor
      .mockResolvedValueOnce({ id: 'mTarget', userId: 'u2', isActive: true }) // target as account member
  })

  it('403 AGENT actor', async () => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown team', async () => {
    prisma.team.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 team in other account', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'other-acc' })
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 when target user is not a member of the account', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    // Override the SECOND findUnique (target lookup) to return null
    prisma.accountMember.findUnique = vi.fn().mockImplementation(
      ({ where: { accountId_userId } }: { where: { accountId_userId: { userId: string } } }) =>
        accountId_userId.userId === 'u1' ? Promise.resolve(ADMIN) : Promise.resolve(null),
    )
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow('User is not a member of this account')
  })

  it('404 when target user is an inactive member', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.accountMember.findUnique = vi.fn().mockImplementation(
      ({ where: { accountId_userId } }: { where: { accountId_userId: { userId: string } } }) =>
        accountId_userId.userId === 'u1'
          ? Promise.resolve(ADMIN)
          : Promise.resolve({ id: 'mTarget', userId: 'u2', isActive: false }),
    )
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow('User is not a member of this account')
  })

  it('409 when target is already on the team', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.teamMember.findUnique.mockResolvedValue({ id: 'tmm1' })
    await expect(
      makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('creates the membership otherwise', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.teamMember.findUnique.mockResolvedValue(null)
    prisma.teamMember.create.mockResolvedValue({ id: 'tmm1', userId: 'u2', user: { email: 'a@b' } })
    const out = await makeService(prisma).addMember('u1', 'acc1', 'tm1', { userId: 'u2' } as never)
    expect(out.id).toBe('tmm1')
    expect(prisma.teamMember.create).toHaveBeenCalledWith({
      data: { teamId: 'tm1', userId: 'u2' },
      include: { user: true },
    })
  })
})

describe('TeamsService.removeMember', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'tm1', 'u2'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown team', async () => {
    prisma.team.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'tm1', 'u2'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR team', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'other-acc' })
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'tm1', 'u2'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 when user is not on the team', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.teamMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).removeMember('u1', 'acc1', 'tm1', 'u2'),
    ).rejects.toThrow(NotFoundException)
  })

  it('deletes the membership when authorised', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm1', accountId: 'acc1' })
    prisma.teamMember.findUnique.mockResolvedValue({ id: 'tmm1' })
    await makeService(prisma).removeMember('u1', 'acc1', 'tm1', 'u2')
    expect(prisma.teamMember.delete).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'tm1', userId: 'u2' } },
    })
  })
})

describe('TeamsService DTOs', () => {
  const svc = new TeamsService(makePrisma() as never)

  it('toDTO maps team + memberCount + ISO timestamps', () => {
    expect(
      svc.toDTO({
        id: 'tm1',
        accountId: 'acc1',
        name: 'Suporte',
        description: 'help',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
        _count: { members: 7 },
      } as never),
    ).toEqual({
      id: 'tm1',
      accountId: 'acc1',
      name: 'Suporte',
      description: 'help',
      memberCount: 7,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('toMemberDTO maps user + member + ISO createdAt', () => {
    expect(
      svc.toMemberDTO({
        id: 'tmm1',
        userId: 'u1',
        teamId: 'tm1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        user: {
          id: 'u1',
          email: 'a@b.com',
          fullName: 'Hana',
          passwordHash: 'SECRET-MUST-NOT-LEAK',
        },
      } as never),
    ).toEqual({
      id: 'tmm1',
      userId: 'u1',
      user: { id: 'u1', email: 'a@b.com', fullName: 'Hana' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('toWithMembersDTO maps team + members', () => {
    const dto = svc.toWithMembersDTO({
      id: 'tm1',
      accountId: 'acc1',
      name: 'T',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      members: [
        {
          id: 'tmm1',
          userId: 'u1',
          teamId: 'tm1',
          createdAt: new Date(),
          user: { id: 'u1', email: 'a@b.com', fullName: 'X' },
        },
      ],
    } as never)
    expect(dto.members).toHaveLength(1)
    expect(dto.memberCount).toBe(1)
  })
})
