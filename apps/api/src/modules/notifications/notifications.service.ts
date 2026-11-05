import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  Conversation,
  Notification,
  Prisma,
  User,
} from '@cosmika/db'
import type { ListNotificationsQuery, NotificationDTO } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 25

export type HydratedNotification = Notification & {
  mentionedBy: User | null
  conversation:
    | (Pick<Conversation, 'id' | 'displayId' | 'contactId'> & {
        contact: { name: string | null } | null
      })
    | null
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  // ─── preferences ──────────────────────────────────────────────────

  async getPreferences(
    userId: string,
    accountId: string,
  ): Promise<{ mentionsEnabled: boolean; assignmentsEnabled: boolean }> {
    await this.assertMember(userId, accountId)
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    // No row = everything on.
    return {
      mentionsEnabled: pref?.mentionsEnabled ?? true,
      assignmentsEnabled: pref?.assignmentsEnabled ?? true,
    }
  }

  async updatePreferences(
    userId: string,
    accountId: string,
    input: { mentionsEnabled?: boolean; assignmentsEnabled?: boolean },
  ): Promise<{ mentionsEnabled: boolean; assignmentsEnabled: boolean }> {
    await this.assertMember(userId, accountId)
    const pref = await this.prisma.notificationPreference.upsert({
      where: { accountId_userId: { accountId, userId } },
      create: {
        accountId,
        userId,
        ...(input.mentionsEnabled !== undefined && {
          mentionsEnabled: input.mentionsEnabled,
        }),
        ...(input.assignmentsEnabled !== undefined && {
          assignmentsEnabled: input.assignmentsEnabled,
        }),
      },
      update: {
        ...(input.mentionsEnabled !== undefined && {
          mentionsEnabled: input.mentionsEnabled,
        }),
        ...(input.assignmentsEnabled !== undefined && {
          assignmentsEnabled: input.assignmentsEnabled,
        }),
      },
    })
    return {
      mentionsEnabled: pref.mentionsEnabled,
      assignmentsEnabled: pref.assignmentsEnabled,
    }
  }

  /** Of `userIds`, return those who have the given notification type enabled. */
  private async usersWithTypeEnabled(
    accountId: string,
    userIds: string[],
    field: 'mentionsEnabled' | 'assignmentsEnabled',
  ): Promise<string[]> {
    if (userIds.length === 0) return []
    // Users who explicitly disabled this type.
    const optedOut = await this.prisma.notificationPreference.findMany({
      where: { accountId, userId: { in: userIds }, [field]: false },
      select: { userId: true },
    })
    const muted = new Set(optedOut.map((p) => p.userId))
    return userIds.filter((id) => !muted.has(id))
  }

  async list(
    userId: string,
    accountId: string,
    query: ListNotificationsQuery,
  ): Promise<HydratedNotification[]> {
    await this.assertMember(userId, accountId)
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    return this.prisma.notification.findMany({
      where: {
        accountId,
        userId,
        ...(query.onlyUnread ? { readAt: null } : {}),
      },
      include: {
        mentionedBy: true,
        conversation: {
          select: {
            id: true,
            displayId: true,
            contactId: true,
            contact: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  async unreadCount(userId: string, accountId: string): Promise<number> {
    await this.assertMember(userId, accountId)
    return this.prisma.notification.count({
      where: { accountId, userId, readAt: null },
    })
  }

  async markRead(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertMember(userId, accountId)
    const n = await this.prisma.notification.findUnique({ where: { id } })
    if (!n || n.accountId !== accountId || n.userId !== userId) {
      throw new NotFoundException()
    }
    if (!n.readAt) {
      await this.prisma.notification.update({
        where: { id },
        data: { readAt: new Date() },
      })
    }
  }

  async markAllRead(userId: string, accountId: string): Promise<{ updated: number }> {
    await this.assertMember(userId, accountId)
    const r = await this.prisma.notification.updateMany({
      where: { accountId, userId, readAt: null },
      data: { readAt: new Date() },
    })
    return { updated: r.count }
  }

  /**
   * Internal: create one Notification row per mentioned user. Called by
   * ConversationsService after a message with @-mentions is committed.
   */
  async createMentions(args: {
    accountId: string
    conversationId: string
    messageId: string
    mentionedByUserId: string
    targetUserIds: string[]
  }): Promise<void> {
    const selfFiltered = args.targetUserIds.filter(
      (id) => id !== args.mentionedByUserId,
    )
    // Respect each recipient's notification preferences.
    const targets = await this.usersWithTypeEnabled(
      args.accountId,
      selfFiltered,
      'mentionsEnabled',
    )
    if (targets.length === 0) return
    await this.prisma.notification.createMany({
      data: targets.map((targetId) => ({
        accountId: args.accountId,
        userId: targetId,
        type: 'MENTION' as const,
        conversationId: args.conversationId,
        messageId: args.messageId,
        mentionedByUserId: args.mentionedByUserId,
      })),
      skipDuplicates: true,
    })
  }

  /**
   * Internal: a conversation changed hands. Called wherever an assignee is
   * actually written, which is manual assignment, the bulk action, and
   * automatic distribution (normal round robin and the off-shift handoff
   * fallback alike).
   *
   * Until now nothing in the product ever created an ASSIGNMENT row, while
   * Profile showed an "Assignments" toggle switched on: the interface promised
   * a notification that could not arrive. That mattered little when a human
   * chose the assignee and told them; it matters now that distribution can
   * hand a conversation to someone who is off shift and does not know.
   *
   * Two things happen here, and the first happens even when the second does
   * not. Losing a conversation clears the old owner's pending notification,
   * so a bell does not keep pointing at a thread that is no longer theirs.
   * Then the new owner is told, unless they did it to themselves, opted out,
   * or are not a person.
   *
   * `assignedByUserId` is null for automatic distribution, which is what the
   * bell reads to say "assigned to you" rather than naming someone who did
   * not act. Never throws: nobody loses an assignment over a bell.
   */
  async createAssignment(args: {
    accountId: string
    conversationId: string
    assigneeId: string | null
    assignedByUserId: string | null
    previousAssigneeId: string | null
    /**
     * True when distribution only found this person by falling back past the
     * schedule, i.e. nobody was on shift. Adds a second, different notice to
     * the people who can do something about that.
     */
    offlineFallback?: boolean
  }): Promise<void> {
    if (args.assigneeId === args.previousAssigneeId) return
    try {
      if (args.previousAssigneeId) {
        await this.prisma.notification.updateMany({
          where: {
            accountId: args.accountId,
            userId: args.previousAssigneeId,
            conversationId: args.conversationId,
            type: 'ASSIGNMENT',
            readAt: null,
          },
          data: { readAt: new Date() },
        })
      }
      // Unassigned: there is nobody to tell, and the old owner is already clear.
      if (!args.assigneeId) return
      // Assigning to yourself is not news to you.
      if (args.assigneeId === args.assignedByUserId) return
      // A bot has no bell, and an inactive member is gone.
      const member = await this.prisma.accountMember.findUnique({
        where: {
          accountId_userId: {
            accountId: args.accountId,
            userId: args.assigneeId,
          },
        },
        select: { isActive: true, role: true },
      })
      if (!member || !member.isActive || member.role === 'BOT') return
      const targets = await this.usersWithTypeEnabled(
        args.accountId,
        [args.assigneeId],
        'assignmentsEnabled',
      )
      if (targets.length === 0) return
      await this.prisma.notification.create({
        data: {
          accountId: args.accountId,
          userId: args.assigneeId,
          type: 'ASSIGNMENT',
          conversationId: args.conversationId,
          mentionedByUserId: args.assignedByUserId,
        },
      })
      if (args.offlineFallback) {
        await this.notifyCoverageGap(args.accountId, args.conversationId, args.assigneeId)
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[notifications] assignment notice failed:`, m)
    }
  }

  /**
   * A conversation crossed its SLA. Tell whoever has it (the assignee, or
   * everyone on its team when nobody does) and the administrators and
   * supervisors who watch the queue. Returns who was told, so the realtime
   * alarm goes to the same people.
   *
   * Gated on `assignmentsEnabled` like the other queue notices. Never throws:
   * the breach sweep must keep going.
   */
  async createSlaBreach(args: {
    accountId: string
    conversationId: string
    assigneeId: string | null
    teamId: string | null
  }): Promise<string[]> {
    try {
      const owners = args.assigneeId
        ? [args.assigneeId]
        : args.teamId
          ? (
              await this.prisma.teamMember.findMany({
                where: { teamId: args.teamId },
                select: { userId: true },
              })
            ).map((m) => m.userId)
          : []
      const watchers = await this.prisma.accountMember.findMany({
        where: {
          accountId: args.accountId,
          isActive: true,
          role: { in: ['ADMINISTRATOR', 'SUPERVISOR'] },
        },
        select: { userId: true },
      })
      const candidates = [...new Set([...owners, ...watchers.map((w) => w.userId)])]
      const active = await this.prisma.accountMember.findMany({
        where: {
          accountId: args.accountId,
          userId: { in: candidates },
          isActive: true,
          role: { not: 'BOT' },
        },
        select: { userId: true },
      })
      const targets = await this.usersWithTypeEnabled(
        args.accountId,
        active.map((m) => m.userId),
        'assignmentsEnabled',
      )
      if (targets.length === 0) return []
      await this.prisma.notification.createMany({
        data: targets.map((userId) => ({
          accountId: args.accountId,
          userId,
          type: 'SLA_BREACH' as const,
          conversationId: args.conversationId,
        })),
        skipDuplicates: true,
      })
      return targets
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[notifications] SLA breach notice failed:`, m)
      return []
    }
  }

  /**
   * Tell the people who can fix a coverage hole that one just cost a customer.
   *
   * Who: active, non-bot ADMINISTRATOR and SUPERVISOR members of the account,
   * minus the agent who received the conversation (they already have their own
   * ASSIGNMENT notice and do not need to be told twice about the same event).
   *
   * Not the rest of the inbox, and the reason is the situation itself: the
   * fallback only fires when NOBODY is on shift, so every other agent on that
   * inbox is off the clock too. Waking five people who are also not working
   * turns a real signal into 3am noise, and none of them can change a schedule
   * or reassign the queue. The people who can are the ones who get it.
   *
   * The row deliberately carries no author. `mentionedByUserId` means who
   * caused the notification, and no person caused this one; putting the
   * assignee there would make the field lie, and the bell can say what
   * happened without naming them. Opening the conversation shows who has it.
   *
   * Gated on `assignmentsEnabled`, the same switch as the assignment notice.
   * It is the closest thing to a mute for this kind of event, a third
   * preference is schema and UI nobody asked for, and it fails quiet.
   */
  private async notifyCoverageGap(
    accountId: string,
    conversationId: string,
    assigneeId: string,
  ): Promise<void> {
    const supervisors = await this.prisma.accountMember.findMany({
      where: {
        accountId,
        isActive: true,
        role: { in: ['ADMINISTRATOR', 'SUPERVISOR'] },
        userId: { not: assigneeId },
      },
      select: { userId: true },
    })
    const targets = await this.usersWithTypeEnabled(
      accountId,
      supervisors.map((m) => m.userId),
      'assignmentsEnabled',
    )
    if (targets.length === 0) return
    await this.prisma.notification.createMany({
      data: targets.map((userId) => ({
        accountId,
        userId,
        type: 'ASSIGNMENT_FALLBACK' as const,
        conversationId,
      })),
      skipDuplicates: true,
    })
  }

  toDTO(n: HydratedNotification, messagePreview?: string | null): NotificationDTO {
    return {
      id: n.id,
      accountId: n.accountId,
      userId: n.userId,
      type: n.type,
      conversationId: n.conversationId,
      messageId: n.messageId,
      mentionedByUserId: n.mentionedByUserId,
      mentionedBy: n.mentionedBy
        ? {
            id: n.mentionedBy.id,
            email: n.mentionedBy.email,
            fullName: n.mentionedBy.fullName,
          }
        : null,
      conversation: n.conversation
        ? {
            id: n.conversation.id,
            displayId: n.conversation.displayId,
            contactName: n.conversation.contact?.name ?? null,
          }
        : null,
      messagePreview: messagePreview ?? null,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    }
  }
}
