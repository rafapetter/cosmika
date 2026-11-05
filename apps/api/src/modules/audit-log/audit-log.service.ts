import { Injectable } from '@nestjs/common'
import type { AuditLog, Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'

type AuditLogWithActor = Prisma.AuditLogGetPayload<{
  include: {
    actor: {
      select: { id: true; email: true; fullName: true }
    }
  }
}>

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    accountId: string
    actorId: string | null
    action: string
    target?: string | null
    metadata?: unknown
  }): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        accountId: input.accountId,
        actorId: input.actorId,
        action: input.action,
        target: input.target ?? null,
        metadata:
          input.metadata === undefined
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
      },
    })
  }

  async list(
    accountId: string,
    opts: {
      cursor?: string
      limit?: number
      action?: string
      actorId?: string
      from?: string
      to?: string
    },
  ): Promise<{ items: AuditLogWithActor[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 100)
    const createdAt: Prisma.DateTimeFilter = {}
    if (opts.from) createdAt.gte = new Date(opts.from)
    if (opts.to) createdAt.lt = new Date(opts.to)
    const items = await this.prisma.auditLog.findMany({
      where: {
        accountId,
        ...(opts.action ? { action: opts.action } : {}),
        ...(opts.actorId ? { actorId: opts.actorId } : {}),
        ...(opts.from || opts.to ? { createdAt } : {}),
      },
      include: {
        actor: { select: { id: true, email: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
    // We requested `take: limit + 1`. If we got that many back, the
    // overflow row is the cursor for the next page; if we got fewer,
    // we're at the end. `items[limit - 1]` is guaranteed defined inside
    // the `>` branch — no need for `?? null`.
    const nextCursor = items.length > limit ? items[limit - 1]!.id : null
    return { items: items.slice(0, limit), nextCursor }
  }

  toDTO(row: AuditLogWithActor) {
    return {
      id: row.id,
      accountId: row.accountId,
      actor: row.actor
        ? {
            id: row.actor.id,
            email: row.actor.email,
            fullName: row.actor.fullName,
          }
        : null,
      action: row.action,
      target: row.target,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
