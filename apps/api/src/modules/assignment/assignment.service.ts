import { Injectable, Logger } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { ActivityService, SYSTEM_ACTOR } from '../activity/activity.service'
import { NotificationsService } from '../notifications/notifications.service'

import {
  type AvailabilitySlot,
  isWithinSchedule,
  localMoment,
} from './availability-window'

/**
 * Why a conversation is being routed. Only used for logging and to decide
 * whether a conversation still under bot control may be routed.
 *
 * - conversation_created: first customer message of a conversation.
 * - conversation_reopened: a resolved conversation came back.
 * - bot_handoff: a flow or the AI agent handed the conversation to humans.
 * - team_changed: a team was set (manually, by an automation or by a flow).
 * - manual: someone asked for automatic distribution explicitly.
 */
export type RoutingTrigger =
  | 'conversation_created'
  | 'conversation_reopened'
  | 'bot_handoff'
  | 'team_changed'
  | 'manual'

/**
 * Machine-readable marker on the activity entry when an assignment only
 * happened because nobody was available. Reporting reads this rather than
 * parsing the human-readable text.
 */
export const OFFLINE_FALLBACK_REASON = 'no_agent_on_shift'

export type RoutingResult = {
  /** Assignee after routing (unchanged when nothing happened). */
  assigneeId: string | null
  /** The member routing picked, or null when nobody was picked. */
  pickedId: string | null
}

type Candidate = {
  id: string
  userId: string
  lastAutoAssignedAt: Date | null
  availabilities: AvailabilitySlot[]
  user: { fullName: string | null }
}

/**
 * Automatic conversation distribution that respects agent availability,
 * ported from Nebula's AutoAssignment::AgentAssignmentService.
 *
 * Who can receive a conversation:
 *   1. an active account member who is not a bot,
 *   2. a member of the conversation's inbox,
 *   3. a member of the conversation's team, when it has one,
 *   4. available right now: their saved schedule ("Minha disponibilidade")
 *      covers this moment in the account's timezone. No schedule saved means
 *      not available, the same way Nebula only counts agents with positive
 *      evidence of being online.
 *
 * Among those, a round robin: the member who has waited longest since their
 * last automatic assignment gets it (never assigned first).
 *
 * When nobody is available the conversation is left without an assignee, in
 * the queue, which is Nebula's default (`assignment_offline_agent` off).
 *
 * A current assignee who is still eligible (active, in the inbox, in the
 * team) keeps the conversation: routing only fills a gap. When a team is set
 * and the current assignee is not in it, the assignee is replaced, or
 * removed if nobody in the team is available (Nebula's AssignmentHandler).
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Route one conversation. Never throws: distribution failing must not
   * break the message, handoff or update that triggered it. Returns null when
   * the outcome is unknown (conversation gone, or routing failed).
   *
   * `force` re-picks even when the current assignee is eligible (the manual
   * "distribute automatically" action) and routes regardless of bot control.
   */
  async route(
    conversationId: string,
    trigger: RoutingTrigger,
    opts: { force?: boolean; now?: Date } = {},
  ): Promise<RoutingResult | null> {
    try {
      return await this.routeOrThrow(conversationId, trigger, opts)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`routing (${trigger}) failed for ${conversationId}: ${m}`)
      return null
    }
  }

  private async routeOrThrow(
    conversationId: string,
    trigger: RoutingTrigger,
    opts: { force?: boolean; now?: Date },
  ): Promise<RoutingResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        accountId: true,
        inboxId: true,
        teamId: true,
        assigneeId: true,
        status: true,
        controlMode: true,
      },
    })
    if (!conversation) return null
    const unchanged = { assigneeId: conversation.assigneeId, pickedId: null }
    if (conversation.status === 'RESOLVED') return unchanged
    // While the bot drives the conversation nobody should be pulled in; the
    // handoff routes it. The AI agent's handoff tool runs before control
    // changes, so it is the exception, as is an explicit manual request.
    if (
      conversation.controlMode === 'BOT' &&
      trigger !== 'bot_handoff' &&
      !opts.force
    ) {
      return unchanged
    }

    const eligible: Candidate[] = await this.prisma.accountMember.findMany({
      where: {
        accountId: conversation.accountId,
        isActive: true,
        role: { not: 'BOT' },
        user: {
          inboxMemberships: { some: { inboxId: conversation.inboxId } },
          ...(conversation.teamId
            ? { teamMemberships: { some: { teamId: conversation.teamId } } }
            : {}),
        },
      },
      select: {
        id: true,
        userId: true,
        lastAutoAssignedAt: true,
        availabilities: true,
        user: { select: { fullName: true } },
      },
    })

    const current = conversation.assigneeId
    const currentEligible =
      current !== null && eligible.some((m) => m.userId === current)
    if (currentEligible && !opts.force) return unchanged

    const account = await this.prisma.account.findUnique({
      where: { id: conversation.accountId },
      select: { defaultTimezone: true },
    })
    const now = opts.now ?? new Date()
    const moment = localMoment(now, account?.defaultTimezone ?? 'UTC')
    const available = eligible.filter((m) =>
      isWithinSchedule(m.availabilities, moment),
    )

    // Offline fallback, handoff only. On a bot handoff there is a person on
    // the other end who has just been told a human is coming, so handing the
    // conversation to someone off shift beats leaving it ownerless in the
    // queue. Every other trigger keeps Nebula's default (`assignment_offline_agent`
    // off) and waits for someone who is actually on shift.
    const offlineFallback = available.length === 0 && trigger === 'bot_handoff'
    const pool = offlineFallback ? eligible : available
    if (offlineFallback && eligible.length > 0) {
      this.logger.log(
        `no agent on shift for ${conversation.id}; handoff falling back to an ` +
          `off-shift member out of ${eligible.length} eligible`,
      )
    }

    const picked = await this.claimNext(pool, now)
    if (picked) {
      if (picked.userId !== current) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { assigneeId: picked.userId },
        })
        const name = picked.user.fullName ?? 'an agent'
        // Say which of the two this was. A fallback assignment is somebody
        // being handed a conversation outside their hours; a report that
        // counts it as ordinary distribution would be measuring the wrong
        // thing, and the agent deserves to see why it landed on them.
        await this.activity.log(conversation, {
          type: 'assignee',
          text: offlineFallback
            ? `Conversation assigned to ${name}${ActivityService.by(SYSTEM_ACTOR)} (nobody on shift)`
            : `Conversation assigned to ${name}${ActivityService.by(SYSTEM_ACTOR)}`,
          actorName: SYSTEM_ACTOR,
          from: current,
          to: name,
          ...(offlineFallback ? { reason: OFFLINE_FALLBACK_REASON } : {}),
        })
        // The activity entry is for whoever opens the conversation; this is
        // for the person who now has to answer it and may not be looking.
        await this.notifications.createAssignment({
          accountId: conversation.accountId,
          conversationId: conversation.id,
          assigneeId: picked.userId,
          // Distribution has no human actor, so the bell says "assigned to
          // you" instead of naming someone who did not choose it.
          assignedByUserId: null,
          previousAssigneeId: current,
          // Off shift: whoever can fix the coverage gap hears about it too.
          offlineFallback,
        })
      }
      return { assigneeId: picked.userId, pickedId: picked.userId }
    }

    // Nobody available. A team was set and the assignee is not part of it:
    // the team owns the conversation now, so it goes back to the queue.
    if (current !== null && conversation.teamId && !currentEligible) {
      const inTeam = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: conversation.teamId, userId: current } },
        select: { id: true },
      })
      if (!inTeam) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { assigneeId: null },
        })
        await this.activity.log(conversation, {
          type: 'assignee',
          text: `Conversation unassigned${ActivityService.by(SYSTEM_ACTOR)}`,
          actorName: SYSTEM_ACTOR,
          from: current,
          to: null,
        })
        // Nobody to tell, but the previous owner's bell must stop pointing here.
        await this.notifications.createAssignment({
          accountId: conversation.accountId,
          conversationId: conversation.id,
          assigneeId: null,
          assignedByUserId: null,
          previousAssigneeId: current,
        })
        return { assigneeId: null, pickedId: null }
      }
    }
    return unchanged
  }

  /**
   * Round robin: the available member who waited longest gets the
   * conversation. The claim is a compare-and-set on `lastAutoAssignedAt`, so
   * two conversations routed at the same instant go to different people; a
   * lost race moves on to the next in line.
   */
  private async claimNext(
    available: Candidate[],
    now: Date,
  ): Promise<Candidate | null> {
    const ordered = [...available].sort((a, b) => {
      const ta = a.lastAutoAssignedAt?.getTime() ?? -1
      const tb = b.lastAutoAssignedAt?.getTime() ?? -1
      return ta !== tb ? ta - tb : a.userId.localeCompare(b.userId)
    })
    for (const member of ordered) {
      const claimed = await this.prisma.accountMember.updateMany({
        where: { id: member.id, lastAutoAssignedAt: member.lastAutoAssignedAt },
        data: { lastAutoAssignedAt: now },
      })
      if (claimed.count === 1) return member
    }
    return null
  }
}
