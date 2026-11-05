import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import type { Role } from '@cosmika/db'
import { Prisma } from '@cosmika/db'
import {
  BreakdownQuery,
  BreakdownResponse,
  BreakdownRow,
  LeaderboardEntry,
  LeaderboardQuery,
  OverviewQuery,
  OverviewResponse,
  TimeseriesPoint,
  TimeseriesQuery,
  TimeseriesResponse,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const PRIVILEGED_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']
// Generous so the "All time" report can span migrated-from-Nebula history
// (conversations keep their original dates, often years old). Aggregate
// queries are indexed by accountId+createdAt; revisit if a very large account
// is onboarded.
const MAX_RANGE_DAYS = 4500
const DEFAULT_RANGE_DAYS = 30

type DateRange = { fromISO: string; toISO: string; from: Date; to: Date }

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertPrivileged(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (!PRIVILEGED_ROLES.includes(m.role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  private resolveRange(
    fromISO: string | undefined,
    toISO: string | undefined,
  ): DateRange {
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const defaultFrom = new Date(today)
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - DEFAULT_RANGE_DAYS + 1)

    const from = fromISO ? new Date(`${fromISO}T00:00:00.000Z`) : defaultFrom
    // `to` is end-of-day exclusive: range covers up to and including `toISO`.
    const toBase = toISO ? new Date(`${toISO}T00:00:00.000Z`) : today
    const to = new Date(toBase)
    to.setUTCDate(to.getUTCDate() + 1)

    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException(errBody('invalid_date_range', 'Invalid date range'))
    }
    const days = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(errBody('range_too_large', `Range too large (max ${MAX_RANGE_DAYS} days)`))
    }
    return {
      fromISO: from.toISOString().slice(0, 10),
      toISO: new Date(to.getTime() - 1).toISOString().slice(0, 10),
      from,
      to,
    }
  }

  // ─── overview ──────────────────────────────────────────────────

  async overview(
    userId: string,
    accountId: string,
    query: OverviewQuery,
  ): Promise<OverviewResponse> {
    await this.assertPrivileged(userId, accountId)
    const range = this.resolveRange(query.from, query.to)

    const where: Prisma.ConversationWhereInput = {
      accountId,
      createdAt: { gte: range.from, lt: range.to },
      ...(query.inboxId && { inboxId: query.inboxId }),
      ...(query.teamId && { teamId: query.teamId }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
    }

    const [totalCount, statusGroups, sentimentGroups, conversations] =
      await Promise.all([
        this.prisma.conversation.count({ where }),
        this.prisma.conversation.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.conversation.groupBy({
          by: ['aiSentiment'],
          where,
          _count: { _all: true },
        }),
        this.prisma.conversation.findMany({
          where,
          select: {
            createdAt: true,
            firstReplyAt: true,
            resolvedAt: true,
            aiTags: true,
          },
        }),
      ])

    const statusCounts = {
      open: 0,
      pending: 0,
      resolved: 0,
    }
    for (const g of statusGroups) {
      const key = g.status.toLowerCase() as keyof typeof statusCounts
      if (key in statusCounts) statusCounts[key] = g._count._all
    }

    const sentimentBreakdown = {
      positive: 0,
      neutral: 0,
      negative: 0,
      unknown: 0,
    }
    for (const g of sentimentGroups) {
      if (g.aiSentiment === 'POSITIVE') sentimentBreakdown.positive = g._count._all
      else if (g.aiSentiment === 'NEUTRAL') sentimentBreakdown.neutral = g._count._all
      else if (g.aiSentiment === 'NEGATIVE') sentimentBreakdown.negative = g._count._all
      else sentimentBreakdown.unknown = g._count._all
    }

    // Per-conversation response + resolution durations.
    const firstResponseSeconds: number[] = []
    const resolutionSeconds: number[] = []
    const tagCounts = new Map<string, number>()
    for (const c of conversations) {
      if (c.firstReplyAt) {
        firstResponseSeconds.push(
          Math.max(
            0,
            (c.firstReplyAt.getTime() - c.createdAt.getTime()) / 1000,
          ),
        )
      }
      if (c.resolvedAt) {
        resolutionSeconds.push(
          Math.max(
            0,
            (c.resolvedAt.getTime() - c.createdAt.getTime()) / 1000,
          ),
        )
      }
      for (const tag of c.aiTags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    // Messages by sender — over the same range, scoped to this account.
    const messageGroups = await this.prisma.message.groupBy({
      by: ['senderType'],
      where: {
        accountId,
        createdAt: { gte: range.from, lt: range.to },
        ...(query.inboxId && { inboxId: query.inboxId }),
      },
      _count: { _all: true },
    })
    const messagesBySender = {
      CONTACT: 0,
      USER: 0,
      AGENT_BOT: 0,
      SYSTEM: 0,
    }
    for (const g of messageGroups) {
      messagesBySender[g.senderType] = g._count._all
    }

    // AI usage — sum across sessions active in range.
    const aiAgg = await this.prisma.aiAgentSession.aggregate({
      where: {
        accountId,
        lastActiveAt: { gte: range.from, lt: range.to },
      },
      _sum: {
        totalCostUsd: true,
        totalTokensIn: true,
        totalTokensOut: true,
      },
      _count: { _all: true },
    })

    return {
      from: range.fromISO,
      to: range.toISO,
      totalConversations: totalCount,
      statusCounts,
      avgFirstResponseSeconds: avg(firstResponseSeconds),
      medianFirstResponseSeconds: median(firstResponseSeconds),
      avgResolutionSeconds: avg(resolutionSeconds),
      sentimentBreakdown,
      topTags,
      ai: {
        totalCostUsd: aiAgg._sum.totalCostUsd
          ? Number(aiAgg._sum.totalCostUsd)
          : 0,
        totalTokensIn: aiAgg._sum.totalTokensIn ?? 0,
        totalTokensOut: aiAgg._sum.totalTokensOut ?? 0,
        sessions: aiAgg._count._all,
      },
      messagesBySender,
    }
  }

  // ─── timeseries ────────────────────────────────────────────────

  async timeseries(
    userId: string,
    accountId: string,
    query: TimeseriesQuery,
  ): Promise<TimeseriesResponse> {
    await this.assertPrivileged(userId, accountId)
    const range = this.resolveRange(query.from, query.to)
    const bucketSql = query.bucket === 'week' ? 'week' : 'day'

    let points: TimeseriesPoint[] = []
    if (query.metric === 'conversations') {
      const rows = await this.prisma.$queryRaw<
        Array<{ bucket: Date; value: bigint }>
      >`
        SELECT date_trunc(${bucketSql}::text, "createdAt") AS bucket,
               COUNT(*)::bigint AS value
        FROM "Conversation"
        WHERE "accountId" = ${accountId}
          AND "createdAt" >= ${range.from}
          AND "createdAt" <  ${range.to}
          ${query.inboxId ? Prisma.sql`AND "inboxId" = ${query.inboxId}` : Prisma.empty}
          ${query.teamId ? Prisma.sql`AND "teamId" = ${query.teamId}` : Prisma.empty}
          ${query.assigneeId ? Prisma.sql`AND "assigneeId" = ${query.assigneeId}` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1
      `
      points = rows.map((r) => ({
        bucket: r.bucket.toISOString().slice(0, 10),
        value: Number(r.value),
      }))
    } else if (query.metric === 'messages') {
      const rows = await this.prisma.$queryRaw<
        Array<{ bucket: Date; value: bigint }>
      >`
        SELECT date_trunc(${bucketSql}::text, "createdAt") AS bucket,
               COUNT(*)::bigint AS value
        FROM "Message"
        WHERE "accountId" = ${accountId}
          AND "createdAt" >= ${range.from}
          AND "createdAt" <  ${range.to}
          ${query.inboxId ? Prisma.sql`AND "inboxId" = ${query.inboxId}` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1
      `
      points = rows.map((r) => ({
        bucket: r.bucket.toISOString().slice(0, 10),
        value: Number(r.value),
      }))
    } else {
      // first_response_avg in SECONDS, bucketed by conversation createdAt.
      const rows = await this.prisma.$queryRaw<
        Array<{ bucket: Date; value: number | null }>
      >`
        SELECT date_trunc(${bucketSql}::text, "createdAt") AS bucket,
               AVG(EXTRACT(EPOCH FROM ("firstReplyAt" - "createdAt"))) AS value
        FROM "Conversation"
        WHERE "accountId" = ${accountId}
          AND "firstReplyAt" IS NOT NULL
          AND "createdAt" >= ${range.from}
          AND "createdAt" <  ${range.to}
          ${query.inboxId ? Prisma.sql`AND "inboxId" = ${query.inboxId}` : Prisma.empty}
          ${query.teamId ? Prisma.sql`AND "teamId" = ${query.teamId}` : Prisma.empty}
          ${query.assigneeId ? Prisma.sql`AND "assigneeId" = ${query.assigneeId}` : Prisma.empty}
        GROUP BY 1
        ORDER BY 1
      `
      points = rows.map((r) => ({
        bucket: r.bucket.toISOString().slice(0, 10),
        value: r.value !== null ? Number(r.value) : 0,
      }))
    }

    return {
      metric: query.metric,
      bucket: query.bucket,
      from: range.fromISO,
      to: range.toISO,
      points,
    }
  }

  // ─── agent leaderboard ─────────────────────────────────────────

  async leaderboard(
    userId: string,
    accountId: string,
    query: LeaderboardQuery,
  ): Promise<{ from: string; to: string; entries: LeaderboardEntry[] }> {
    await this.assertPrivileged(userId, accountId)
    const range = this.resolveRange(query.from, query.to)

    const rows = await this.prisma.$queryRaw<
      Array<{
        userId: string
        email: string
        fullName: string | null
        resolvedCount: bigint
        avgFirstResponseSeconds: number | null
      }>
    >`
      SELECT u."id"        AS "userId",
             u."email"     AS "email",
             u."fullName"  AS "fullName",
             COUNT(c."id")::bigint AS "resolvedCount",
             AVG(EXTRACT(EPOCH FROM (c."firstReplyAt" - c."createdAt"))) AS "avgFirstResponseSeconds"
      FROM "Conversation" c
      JOIN "User" u ON u."id" = c."assigneeId"
      WHERE c."accountId" = ${accountId}
        AND c."status" = 'RESOLVED'
        AND c."resolvedAt" >= ${range.from}
        AND c."resolvedAt" <  ${range.to}
      GROUP BY u."id", u."email", u."fullName"
      ORDER BY "resolvedCount" DESC, u."email" ASC
      LIMIT 50
    `

    const entries: LeaderboardEntry[] = rows.map((r) => ({
      userId: r.userId,
      userEmail: r.email,
      userFullName: r.fullName,
      resolvedCount: Number(r.resolvedCount),
      avgFirstResponseSeconds:
        r.avgFirstResponseSeconds !== null
          ? Number(r.avgFirstResponseSeconds)
          : null,
    }))
    return { from: range.fromISO, to: range.toISO, entries }
  }

  // ─── breakdown (by inbox / team / agent) ───────────────────────

  /**
   * Conversation volume + status split + avg durations grouped by one
   * dimension. This is the "by inbox / by team / by agent" depth Nebula's
   * reports had. team/agent use LEFT JOIN so rows with no team/assignee still
   * appear under an "Unassigned" label (id null).
   */
  async breakdown(
    userId: string,
    accountId: string,
    query: BreakdownQuery,
  ): Promise<BreakdownResponse> {
    await this.assertPrivileged(userId, accountId)
    const range = this.resolveRange(query.from, query.to)

    const dim =
      query.dimension === 'inbox'
        ? {
            group: Prisma.sql`c."inboxId"`,
            join: Prisma.sql`JOIN "Inbox" x ON x."id" = c."inboxId"`,
            label: Prisma.sql`x."name"`,
          }
        : query.dimension === 'team'
          ? {
              group: Prisma.sql`c."teamId"`,
              join: Prisma.sql`LEFT JOIN "Team" x ON x."id" = c."teamId"`,
              label: Prisma.sql`COALESCE(x."name", 'Unassigned')`,
            }
          : {
              group: Prisma.sql`c."assigneeId"`,
              join: Prisma.sql`LEFT JOIN "User" x ON x."id" = c."assigneeId"`,
              label: Prisma.sql`COALESCE(x."fullName", x."email", 'Unassigned')`,
            }

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string | null
        label: string
        total: bigint
        open: bigint
        pending: bigint
        resolved: bigint
        avgFirstResponseSeconds: number | null
        avgResolutionSeconds: number | null
      }>
    >`
      SELECT ${dim.group} AS id,
             ${dim.label} AS label,
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE c."status" = 'OPEN')::bigint AS open,
             COUNT(*) FILTER (WHERE c."status" = 'PENDING')::bigint AS pending,
             COUNT(*) FILTER (WHERE c."status" = 'RESOLVED')::bigint AS resolved,
             AVG(EXTRACT(EPOCH FROM (c."firstReplyAt" - c."createdAt"))) AS "avgFirstResponseSeconds",
             AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."createdAt"))) AS "avgResolutionSeconds"
      FROM "Conversation" c
      ${dim.join}
      WHERE c."accountId" = ${accountId}
        AND c."createdAt" >= ${range.from}
        AND c."createdAt" <  ${range.to}
      GROUP BY 1, 2
      ORDER BY total DESC, label ASC
      LIMIT 200
    `

    const mapped: BreakdownRow[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      total: Number(r.total),
      open: Number(r.open),
      pending: Number(r.pending),
      resolved: Number(r.resolved),
      avgFirstResponseSeconds:
        r.avgFirstResponseSeconds !== null
          ? Number(r.avgFirstResponseSeconds)
          : null,
      avgResolutionSeconds:
        r.avgResolutionSeconds !== null
          ? Number(r.avgResolutionSeconds)
          : null,
    }))

    return {
      from: range.fromISO,
      to: range.toISO,
      dimension: query.dimension,
      rows: mapped,
    }
  }

  /** Render a breakdown as a downloadable CSV (RFC-4180 quoting). */
  async breakdownCsv(
    userId: string,
    accountId: string,
    query: BreakdownQuery,
  ): Promise<string> {
    const report = await this.breakdown(userId, accountId, query)
    const header = [
      query.dimension,
      'total',
      'open',
      'pending',
      'resolved',
      'avg_first_response_seconds',
      'avg_resolution_seconds',
    ]
    const lines = [header.map(csvCell).join(',')]
    for (const r of report.rows) {
      lines.push(
        [
          r.label,
          r.total,
          r.open,
          r.pending,
          r.resolved,
          r.avgFirstResponseSeconds === null
            ? ''
            : Math.round(r.avgFirstResponseSeconds),
          r.avgResolutionSeconds === null
            ? ''
            : Math.round(r.avgResolutionSeconds),
        ]
          .map(csvCell)
          .join(','),
      )
    }
    return lines.join('\r\n')
  }
}

function csvCell(value: string | number): string {
  const s = String(value)
  // Quote when the value contains a comma, quote, or newline; escape quotes by doubling.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  /* c8 ignore next -- defensive: sorted[mid] always defined when sorted is non-empty (length-0 returned above) */
  if (sorted.length % 2 === 1) return sorted[mid] ?? null
  const left = sorted[mid - 1]
  const right = sorted[mid]
  /* c8 ignore next -- defensive: even-length array with 0 < mid <= length guarantees both indices in bounds */
  if (left === undefined || right === undefined) return null
  return (left + right) / 2
}
