import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Account, AccountMember, Prisma, User } from '@cosmika/db'
import { InviteMemberInput, UpdateAccountInput } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { AuthService } from '../auth/auth.service'
import { errBody } from '../../common/app-error'

type AccountWithMemberships = Account & {
  members: Array<AccountMember & { user: User }>
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async assertAdmin(userId: string, accountId: string) {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    if (membership.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
    return membership
  }

  /** Assert the caller is an active member (any role) of the account. */
  async assertMember(userId: string, accountId: string): Promise<AccountMember> {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return membership
  }

  /**
   * List active members for assignee/team pickers. Available to any active
   * member (not just admins) — agents need it to assign conversations.
   */
  async listMembers(
    userId: string,
    accountId: string,
  ): Promise<Array<AccountMember & { user: User }>> {
    await this.assertMember(userId, accountId)
    const account = await this.getWithMembers(accountId)
    return account.members
  }

  async getWithMembers(accountId: string): Promise<AccountWithMemberships> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: {
        members: {
          where: { isActive: true },
          include: { user: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!account) throw new NotFoundException()
    return account
  }

  async update(accountId: string, input: UpdateAccountInput): Promise<Account> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true },
    })
    if (!account) throw new NotFoundException()
    const data: Prisma.AccountUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.domain !== undefined && { domain: input.domain }),
      ...(input.defaultLocale !== undefined && {
        defaultLocale: input.defaultLocale,
      }),
      ...(input.defaultTimezone !== undefined && {
        defaultTimezone: input.defaultTimezone,
      }),
      ...(input.brandSettings !== undefined && {
        brandSettings: input.brandSettings as Prisma.InputJsonValue,
      }),
      ...(input.aiSettings !== undefined && {
        aiSettings: input.aiSettings as Prisma.InputJsonValue,
      }),
      ...(input.monthlyAiBudgetUsd !== undefined && {
        monthlyAiBudgetUsd: input.monthlyAiBudgetUsd,
      }),
      ...(input.adminAgentRequiresApproval !== undefined && {
        adminAgentRequiresApproval: input.adminAgentRequiresApproval,
      }),
      ...(input.teamScopedVisibility !== undefined && {
        teamScopedVisibility: input.teamScopedVisibility,
      }),
    }
    return this.prisma.account.update({
      where: { id: accountId },
      data,
    })
  }

  async removeMember(
    accountId: string,
    userId: string,
  ): Promise<void> {
    // Don't allow removing the last active administrator.
    const target = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!target) throw new NotFoundException()
    if (!target.isActive) return
    if (target.role === 'ADMINISTRATOR') {
      const otherAdmins = await this.prisma.accountMember.count({
        where: {
          accountId,
          role: 'ADMINISTRATOR',
          isActive: true,
          NOT: { userId },
        },
      })
      if (otherAdmins === 0) {
        throw new ConflictException(errBody('last_admin_remove', 'Cannot remove the last administrator. Promote another member first.'))
      }
    }
    await this.prisma.accountMember.update({
      where: { accountId_userId: { accountId, userId } },
      data: { isActive: false },
    })
  }

  async changeMemberRoleWithUser(
    accountId: string,
    userId: string,
    role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' | 'BOT',
  ): Promise<AccountMember & { user: User }> {
    const updated = await this.changeMemberRole(accountId, userId, role)
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException()
    return { ...updated, user }
  }

  async changeMemberRole(
    accountId: string,
    userId: string,
    role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' | 'BOT',
  ): Promise<AccountMember> {
    const target = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!target) throw new NotFoundException()
    // Demoting the last admin leaves nobody able to administer the account.
    if (target.role === 'ADMINISTRATOR' && role !== 'ADMINISTRATOR') {
      const otherAdmins = await this.prisma.accountMember.count({
        where: {
          accountId,
          role: 'ADMINISTRATOR',
          isActive: true,
          NOT: { userId },
        },
      })
      if (otherAdmins === 0) {
        throw new ConflictException(errBody('last_admin_demote', 'Cannot demote the last administrator. Promote another member first.'))
      }
    }
    return this.prisma.accountMember.update({
      where: { accountId_userId: { accountId, userId } },
      data: { role },
    })
  }

  async inviteMember(
    accountId: string,
    input: InviteMemberInput,
  ): Promise<AccountMember & { user: User }> {
    const email = input.email.toLowerCase()
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, defaultLocale: true },
    })
    if (!account) throw new NotFoundException()

    const membership = await this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email } })
      if (!user) {
        user = await tx.user.create({
          data: {
            email,
            fullName: input.fullName,
            locale: account.defaultLocale,
          },
        })
      }
      const existing = await tx.accountMember.findUnique({
        where: { accountId_userId: { accountId, userId: user.id } },
      })
      if (existing?.isActive) {
        throw new ConflictException(errBody('already_member', 'User is already a member'))
      }
      // Someone who left (or was removed) comes back with the new role,
      // instead of the invite failing with "already a member" for a
      // membership nobody can see.
      if (existing) {
        return tx.accountMember.update({
          where: { accountId_userId: { accountId, userId: user.id } },
          data: { isActive: true, role: input.role },
          include: { user: true },
        })
      }
      return tx.accountMember.create({
        data: {
          accountId,
          userId: user.id,
          role: input.role,
        },
        include: { user: true },
      })
    })
    // After commit: a failed email must not undo the membership, and the
    // invitee can still recover with "forgot password".
    await this.auth.sendInvitation(membership.userId, account.name)
    return membership
  }
}
