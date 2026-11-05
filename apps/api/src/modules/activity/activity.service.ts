import { Injectable } from '@nestjs/common'
import { Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'

// Activity notes in the transcript (Nebula parity). Agents expect to see
// "resolved by Ana", "label Urgente added", "auto-resolved after 30 days"
// inline with the conversation rather than in a separate audit log.
//
// These are SYSTEM messages: the web thread renders them as a centered pill
// and they are NEVER delivered to the contact — outbound delivery only
// happens on the explicit send path, and this writes the row directly.
//
// Shared by conversations (status/assignee/team/priority), labels, and the
// auto-resolve job, so the wording and the "never break the caller" contract
// live in exactly one place.

/** Non-human actors, mirroring Nebula's attribution. */
export const SYSTEM_ACTOR = 'Automation System'

export type ActivityType = 'status' | 'assignee' | 'team' | 'priority' | 'label'

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Resolve a user's display name for attribution; null when unknown. */
  async actorName(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    })
    return u?.fullName ?? null
  }

  /** ` by X` suffix, or '' when the actor is unknown. */
  static by(actorName: string | null): string {
    return actorName ? ` by ${actorName}` : ''
  }

  async log(
    conversation: { id: string; inboxId: string; accountId: string },
    activity: {
      type: ActivityType
      text: string
      actorName?: string | null
      from?: string | null
      to?: string | null
      /**
       * Why an automatic entry happened, when "the system did it" is not the
       * whole story. Distribution uses it to mark an assignment that only
       * happened because nobody was on shift, so a report reading these rows
       * can tell that apart from a normal round robin.
       */
      reason?: string | null
    },
  ): Promise<void> {
    try {
      const message = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          inboxId: conversation.inboxId,
          accountId: conversation.accountId,
          senderType: 'SYSTEM',
          content: activity.text,
          contentType: 'TEXT',
          // Structured facts so the UI can localise later without a data
          // migration; `content` is the frozen human-readable fallback.
          contentAttributes: {
            activity: {
              type: activity.type,
              actorName: activity.actorName ?? null,
              from: activity.from ?? null,
              to: activity.to ?? null,
              reason: activity.reason ?? null,
            },
          } as Prisma.InputJsonValue,
          isPrivate: false,
          status: 'SENT',
        },
      })
      await this.realtime.publish({
        type: 'MessageCreated',
        accountId: conversation.accountId,
        conversationId: conversation.id,
        inboxId: conversation.inboxId,
        messageId: message.id,
        senderType: 'SYSTEM',
        content: message.content,
        isPrivate: false,
        createdAt: message.createdAt.toISOString(),
      })
    } catch (err) {
      // An activity note must never break the action it describes.
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[activity] failed for ${conversation.id}:`, m)
    }
  }
}
