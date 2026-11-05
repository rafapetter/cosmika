import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccountsService } from './accounts.service'

function makePrisma() {
  return {
    accountMember: {
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>
function makeAuth() {
  return { sendInvitation: vi.fn().mockResolvedValue(true) }
}

function makeService(p: Prisma, auth: ReturnType<typeof makeAuth> = makeAuth()) {
  p.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) => fn(p))
  return new AccountsService(p as never, auth as never)
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { ...ADMIN, role: 'AGENT' }

// ---------- assertAdmin ----------

describe('AccountsService.assertAdmin', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).assertAdmin('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    await expect(makeService(prisma).assertAdmin('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).assertAdmin('u1', 'acc1')).rejects.toThrow(
      'Administrator role required',
    )
  })

  it('returns membership when active + admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    expect(await makeService(prisma).assertAdmin('u1', 'acc1')).toBe(ADMIN)
  })
})

// ---------- assertMember ----------

describe('AccountsService.assertMember', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).assertMember('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('403 inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, isActive: false })
    await expect(makeService(prisma).assertMember('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('returns membership for an active AGENT (any role)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    expect(await makeService(prisma).assertMember('u1', 'acc1')).toBe(AGENT)
  })
})

// ---------- listMembers ----------

describe('AccountsService.listMembers', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 when caller is not a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).listMembers('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('returns the active members for an active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const account = { id: 'acc1', members: [{ user: { email: 'a' } }] }
    prisma.account.findUnique.mockResolvedValue(account)
    expect(await makeService(prisma).listMembers('u1', 'acc1')).toBe(account.members)
  })
})

// ---------- getWithMembers ----------

describe('AccountsService.getWithMembers', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('404 unknown', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).getWithMembers('acc1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns the account + active members ordered by createdAt', async () => {
    const account = { id: 'acc1', members: [{ user: { email: 'a' } }] }
    prisma.account.findUnique.mockResolvedValue(account)
    expect(await makeService(prisma).getWithMembers('acc1')).toBe(account)
    expect(prisma.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acc1' },
      include: {
        members: {
          where: { isActive: true },
          include: { user: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
  })
})

// ---------- update ----------

describe('AccountsService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1' })
  })

  it('404 unknown account', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).update('acc1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('applies every field independently', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', {
      name: 'New name',
      domain: 'co.example',
      defaultLocale: 'es',
      defaultTimezone: 'Europe/Madrid',
      brandSettings: { primaryColor: '#abc' },
      aiSettings: { default_model: 'claude-haiku-4-5' },
      monthlyAiBudgetUsd: 15,
    } as never)
    const arg = prisma.account.update.mock.calls[0]![0]
    expect(arg.data.name).toBe('New name')
    expect(arg.data.domain).toBe('co.example')
    expect(arg.data.defaultLocale).toBe('es')
    expect(arg.data.defaultTimezone).toBe('Europe/Madrid')
    expect(arg.data.brandSettings).toEqual({ primaryColor: '#abc' })
    expect(arg.data.aiSettings).toEqual({ default_model: 'claude-haiku-4-5' })
    expect(arg.data.monthlyAiBudgetUsd).toBe(15)
  })

  it('accepts 0 as the monthly AI cap (meaning: no ceiling)', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', { monthlyAiBudgetUsd: 0 } as never)
    expect(prisma.account.update.mock.calls[0]![0].data).toEqual({ monthlyAiBudgetUsd: 0 })
  })

  it('turns off the admin assistant approval gate when asked', async () => {
    // false is a meaningful value here, not an absent one — writing it is the
    // only way to move the account into autonomous mode.
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', {
      adminAgentRequiresApproval: false,
    } as never)
    expect(prisma.account.update.mock.calls[0]![0].data).toEqual({
      adminAgentRequiresApproval: false,
    })
  })

  it('switches team-scoped visibility on and off', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', { teamScopedVisibility: true } as never)
    await makeService(prisma).update('acc1', { teamScopedVisibility: false } as never)
    expect(prisma.account.update.mock.calls.map((c) => c[0].data)).toEqual([
      { teamScopedVisibility: true },
      { teamScopedVisibility: false },
    ])
  })

  it('turns the approval gate back on', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', {
      adminAgentRequiresApproval: true,
    } as never)
    expect(prisma.account.update.mock.calls[0]![0].data).toEqual({
      adminAgentRequiresApproval: true,
    })
  })

  it('sends empty data when nothing supplied', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', {} as never)
    expect(prisma.account.update).toHaveBeenCalledWith({ where: { id: 'acc1' }, data: {} })
  })

  it('domain can be set to null explicitly (clearing)', async () => {
    prisma.account.update.mockResolvedValue({})
    await makeService(prisma).update('acc1', { domain: null } as never)
    const arg = prisma.account.update.mock.calls[0]![0]
    expect(arg.data.domain).toBeNull()
  })
})

// ---------- removeMember ----------

describe('AccountsService.removeMember', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('404 unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).removeMember('acc1', 'u2')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('no-op when already inactive (idempotent)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      ...AGENT,
      userId: 'u2',
      isActive: false,
    })
    await makeService(prisma).removeMember('acc1', 'u2')
    expect(prisma.accountMember.update).not.toHaveBeenCalled()
  })

  it('409 when removing the last admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, userId: 'u2' })
    prisma.accountMember.count.mockResolvedValue(0)
    await expect(makeService(prisma).removeMember('acc1', 'u2')).rejects.toThrow(
      'last administrator',
    )
  })

  it('allows removing an admin when others remain', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, userId: 'u2' })
    prisma.accountMember.count.mockResolvedValue(3)
    await makeService(prisma).removeMember('acc1', 'u2')
    expect(prisma.accountMember.update).toHaveBeenCalledWith({
      where: { accountId_userId: { accountId: 'acc1', userId: 'u2' } },
      data: { isActive: false },
    })
  })

  it('allows removing a non-admin member without checking admin count', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, userId: 'u2' })
    await makeService(prisma).removeMember('acc1', 'u2')
    expect(prisma.accountMember.count).not.toHaveBeenCalled()
    expect(prisma.accountMember.update).toHaveBeenCalled()
  })
})

// ---------- changeMemberRole ----------

describe('AccountsService.changeMemberRole', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('404 unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).changeMemberRole('acc1', 'u2', 'AGENT'),
    ).rejects.toThrow(NotFoundException)
  })

  it('409 demoting the last admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, userId: 'u2' })
    prisma.accountMember.count.mockResolvedValue(0)
    await expect(
      makeService(prisma).changeMemberRole('acc1', 'u2', 'AGENT'),
    ).rejects.toThrow('last administrator')
  })

  it('allows admin → agent when other admins exist', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, userId: 'u2' })
    prisma.accountMember.count.mockResolvedValue(2)
    prisma.accountMember.update.mockResolvedValue({})
    await makeService(prisma).changeMemberRole('acc1', 'u2', 'AGENT')
    expect(prisma.accountMember.update).toHaveBeenCalledWith({
      where: { accountId_userId: { accountId: 'acc1', userId: 'u2' } },
      data: { role: 'AGENT' },
    })
  })

  it('allows admin → admin (no-op promotion) without checking admin count', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, userId: 'u2' })
    prisma.accountMember.update.mockResolvedValue({})
    await makeService(prisma).changeMemberRole('acc1', 'u2', 'ADMINISTRATOR')
    expect(prisma.accountMember.count).not.toHaveBeenCalled()
  })

  it('agent → supervisor without admin-count check', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, userId: 'u2' })
    prisma.accountMember.update.mockResolvedValue({})
    await makeService(prisma).changeMemberRole('acc1', 'u2', 'SUPERVISOR')
    expect(prisma.accountMember.count).not.toHaveBeenCalled()
  })

  it('handles BOT role', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, userId: 'u2' })
    prisma.accountMember.update.mockResolvedValue({})
    await makeService(prisma).changeMemberRole('acc1', 'u2', 'BOT')
    const arg = prisma.accountMember.update.mock.calls[0]![0]
    expect(arg.data.role).toBe('BOT')
  })
})

// ---------- changeMemberRoleWithUser ----------

describe('AccountsService.changeMemberRoleWithUser', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('returns the updated membership + the user record', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, userId: 'u2' })
    prisma.accountMember.update.mockResolvedValue({ id: 'm', role: 'SUPERVISOR' })
    prisma.user.findUnique.mockResolvedValue({ id: 'u2', email: 'a@b.com' })

    const out = await makeService(prisma).changeMemberRoleWithUser('acc1', 'u2', 'SUPERVISOR')
    expect(out.role).toBe('SUPERVISOR')
    expect(out.user.email).toBe('a@b.com')
  })

  it('404 when user record is missing (race condition guard)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...AGENT, userId: 'u2' })
    prisma.accountMember.update.mockResolvedValue({ id: 'm' })
    prisma.user.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).changeMemberRoleWithUser('acc1', 'u2', 'AGENT'),
    ).rejects.toThrow(NotFoundException)
  })
})

// ---------- inviteMember ----------

describe('AccountsService.inviteMember', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('404 when account is unknown', async () => {
    prisma.account.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).inviteMember('acc1', {
        email: 'a@b.com',
        fullName: 'X',
        role: 'AGENT',
      }),
    ).rejects.toThrow(NotFoundException)
  })

  it('creates a new User when email is unseen', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.user.create.mockResolvedValue({ id: 'u-new', email: 'a@b.com' })
    prisma.accountMember.findUnique.mockResolvedValue(null)
    prisma.accountMember.create.mockResolvedValue({
      id: 'm-new',
      user: { id: 'u-new' },
    })

    await makeService(prisma).inviteMember('acc1', {
      email: 'A@B.COM',
      fullName: 'New Person',
      role: 'AGENT',
    })

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'a@b.com', fullName: 'New Person', locale: 'pt-BR' },
    })
  })

  it('reuses existing User when email matches', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue({ id: 'u-existing' })
    prisma.accountMember.findUnique.mockResolvedValue(null)
    prisma.accountMember.create.mockResolvedValue({ id: 'm-new', user: { id: 'u-existing' } })

    await makeService(prisma).inviteMember('acc1', {
      email: 'a@b.com',
      fullName: 'New Person',
      role: 'AGENT',
    })

    expect(prisma.user.create).not.toHaveBeenCalled()
  })

  it('409 when user is already a member of this account', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue({ id: 'u-existing' })
    prisma.accountMember.findUnique.mockResolvedValue({ id: 'm-existing', isActive: true })

    await expect(
      makeService(prisma).inviteMember('acc1', {
        email: 'a@b.com',
        fullName: 'X',
        role: 'AGENT',
      }),
    ).rejects.toThrow('already a member')
  })

  it('brings back someone who left, with the new role, instead of refusing', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', name: 'Loja', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue({ id: 'u-old' })
    prisma.accountMember.findUnique.mockResolvedValue({ id: 'm-old', isActive: false })
    prisma.accountMember.update.mockResolvedValue({ id: 'm-old', userId: 'u-old', user: { id: 'u-old' } })
    const auth = makeAuth()
    await makeService(prisma, auth).inviteMember('acc1', { email: 'a@b.com', fullName: 'X', role: 'SUPERVISOR' })
    expect(prisma.accountMember.update).toHaveBeenCalledWith({
      where: { accountId_userId: { accountId: 'acc1', userId: 'u-old' } },
      data: { isActive: true, role: 'SUPERVISOR' },
      include: { user: true },
    })
    expect(prisma.accountMember.create).not.toHaveBeenCalled()
    expect(auth.sendInvitation).toHaveBeenCalledWith('u-old', 'Loja')
  })

  it('emails the invitation after the membership exists', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', name: 'Loja', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue(null)
    prisma.user.create.mockResolvedValue({ id: 'u-new', email: 'a@b.com' })
    prisma.accountMember.findUnique.mockResolvedValue(null)
    prisma.accountMember.create.mockResolvedValue({ id: 'm-new', userId: 'u-new', user: { id: 'u-new' } })
    const auth = makeAuth()
    await makeService(prisma, auth).inviteMember('acc1', { email: 'a@b.com', fullName: 'N', role: 'AGENT' })
    // Before: the invitee got a user with no password and no message.
    expect(auth.sendInvitation).toHaveBeenCalledWith('u-new', 'Loja')
  })

  it('lowercases the email before lookup', async () => {
    prisma.account.findUnique.mockResolvedValue({ id: 'acc1', defaultLocale: 'pt-BR' })
    prisma.user.findUnique.mockResolvedValue({ id: 'u-existing' })
    prisma.accountMember.findUnique.mockResolvedValue(null)
    prisma.accountMember.create.mockResolvedValue({ id: 'm', user: { id: 'u-existing' } })

    await makeService(prisma).inviteMember('acc1', {
      email: 'Mixed@Case.COM',
      fullName: 'X',
      role: 'AGENT',
    })
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'mixed@case.com' },
    })
  })
})
