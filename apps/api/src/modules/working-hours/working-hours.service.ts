import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Holiday, Role, WorkingHour } from '@cosmika/db'
import {
  CreateHolidayInput,
  SetWorkingHoursInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class WorkingHoursService {
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

  private async ensureInbox(accountId: string, inboxId: string) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
      select: { id: true, accountId: true },
    })
    if (!inbox || inbox.accountId !== accountId) throw new NotFoundException()
  }

  async listForInbox(
    userId: string,
    accountId: string,
    inboxId: string,
  ): Promise<WorkingHour[]> {
    await this.getMembership(userId, accountId)
    await this.ensureInbox(accountId, inboxId)
    return this.prisma.workingHour.findMany({
      where: { inboxId },
      orderBy: { dayOfWeek: 'asc' },
    })
  }

  /**
   * Replace-all semantics. Send 0–7 rows; we wipe existing rows for this
   * inbox and write the new set. Simpler for the UI than diffing per-day.
   */
  async setForInbox(
    userId: string,
    accountId: string,
    inboxId: string,
    input: SetWorkingHoursInput,
  ): Promise<WorkingHour[]> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.ensureInbox(accountId, inboxId)

    // Dedupe by dayOfWeek (last write wins) before insert; the @@unique
    // constraint would otherwise reject duplicates.
    const byDay = new Map<number, SetWorkingHoursInput['hours'][number]>()
    for (const h of input.hours) byDay.set(h.dayOfWeek, h)

    return this.prisma.$transaction(async (tx) => {
      await tx.workingHour.deleteMany({ where: { inboxId } })
      if (byDay.size === 0) return []
      await tx.workingHour.createMany({
        data: Array.from(byDay.values()).map((h) => ({
          inboxId,
          accountId,
          dayOfWeek: h.dayOfWeek,
          closedAllDay: h.closedAllDay,
          openHour: h.openHour,
          openMinute: h.openMinute,
          closeHour: h.closeHour,
          closeMinute: h.closeMinute,
        })),
      })
      return tx.workingHour.findMany({
        where: { inboxId },
        orderBy: { dayOfWeek: 'asc' },
      })
    })
  }

  async listHolidays(
    userId: string,
    accountId: string,
  ): Promise<Holiday[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.holiday.findMany({
      where: { accountId },
      orderBy: { date: 'asc' },
    })
  }

  async createHoliday(
    userId: string,
    accountId: string,
    input: CreateHolidayInput,
  ): Promise<Holiday> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const date = new Date(`${input.date}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime())) {
      throw new NotFoundException('Invalid date')
    }
    return this.prisma.holiday.create({
      data: { accountId, name: input.name, date },
    })
  }

  async deleteHoliday(
    userId: string,
    accountId: string,
    holidayId: string,
  ): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.holiday.findUnique({
      where: { id: holidayId },
      select: { accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    await this.prisma.holiday.delete({ where: { id: holidayId } })
  }

  /**
   * Helper: is the inbox currently open?  Used by future automations to
   * decide whether to send greetings / out-of-office messages.
   */
  async isInboxOpenNow(
    accountId: string,
    inboxId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    // Holidays apply across all inboxes for the account.
    const startOfDay = new Date(now)
    startOfDay.setUTCHours(0, 0, 0, 0)
    const endOfDay = new Date(startOfDay)
    endOfDay.setUTCHours(23, 59, 59, 999)
    const holiday = await this.prisma.holiday.findFirst({
      where: { accountId, date: { gte: startOfDay, lte: endOfDay } },
      select: { id: true },
    })
    if (holiday) return false

    const dow = now.getUTCDay()
    const wh = await this.prisma.workingHour.findUnique({
      where: { inboxId_dayOfWeek: { inboxId, dayOfWeek: dow } },
    })
    // No row for this day means default-closed for that day.
    if (!wh || wh.closedAllDay) return false

    const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes()
    const open = wh.openHour * 60 + wh.openMinute
    const close = wh.closeHour * 60 + wh.closeMinute
    return minutesNow >= open && minutesNow < close
  }

  toWorkingHourDTO(w: WorkingHour) {
    return {
      id: w.id,
      inboxId: w.inboxId,
      dayOfWeek: w.dayOfWeek,
      closedAllDay: w.closedAllDay,
      openHour: w.openHour,
      openMinute: w.openMinute,
      closeHour: w.closeHour,
      closeMinute: w.closeMinute,
    }
  }

  toHolidayDTO(h: Holiday) {
    return {
      id: h.id,
      accountId: h.accountId,
      name: h.name,
      // Serialize as YYYY-MM-DD for client friendliness.
      date: h.date.toISOString().slice(0, 10),
      createdAt: h.createdAt.toISOString(),
    }
  }
}
