import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { AgentAvailability } from '@cosmika/db'
import { SetAgentAvailabilityInput } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

@Injectable()
export class AgentAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  private async getMember(accountId: string, memberId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { id: memberId },
    })
    if (!m || m.accountId !== accountId) throw new NotFoundException()
    return m
  }

  async list(
    userId: string,
    accountId: string,
    memberId: string,
  ): Promise<AgentAvailability[]> {
    const me = await this.assertMember(userId, accountId)
    const target = await this.getMember(accountId, memberId)
    // members can only manage their own schedule unless admin
    if (target.userId !== me.userId && me.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(
        errBody('own_availability_only', 'Members can only manage their own availability'),
      )
    }
    return this.prisma.agentAvailability.findMany({
      where: { accountId, memberId },
      orderBy: { dayOfWeek: 'asc' },
    })
  }

  async replace(
    userId: string,
    accountId: string,
    memberId: string,
    schedule: SetAgentAvailabilityInput[],
  ): Promise<AgentAvailability[]> {
    const me = await this.assertMember(userId, accountId)
    const target = await this.getMember(accountId, memberId)
    if (target.userId !== me.userId && me.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(
        errBody('own_availability_only', 'Members can only manage their own availability'),
      )
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.agentAvailability.deleteMany({
        where: { accountId, memberId },
      })
      if (schedule.length === 0) return []
      await tx.agentAvailability.createMany({
        data: schedule.map((s) => ({
          accountId,
          memberId,
          dayOfWeek: s.dayOfWeek,
          openHour: s.openHour,
          openMinute: s.openMinute,
          closeHour: s.closeHour,
          closeMinute: s.closeMinute,
          closedAllDay: s.closedAllDay,
        })),
      })
      return tx.agentAvailability.findMany({
        where: { accountId, memberId },
        orderBy: { dayOfWeek: 'asc' },
      })
    })
  }

  toDTO(row: AgentAvailability) {
    return {
      id: row.id,
      memberId: row.memberId,
      dayOfWeek: row.dayOfWeek,
      openHour: row.openHour,
      openMinute: row.openMinute,
      closeHour: row.closeHour,
      closeMinute: row.closeMinute,
      closedAllDay: row.closedAllDay,
    }
  }
}
