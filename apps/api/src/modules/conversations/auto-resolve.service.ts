import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { AUTO_RESOLVE_MAX_MINUTES } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { ActivityService, SYSTEM_ACTOR } from '../activity/activity.service'
import { RealtimeService } from '../realtime/realtime.service'

// Auto-resolve idle conversations (Nebula parity).
//
// Nebula runs this every 5 minutes off `account.auto_resolve_duration` (all 18
// accounts have it set, most at 30 days). Cosmika stored the equivalent
// setting per inbox as `autoResolveMinutes` but nothing ever read it, so open
// queues grew without bound.
//
// Deliberate differences from Nebula, both to avoid a first-run stampede:
//   · NO CSAT survey. Nebula's resolve path triggers one; firing surveys at
//     thousands of customers who went quiet weeks ago would be spam. We write
//     the status directly rather than going through the normal resolve path.
//   · NO outbound webhook per conversation, for the same flood reason.
// The realtime event and the transcript activity note ARE emitted, so agents
// and open UIs see the change.
//
// Every conversation still in progress is eligible, OPEN or PENDING. Nebula
// spared PENDING because there it meant "the bot owns the turn"; here a bot
// conversation is OPEN like any other, and PENDING is only a status someone
// set by hand or by a rule. Sparing it would leave conversations that never
// close, which the published Terms rule out: nothing stays open past 7 days,
// and a contact who writes after the close starts a new conversation.
//
// The window is clamped to that 7-day ceiling here as well as in the input
// schema, so a value written straight to the database cannot stretch it.

const BATCH_PER_INBOX = 200

@Injectable()
export class AutoResolveService {
  private readonly logger = new Logger(AutoResolveService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly activity: ActivityService,
  ) {}

  private enabled(): boolean {
    // Kill switch for a job that mass-mutates conversations.
    return process.env.COSMIKA_AUTO_RESOLVE !== '0'
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (!this.enabled()) return
    try {
      await this.sweep()
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`auto-resolve sweep failed: ${m}`)
    }
  }

  /** Returns how many conversations were resolved (exposed for tests/ops). */
  async sweep(now: Date = new Date()): Promise<number> {
    const inboxes = await this.prisma.inbox.findMany({
      where: { autoResolveMinutes: { gt: 0 } },
      select: { id: true, accountId: true, autoResolveMinutes: true },
    })
    let total = 0
    for (const inbox of inboxes) {
      const minutes = Math.min(inbox.autoResolveMinutes, AUTO_RESOLVE_MAX_MINUTES)
      const cutoff = new Date(now.getTime() - minutes * 60_000)
      const stale = await this.prisma.conversation.findMany({
        where: {
          inboxId: inbox.id,
          status: { in: ['OPEN', 'PENDING'] },
          // No message since the cutoff...
          messages: { none: { createdAt: { gte: cutoff } } },
          // ...and old enough itself, so a conversation created seconds ago
          // with no messages yet is never swept.
          createdAt: { lt: cutoff },
        },
        select: { id: true, inboxId: true, accountId: true },
        take: BATCH_PER_INBOX,
      })
      for (const conv of stale) {
        await this.resolve(conv, minutes, now)
        total++
      }
    }
    if (total > 0) this.logger.log(`auto-resolved ${total} idle conversation(s)`)
    return total
  }

  private async resolve(
    conv: { id: string; inboxId: string; accountId: string },
    minutes: number,
    now: Date,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: now,
        // Nebula clears the assignee on auto-resolve so the conversation
        // doesn't keep counting against an agent's load.
        assigneeId: null,
      },
    })
    await this.realtime.publish({
      type: 'ConversationStatusChanged',
      accountId: conv.accountId,
      conversationId: conv.id,
      status: 'RESOLVED',
      changedAt: now.toISOString(),
    })
    await this.activity.log(conv, {
      type: 'status',
      text: `Conversation auto-resolved after ${describeIdle(minutes)} of inactivity`,
      actorName: SYSTEM_ACTOR,
      from: 'OPEN',
      to: 'RESOLVED',
      // Lets the thread say "closed for inactivity" in the account language
      // instead of relying on the English sentence above.
      reason: 'inactivity',
    })
  }
}

/** "30 days" / "12 hours" / "45 minutes" — whichever unit reads naturally. */
export function describeIdle(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24)
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}
