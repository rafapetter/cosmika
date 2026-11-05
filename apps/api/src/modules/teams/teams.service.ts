import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  Prisma,
  Role,
  Team,
  TeamMember,
  User,
} from '@cosmika/db'
import {
  AddTeamMemberInput,
  CreateTeamInput,
  UpdateTeamInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

export type TeamWithMembers = Team & {
  members: Array<TeamMember & { user: User }>
}

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getMembership(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  private assertMutator(role: Role) {
    if (!MUTATE_ROLES.includes(role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  async list(userId: string, accountId: string): Promise<Array<Team & { _count: { members: number } }>> {
    await this.getMembership(userId, accountId)
    return this.prisma.team.findMany({
      where: { accountId },
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    })
  }

  async getWithMembers(
    userId: string,
    accountId: string,
    teamId: string,
  ): Promise<TeamWithMembers> {
    await this.getMembership(userId, accountId)
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        members: {
          include: { user: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!team || team.accountId !== accountId) throw new NotFoundException()
    return team
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateTeamInput,
  ): Promise<Team> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    return this.prisma.team.create({
      data: {
        accountId,
        name: input.name,
        description: input.description ?? null,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    teamId: string,
    input: UpdateTeamInput,
  ): Promise<Team & { _count: { members: number } }> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    const data: Prisma.TeamUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
    }
    return this.prisma.team.update({
      where: { id: teamId },
      data,
      include: { _count: { select: { members: true } } },
    })
  }

  async remove(userId: string, accountId: string, teamId: string): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    // Conversations with teamId pointing at this team will SetNull via FK
    // (`Conversation.team` is optional). Cascade members + delete.
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: { teamId },
        data: { teamId: null },
      })
      await tx.team.delete({ where: { id: teamId } })
    })
  }

  async addMember(
    userId: string,
    accountId: string,
    teamId: string,
    input: AddTeamMemberInput,
  ): Promise<TeamMember & { user: User }> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, accountId: true },
    })
    if (!team || team.accountId !== accountId) throw new NotFoundException()

    const target = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId: input.userId } },
    })
    if (!target || !target.isActive) {
      throw new NotFoundException('User is not a member of this account')
    }

    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: input.userId } },
    })
    if (existing) throw new ConflictException(errBody('already_team_member', 'User is already on this team'))

    return this.prisma.teamMember.create({
      data: { teamId, userId: input.userId },
      include: { user: true },
    })
  }

  async removeMember(
    userId: string,
    accountId: string,
    teamId: string,
    memberUserId: string,
  ): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, accountId: true },
    })
    if (!team || team.accountId !== accountId) throw new NotFoundException()

    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
    if (!existing) throw new NotFoundException()
    await this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId, userId: memberUserId } },
    })
  }

  toDTO(team: Team & { _count: { members: number } }) {
    return {
      id: team.id,
      accountId: team.accountId,
      name: team.name,
      description: team.description,
      memberCount: team._count.members,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    }
  }

  toMemberDTO(member: TeamMember & { user: User }) {
    return {
      id: member.id,
      userId: member.userId,
      user: {
        id: member.user.id,
        email: member.user.email,
        fullName: member.user.fullName,
      },
      createdAt: member.createdAt.toISOString(),
    }
  }

  toWithMembersDTO(team: TeamWithMembers) {
    return {
      ...this.toDTO({ ...team, _count: { members: team.members.length } }),
      members: team.members.map((m) => this.toMemberDTO(m)),
    }
  }
}
