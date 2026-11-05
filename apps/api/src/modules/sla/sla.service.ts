import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import * as Sentry from '@sentry/node'
import type { Conversation, Prisma, SlaPolicy } from '@cosmika/db'
import {
  CreateSlaPolicyInput,
  SlaMissDTO,
  SlaMissesQuery,
  SlaStatusDTO,
  UpdateSlaPolicyInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { NotificationsService } from '../notifications/notifications.service'
import { RealtimeService } from '../realtime/realtime.service'
import { WebhooksService } from '../webhooks/webhooks.service'
import { errBody } from '../../common/app-error'

@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  private async assertAdmin(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
  }

  async list(userId: string, accountId: string): Promise<SlaPolicy[]> {
    await this.assertMember(userId, accountId)
    return this.prisma.slaPolicy.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateSlaPolicyInput,
  ): Promise<SlaPolicy> {
    await this.assertAdmin(userId, accountId)
    return this.prisma.slaPolicy.create({
      data: { accountId, ...input },
    })
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateSlaPolicyInput,
  ): Promise<SlaPolicy> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.slaPolicy.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    const data: Prisma.SlaPolicyUpdateInput = { ...input }
    return this.prisma.slaPolicy.update({ where: { id }, data })
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.slaPolicy.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    await this.prisma.slaPolicy.delete({ where: { id } })
  }

  /**
   * Compute the SLA status for one conversation. Pure function from data —
   * call sites pass the conversation + policy + first-message time.
   *
   * Logic:
   *  - A conversation the bot is handling has no SLA: the clock is for the
   *    human queue.
   *  - firstResponse until `firstReplyAt` is set, then resolution.
   *  - firstResponse starts when the conversation entered the human queue
   *    (`queuedAt`, else `createdAt`); resolution starts at the first reply.
   *  - The target is the policy's seconds override for first response when
   *    set, else the minute target for the priority.
   *  - AT_RISK from 80% of the target, BREACHED once it has passed.
   *  - Resolved conversations: NOT_APPLICABLE.
   */
  computeStatus(
    conversation: Pick<
      Conversation,
      | 'priority'
      | 'status'
      | 'firstReplyAt'
      | 'resolvedAt'
      | 'createdAt'
    > &
      Partial<Pick<Conversation, 'controlMode' | 'queuedAt'>>,
    policy: SlaPolicy | null,
    now: Date = new Date(),
  ): SlaStatusDTO {
    if (!policy || conversation.status === 'RESOLVED' || conversation.controlMode === 'BOT') {
      return {
        state: 'NOT_APPLICABLE',
        dimension: null,
        targetAt: null,
        minutesRemaining: null,
        secondsRemaining: null,
      }
    }

    const isFirstResponse = conversation.firstReplyAt === null
    const dimension: 'firstResponse' | 'resolution' = isFirstResponse
      ? 'firstResponse'
      : 'resolution'

    const targetMs =
      isFirstResponse && policy.firstResponseSeconds
        ? policy.firstResponseSeconds * 1000
        : this.targetMinutes(policy, dimension, conversation.priority) * 60_000
    const start = isFirstResponse
      ? (conversation.queuedAt ?? conversation.createdAt)
      : (conversation.firstReplyAt as Date)

    const targetAt = new Date(start.getTime() + targetMs)
    const elapsedMs = now.getTime() - start.getTime()
    const remainingMs = targetMs - elapsedMs

    let state: SlaStatusDTO['state']
    if (elapsedMs >= targetMs) state = 'BREACHED'
    else if (elapsedMs >= targetMs * 0.8) state = 'AT_RISK'
    else state = 'ON_TRACK'

    return {
      state,
      dimension,
      targetAt: targetAt.toISOString(),
      minutesRemaining: Math.round(remainingMs / 60_000),
      secondsRemaining: Math.round(remainingMs / 1000),
    }
  }

  private targetMinutes(
    policy: SlaPolicy,
    dimension: 'firstResponse' | 'resolution',
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT',
  ): number {
    const key =
      dimension === 'firstResponse'
        ? `firstResponse${priority.charAt(0)}${priority.slice(1).toLowerCase()}Minutes`
        : `resolution${priority.charAt(0)}${priority.slice(1).toLowerCase()}Minutes`
    return (policy as unknown as Record<string, number>)[key] ?? 0
  }

  toDTO(p: SlaPolicy) {
    return {
      id: p.id,
      accountId: p.accountId,
      name: p.name,
      firstResponseLowMinutes: p.firstResponseLowMinutes,
      firstResponseNormalMinutes: p.firstResponseNormalMinutes,
      firstResponseHighMinutes: p.firstResponseHighMinutes,
      firstResponseUrgentMinutes: p.firstResponseUrgentMinutes,
      resolutionLowMinutes: p.resolutionLowMinutes,
      resolutionNormalMinutes: p.resolutionNormalMinutes,
      resolutionHighMinutes: p.resolutionHighMinutes,
      resolutionUrgentMinutes: p.resolutionUrgentMinutes,
      firstResponseSeconds: p.firstResponseSeconds,
      createdAt: p.createdAt.toISOString(),
    }
  }
  /**
   * Breach sweep, every 10 seconds. SLA status is otherwise computed only on
   * read, so nothing would tell anyone a conversation crossed into BREACHED.
   * For each open conversation on an inbox with a policy that hasn't been
   * flagged yet: compute its status and, the first time it is BREACHED, flag
   * it (an updateMany guard, so overlapping sweeps can't double-fire), alert
   * the people who can act, push a realtime event the desk turns into an
   * on-screen alarm, and dispatch `conversation.sla_breached`.
   *
   * Ten seconds is what makes a 60 s target useful: the alert lands at most
   * 10 s after the deadline. The query is narrow (not flagged, not resolved,
   * inbox with a policy) and indexed on the flag.
   */
  @Interval('sla-breach-sweep', 10_000)
  async sweepBreaches(now: Date = new Date()): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const candidates = await this.prisma.conversation.findMany({
        where: {
          status: { not: 'RESOLVED' },
          controlMode: { not: 'BOT' },
          slaBreachedNotifiedAt: null,
          inbox: { slaPolicyId: { not: null } },
        },
        include: { inbox: { include: { slaPolicy: true } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      })
      for (const conv of candidates) {
        const policy = (conv.inbox as { slaPolicy?: SlaPolicy | null }).slaPolicy ?? null
        const status = this.computeStatus(conv, policy, now)
        if (status.state !== 'BREACHED') continue
        const claimed = await this.prisma.conversation.updateMany({
          where: { id: conv.id, slaBreachedNotifiedAt: null },
          data: { slaBreachedNotifiedAt: now },
        })
        if (claimed.count === 0) continue
        const notified = await this.notifications.createSlaBreach({
          accountId: conv.accountId,
          conversationId: conv.id,
          assigneeId: conv.assigneeId,
          teamId: conv.teamId,
        })
        await this.realtime.publish({
          type: 'SlaBreached',
          accountId: conv.accountId,
          conversationId: conv.id,
          displayId: conv.displayId,
          inboxId: conv.inboxId,
          teamId: conv.teamId,
          assigneeId: conv.assigneeId,
          dimension: status.dimension,
          targetAt: status.targetAt,
          userIds: notified,
        })
        await this.webhooks.dispatch(conv.accountId, 'conversation.sla_breached', {
          conversationId: conv.id,
          inboxId: conv.inboxId,
          priority: conv.priority,
          dimension: status.dimension,
          targetAt: status.targetAt,
        })
      }
    } catch (err) {
      this.logger.error(
        `sla breach sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      Sentry.captureException(err)
    } finally {
      this.sweeping = false
    }
  }

  /**
   * The "missed conversations" report: every conversation flagged as having
   * crossed its first-response target, with when it entered the queue, its
   * deadline, when the breach was detected, and the sector (team, inbox) and
   * person it was with. Administrators and supervisors only.
   */
  async misses(userId: string, accountId: string, query: SlaMissesQuery): Promise<SlaMissDTO[]> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR' && m.role !== 'SUPERVISOR') {
      throw new ForbiddenException(errBody('supervisor_required', 'Supervisor role required'))
    }
    const to = query.to ?? new Date()
    const from = query.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000)
    const rows = await this.prisma.conversation.findMany({
      where: {
        accountId,
        slaBreachedNotifiedAt: { gte: from, lte: to },
        ...(query.teamId && { teamId: query.teamId }),
        ...(query.inboxId && { inboxId: query.inboxId }),
      },
      include: {
        inbox: { include: { slaPolicy: true } },
        team: { select: { name: true } },
        assignee: { select: { fullName: true, email: true } },
        contact: { select: { name: true } },
      },
      orderBy: { slaBreachedNotifiedAt: 'desc' },
      take: 1000,
    })
    return rows.map((c) => {
      const queuedAt = c.queuedAt ?? c.createdAt
      const policy = c.inbox.slaPolicy
      const targetMs = policy?.firstResponseSeconds
        ? policy.firstResponseSeconds * 1000
        : policy
          ? this.targetMinutes(policy, 'firstResponse', c.priority) * 60_000
          : 0
      return {
        conversationId: c.id,
        displayId: c.displayId,
        contactName: c.contact?.name ?? null,
        inboxName: c.inbox.name,
        teamName: c.team?.name ?? null,
        assigneeName: c.assignee ? (c.assignee.fullName ?? c.assignee.email) : null,
        queuedAt: queuedAt.toISOString(),
        targetAt: new Date(queuedAt.getTime() + targetMs).toISOString(),
        breachedAt: (c.slaBreachedNotifiedAt as Date).toISOString(),
        firstReplyAt: c.firstReplyAt?.toISOString() ?? null,
        status: c.status,
      }
    })
  }

  /** The same report as CSV (semicolon-separated, Excel-friendly in pt-BR). */
  missesCsv(rows: SlaMissDTO[]): string {
    const head = [
      'conversa', 'contato', 'setor', 'caixa', 'responsavel',
      'entrou_na_fila', 'prazo', 'estourou_em', 'primeira_resposta', 'status',
    ]
    const cell = (v: string | number | null) => {
      const s = v === null ? '' : String(v)
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = rows.map((r) =>
      [
        r.displayId, r.contactName, r.teamName, r.inboxName, r.assigneeName,
        r.queuedAt, r.targetAt, r.breachedAt, r.firstReplyAt, r.status,
      ].map(cell).join(';'),
    )
    return [head.join(';'), ...lines].join('\n') + '\n'
  }

  private sweeping = false
}
