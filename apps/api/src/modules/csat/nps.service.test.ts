import { ForbiddenException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NpsService, summarizeNps } from './nps.service'

describe('summarizeNps', () => {
  it('bands 9-10 / 7-8 / 0-6 and scores promoters minus detractors', () => {
    // 5 promoters, 2 passives, 3 detractors over 10 → 50% - 30% = 20
    expect(summarizeNps([10, 9, 9, 10, 9, 8, 7, 6, 0, 3])).toEqual({
      responses: 10,
      promoters: 5,
      passives: 2,
      detractors: 3,
      nps: 20,
    })
  })

  it('reaches the extremes and rounds', () => {
    expect(summarizeNps([10, 10]).nps).toBe(100)
    expect(summarizeNps([0, 6]).nps).toBe(-100)
    expect(summarizeNps([9, 8, 7]).nps).toBe(33)
    expect(summarizeNps([]).nps).toBeNull()
  })
})

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn().mockResolvedValue({ isActive: true, role: 'SUPERVISOR' }) },
    account: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    csatSurvey: { count: vi.fn(), findMany: vi.fn() },
    team: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  }
}

describe('NpsService', () => {
  let prisma: ReturnType<typeof makePrisma>
  let svc: NpsService
  beforeEach(() => {
    prisma = makePrisma()
    svc = new NpsService(prisma as never)
  })

  it('reports NPS by team and by agent, with a row for unassigned', async () => {
    prisma.csatSurvey.count.mockResolvedValue(6)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: 10, teamId: 't1', assignedAgentId: 'u1' },
      { rating: 9, teamId: 't1', assignedAgentId: 'u1' },
      { rating: 3, teamId: 't1', assignedAgentId: 'u2' },
      { rating: 8, teamId: 't2', assignedAgentId: 'u2' },
      { rating: 0, teamId: null, assignedAgentId: null },
    ])
    prisma.team.findMany.mockResolvedValue([
      { id: 't1', name: 'Financeiro' },
      { id: 't2', name: 'Cadastro' },
    ])
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', fullName: 'Ana', email: 'a@x' },
      { id: 'u2', fullName: null, email: 'b@x' },
    ])
    const s = await svc.stats('me', 'acc1', { from: '2026-10-01T00:00:00-03:00' })
    expect(s).toMatchObject({ totalPrompted: 6, responses: 5, promoters: 2, detractors: 2, nps: 0 })
    expect(s.byTeam).toEqual([
      expect.objectContaining({ key: 't1', label: 'Financeiro', responses: 3, nps: 33 }),
      expect.objectContaining({ key: 't2', label: 'Cadastro', responses: 1, nps: 0 }),
      expect.objectContaining({ key: '__none__', label: '', responses: 1, nps: -100 }),
    ])
    expect(s.byAgent.map((b) => [b.label, b.nps])).toEqual([
      ['Ana', 100],
      ['b@x', -50],
      ['', -100],
    ])
    const where = prisma.csatSurvey.count.mock.calls[0]![0].where
    expect(where).toMatchObject({ accountId: 'acc1', type: 'NPS' })
    expect(where.promptedAt).toEqual({ gte: new Date('2026-10-01T03:00:00Z') })
  })

  it('filters by team and agent', async () => {
    prisma.csatSurvey.count.mockResolvedValue(0)
    prisma.csatSurvey.findMany.mockResolvedValue([])
    await svc.stats('me', 'acc1', { teamId: 't1', agentId: 'u1', inboxId: 'i1' })
    expect(prisma.csatSurvey.count.mock.calls[0]![0].where).toMatchObject({
      teamId: 't1',
      assignedAgentId: 'u1',
      inboxId: 'i1',
    })
  })

  it('CSV: header, total, then teams and agents', async () => {
    prisma.csatSurvey.count.mockResolvedValue(2)
    prisma.csatSurvey.findMany.mockResolvedValue([
      { rating: 10, teamId: 't1', assignedAgentId: null },
      { rating: 5, teamId: null, assignedAgentId: null },
    ])
    prisma.team.findMany.mockResolvedValue([{ id: 't1', name: 'Fin, Cobrança' }])
    prisma.user.findMany.mockResolvedValue([])
    const csv = await svc.statsCsv('me', 'acc1', {})
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines[0]).toBe('dimensao,nome,respostas,promotores,neutros,detratores,nps')
    expect(lines[1]).toBe('total,Todos,2,1,0,1,0')
    expect(lines).toContain('time,"Fin, Cobrança",1,1,0,0,100')
    expect(lines).toContain('time,Sem time,1,0,0,1,-100')
    expect(lines).toContain('operador,Sem responsável,2,1,0,1,0')
  })

  it('only administrators change the survey type; members can read it', async () => {
    prisma.account.findUniqueOrThrow.mockResolvedValue({ surveyType: 'CSAT' })
    await expect(svc.getSettings('me', 'acc1')).resolves.toEqual({ surveyType: 'CSAT' })
    await expect(svc.setSettings('me', 'acc1', 'NPS')).rejects.toBeInstanceOf(ForbiddenException)
    prisma.accountMember.findUnique.mockResolvedValue({ isActive: true, role: 'ADMINISTRATOR' })
    await expect(svc.setSettings('me', 'acc1', 'NPS')).resolves.toEqual({ surveyType: 'NPS', previous: 'CSAT' })
    expect(prisma.account.update).toHaveBeenCalledWith({ where: { id: 'acc1' }, data: { surveyType: 'NPS' } })
  })

  it('rejects non-members', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.stats('me', 'acc1', {})).rejects.toBeInstanceOf(ForbiddenException)
  })
})
