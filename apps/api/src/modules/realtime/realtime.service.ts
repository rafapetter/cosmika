import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'

import { PrismaService } from '../../prisma/prisma.service'

/** How long an account's team-scoping flag is trusted before re-reading it. */
const TEAM_SCOPE_CACHE_MS = 30_000

export type MessageCreatedEvent = {
  type: 'MessageCreated'
  accountId: string
  conversationId: string
  inboxId: string
  messageId: string
  senderType: string
  content: string | null
  isPrivate: boolean
  createdAt: string
}

export type ConversationStatusChangedEvent = {
  type: 'ConversationStatusChanged'
  accountId: string
  conversationId: string
  status: string
  changedAt: string
}

/** An AI suggestion the agent discarded; open threads should drop it. */
export type MessageDeletedEvent = {
  type: 'MessageDeleted'
  accountId: string
  conversationId: string
  messageId: string
}

/**
 * A Meta delivery receipt advanced an outbound message's status
 * (SENT→DELIVERED→READ, or FAILED with the provider's error). Open threads
 * update the ticks without a reload.
 */
export type MessageStatusChangedEvent = {
  type: 'MessageStatusChanged'
  accountId: string
  conversationId: string
  inboxId: string
  messageId: string
  status: string
}

/**
 * A reaction was put on, changed or taken off a message (the contact's from
 * WhatsApp, or ours). `reactions` is the message's whole set after the change,
 * keyed by side, so a thread just replaces what it had.
 */
export type MessageReactionChangedEvent = {
  type: 'MessageReactionChanged'
  accountId: string
  conversationId: string
  inboxId: string
  messageId: string
  reactions: Record<string, unknown>
}

/**
 * A conversation came into existence — agent-created, forwarded, or opened
 * by an inbound customer message. The console list refetches on this; without
 * it a new conversation is invisible until a manual refresh.
 */
export type ConversationCreatedEvent = {
  type: 'ConversationCreated'
  accountId: string
  conversationId: string
  inboxId: string
  contactId: string | null
  createdAt: string
}

/**
 * A conversation crossed its SLA without the first reply. `userIds` are the
 * people the alert is for (assignee, else the team, plus administrators and
 * supervisors); the desk raises an on-screen alarm for them.
 */
export type SlaBreachedEvent = {
  type: 'SlaBreached'
  accountId: string
  conversationId: string
  displayId: number
  inboxId: string
  teamId: string | null
  assigneeId: string | null
  dimension: 'firstResponse' | 'resolution' | null
  targetAt: string | null
  userIds: string[]
}

export type RealtimeEvent =
  | MessageCreatedEvent
  | SlaBreachedEvent
  | ConversationStatusChangedEvent
  | MessageDeletedEvent
  | MessageStatusChangedEvent
  | MessageReactionChangedEvent
  | ConversationCreatedEvent

/**
 * Publishes events to Redis Pub/Sub on channel `account:<accountId>`.
 * The Go realtime gateway subscribes per WebSocket connection and pushes
 * matching events to the browser. Pub/Sub is fire-and-forget: subscribers
 * that aren't connected won't see missed events. That's acceptable for
 * "live UI nudge" semantics — durable delivery is the message table.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name)
  private redis: Redis | null = null

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /** accountId → whether its agents only see their teams (cached briefly). */
  private readonly teamScopedCache = new Map<string, { value: boolean; at: number }>()

  /**
   * With team-scoped visibility, the gateway still fans events out to the
   * whole account, so an event must not carry what another team may not see.
   * The desk refetches through the (filtered) API on every event and never
   * reads the text from it, so the message body is simply left out.
   */
  private async redactForTeams(event: RealtimeEvent): Promise<RealtimeEvent> {
    if (!('content' in event) || event.content === null || !this.prisma) return event
    const now = Date.now()
    let cached = this.teamScopedCache.get(event.accountId)
    if (!cached || now - cached.at > TEAM_SCOPE_CACHE_MS) {
      const account = await this.prisma.account
        .findUnique({ where: { id: event.accountId }, select: { teamScopedVisibility: true } })
        .catch(() => null)
      cached = { value: account?.teamScopedVisibility === true, at: now }
      this.teamScopedCache.set(event.accountId, cached)
    }
    return cached.value ? { ...event, content: null } : event
  }

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379'
    this.redis = new Redis(url, { lazyConnect: true })
    this.redis.on('error', (err) =>
      this.logger.error(`redis error: ${err.message}`),
    )
    // lazyConnect — first publish triggers the connect.
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined)
    }
  }

  async publish(event: RealtimeEvent): Promise<void> {
    if (!this.redis) return
    try {
      await this.redis.publish(
        `account:${event.accountId}`,
        JSON.stringify(await this.redactForTeams(event)),
      )
    } catch (err) {
      // Never fail the calling request because of a Redis hiccup.
      this.logger.error(
        `publish error for ${event.accountId}: ${(err as Error).message}`,
      )
    }
  }
}
