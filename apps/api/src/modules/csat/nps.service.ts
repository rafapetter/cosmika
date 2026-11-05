import { ForbiddenException, Injectable } from '@nestjs/common'
import type { Prisma } from '@cosmika/db'
import type { NpsBucket, NpsQuery, NpsStats, NpsSummary, SurveyType } from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { PrismaService } from '../../prisma/prisma.service'

/** Standard NPS bands: 9-10 promoter, 7-8 passive, 0-6 detractor. */
export function summarizeNps(scores: number[]): NpsSummary {
  let promoters = 0
  let passives = 0
  let detractors = 0
  for (const s of scores) {
    if (s >= 9) promoters += 1
    else if (s >= 7) passives += 1
    else detractors += 1
  }
  const responses = scores.length
  return {
    responses,
    promoters,
    passives,
    detractors,
    nps: responses === 0 ? null : Math.round(((promoters - detractors) / responses) * 100),
  }
}

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * NPS (PoC item 14): which survey type the account sends on resolve, and the
 * NPS report by team and by agent. Reads the same CsatSurvey rows as the
 * CSAT report, filtered to type NPS.
 */
@Injectable()
export class NpsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(userId: string, accountId: string): Promise<{ surveyType: SurveyType }> {
    await this.membership(userId, accountId)
    const a = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { surveyType: true },
    })
    return { surveyType: a.surveyType }
  }

  async setSettings(
    userId: string,
    accountId: string,
    surveyType: SurveyType,
  ): Promise<{ surveyType: SurveyType; previous: SurveyType }> {
    const m = await this.membership(userId, accountId)
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator required'))
    }
    const before = await this.prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { surveyType: true },
    })
    await this.prisma.account.update({ where: { id: accountId }, data: { surveyType } })
    return { surveyType, previous: before.surveyType }
  }

  async stats(userId: string, accountId: string, q: NpsQuery): Promise<NpsStats> {
    await this.membership(userId, accountId)
    const where: Prisma.CsatSurveyWhereInput = {
      accountId,
      type: 'NPS',
      ...(q.inboxId ? { inboxId: q.inboxId } : {}),
      ...(q.teamId ? { teamId: q.teamId } : {}),
      ...(q.agentId ? { assignedAgentId: q.agentId } : {}),
      ...(q.from || q.to
        ? {
            promptedAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lt: new Date(q.to) } : {}),
            },
          }
        : {}),
    }
    const [totalPrompted, rows] = await Promise.all([
      this.prisma.csatSurvey.count({ where }),
      this.prisma.csatSurvey.findMany({
        where: { ...where, respondedAt: { not: null }, rating: { not: null } },
        select: { rating: true, teamId: true, assignedAgentId: true },
      }),
    ])

    const teamIds = [...new Set(rows.map((r) => r.teamId).filter((v): v is string => !!v))]
    const agentIds = [...new Set(rows.map((r) => r.assignedAgentId).filter((v): v is string => !!v))]
    const [teams, agents] = await Promise.all([
      teamIds.length
        ? this.prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      agentIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, fullName: true, email: true },
          })
        : Promise.resolve([]),
    ])
    const teamName = new Map(teams.map((t) => [t.id, t.name]))
    const agentName = new Map(agents.map((a) => [a.id, a.fullName ?? a.email]))

    // Conversations with no team or no assignee still count in the total and
    // show up as their own row, so the buckets always add up to the total.
    const NONE = '__none__'
    const bucket = (key: (r: (typeof rows)[number]) => string | null, label: (k: string) => string) => {
      const groups = new Map<string, number[]>()
      for (const r of rows) {
        const k = key(r) ?? NONE
        groups.set(k, [...(groups.get(k) ?? []), r.rating!])
      }
      return [...groups.entries()]
        .map(([k, scores]): NpsBucket => ({ key: k, label: label(k), ...summarizeNps(scores) }))
        .sort((a, b) => b.responses - a.responses || (b.nps ?? -101) - (a.nps ?? -101))
    }

    return {
      totalPrompted,
      ...summarizeNps(rows.map((r) => r.rating!)),
      byTeam: bucket(
        (r) => r.teamId,
        (k) => (k === NONE ? '' : (teamName.get(k) ?? k)),
      ),
      byAgent: bucket(
        (r) => r.assignedAgentId,
        (k) => (k === NONE ? '' : (agentName.get(k) ?? k)),
      ),
    }
  }

  /** One section per dimension; labels in Portuguese like the other exports. */
  async statsCsv(userId: string, accountId: string, q: NpsQuery): Promise<string> {
    const s = await this.stats(userId, accountId, q)
    const header = ['dimensao', 'nome', 'respostas', 'promotores', 'neutros', 'detratores', 'nps']
    const row = (dim: string, name: string, b: NpsSummary) =>
      [dim, name, b.responses, b.promoters, b.passives, b.detractors, b.nps].map(csvCell).join(',')
    const lines = [
      header.join(','),
      row('total', 'Todos', s),
      ...s.byTeam.map((b) => row('time', b.label || 'Sem time', b)),
      ...s.byAgent.map((b) => row('operador', b.label || 'Sem responsável', b)),
    ]
    return `\uFEFF${lines.join('\r\n')}\r\n`
  }

  private async membership(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }
}
