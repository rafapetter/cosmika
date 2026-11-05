import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@cosmika/db'

import { newProtocol, protocolStillOpen } from '../common/protocol'

const CONNECT_TIMEOUT_MS = 30_000
const INITIAL_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 4_000

function buildDatabaseUrl(): string | undefined {
  const base = process.env.DATABASE_URL
  if (!base) return base
  const pool = process.env.DATABASE_POOL_SIZE
  if (!pool) return base
  // Prisma reads `connection_limit` from the query string.
  try {
    const url = new URL(base)
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', pool)
    }
    return url.toString()
  } catch {
    return base
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    const url = buildDatabaseUrl()
    super({
      // Only override the datasource when we actually have a URL. Passing
      // `{ url: undefined }` makes the PrismaClient constructor throw
      // "Invalid value undefined for datasource" before anything can report
      // what's really wrong; omitting it lets Prisma fall back to the
      // schema's env("DATABASE_URL") and fail at connect time with a message
      // that names the missing variable.
      ...(url ? { datasources: { db: { url } } } : {}),
      log:
        process.env.NODE_ENV === 'development'
          ? ['warn', 'error']
          : ['error'],
    })
  }

  /**
   * Keep `Conversation.lastMessageAt` in step with real message traffic.
   *
   * The inbox sorts on that column. Doing this here rather than at the ~19
   * call sites that create messages means a new one can't silently forget
   * it and leave conversations stuck at the bottom of the list.
   *
   * Activity notes are excluded on purpose: labelling or resolving an old
   * thread is not conversation activity, and bumping it would float 2021
   * conversations to the top of everyone's inbox — including when the
   * auto-resolve job closes them.
   *
   * Failures are swallowed: the message itself is the durable record, and a
   * missed sort-key update must never fail an inbound webhook.
   */
  private installLastMessageAtHook(): void {
    this.$use(async (params, next) => {
      const result = await next(params)
      if (params.model !== 'Message' || params.action !== 'create') return result
      try {
        const data = (params.args?.data ?? {}) as {
          conversationId?: string
          contentAttributes?: unknown
          createdAt?: Date | string
        }
        const attrs = (data.contentAttributes ?? {}) as Record<string, unknown>
        if (attrs && typeof attrs === 'object' && 'activity' in attrs) return result
        const conversationId =
          data.conversationId ??
          (result as { conversationId?: string } | null)?.conversationId
        if (!conversationId) return result
        const at =
          (result as { createdAt?: Date } | null)?.createdAt ??
          (data.createdAt ? new Date(data.createdAt) : new Date())
        await this.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: at },
        })
      } catch (err) {
        this.logger.warn(
          `lastMessageAt update skipped: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return result
    })
  }

  /**
   * Stamp `Conversation.queuedAt` whenever a write hands control to a human.
   *
   * The first-response SLA clock starts when a conversation enters the human
   * queue, not while a bot is talking. Control flips to HUMAN from several
   * places (flow handoff, AI handoff, assignment); stamping it here means a
   * new path can't forget the clock. A write that sets queuedAt itself wins.
   */
  private installQueuedAtHook(): void {
    this.$use(async (params, next) => {
      if (
        params.model === 'Conversation' &&
        (params.action === 'update' || params.action === 'updateMany')
      ) {
        const data = params.args?.data as Record<string, unknown> | undefined
        if (data && data.controlMode === 'HUMAN' && data.queuedAt === undefined) {
          // Only a real handover starts the clock: reassigning a conversation
          // that is already with a person (which also writes HUMAN) must not
          // reset its SLA. Unknown state (no id, lookup failed) stamps.
          const id = (params.args?.where as { id?: unknown } | undefined)?.id
          let alreadyHuman = false
          if (params.action === 'update' && typeof id === 'string') {
            try {
              const current = await this.conversation.findUnique({
                where: { id },
                select: { controlMode: true },
              })
              alreadyHuman = current?.controlMode === 'HUMAN'
            } catch {
              alreadyHuman = false
            }
          }
          if (!alreadyHuman) data.queuedAt = new Date()
        }
      }
      return next(params)
    })
  }

  /**
   * Give every new conversation its service protocol: the one the contact's
   * latest conversation carries when that case is still open (or closed less
   * than 24 h ago), on any channel; otherwise a fresh one. Done here so no
   * creation path (widget, WhatsApp, Telegram, Meta, desk, broadcasts) can
   * forget it. A create that sets `protocol` itself wins.
   *
   * The lookup reads committed rows outside any surrounding transaction, which
   * is what we want: the previous conversation is long committed. A failed
   * lookup falls back to a fresh protocol rather than failing the insert.
   */
  private installProtocolHook(): void {
    this.$use(async (params, next) => {
      if (params.model !== 'Conversation' || params.action !== 'create') return next(params)
      const data = params.args?.data as Record<string, unknown> | undefined
      if (!data || data.protocol !== undefined) return next(params)
      const rel = (v: unknown) => (v as { connect?: { id?: string } } | undefined)?.connect?.id
      const contactId = (data.contactId as string | undefined) ?? rel(data.contact)
      const accountId = (data.accountId as string | undefined) ?? rel(data.account)
      let protocol: string | null = null
      if (contactId && accountId) {
        try {
          const previous = await this.conversation.findFirst({
            where: { accountId, contactId, protocol: { not: null } },
            orderBy: { createdAt: 'desc' },
            select: { protocol: true, status: true, resolvedAt: true },
          })
          if (previous && protocolStillOpen(previous)) protocol = previous.protocol
        } catch (err) {
          this.logger.warn(
            `protocol lookup skipped: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      data.protocol = protocol ?? newProtocol()
      return next(params)
    })
  }

  /**
   * Retry $connect for up to CONNECT_TIMEOUT_MS with exponential backoff.
   * Containers brought up next to a slow-starting Postgres race the api;
   * without retry the api crashes immediately and orchestrators see it as
   * a flapping service.
   */
  async onModuleInit() {
    this.installLastMessageAtHook()
    this.installQueuedAtHook()
    this.installProtocolHook()
    const started = Date.now()
    let attempt = 0
    let delay = INITIAL_BACKOFF_MS
    while (true) {
      attempt += 1
      try {
        await this.$connect()
        if (attempt > 1) {
          this.logger.log(
            `connected to Postgres after ${attempt} attempts (${Date.now() - started}ms)`,
          )
        }
        return
      } catch (err) {
        if (Date.now() - started >= CONNECT_TIMEOUT_MS) {
          this.logger.error(
            `Postgres unreachable after ${attempt} attempts (${Date.now() - started}ms); giving up`,
          )
          throw err
        }
        this.logger.warn(
          `Postgres not reachable (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)} — retrying in ${delay}ms`,
        )
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, MAX_BACKOFF_MS)
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
