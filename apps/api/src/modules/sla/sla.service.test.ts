import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SlaService } from './sla.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    slaPolicy: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversation: { findMany: vi.fn(), updateMany: vi.fn() },
  }
}
function makeWebhooks() {
  return { dispatch: vi.fn(async () => undefined) }
}
function makeNotifications() {
  return { createSlaBreach: vi.fn(async () => ['u1', 'u9']) }
}
function makeRealtime() {
  return { publish: vi.fn(async () => undefined) }
}
type Prisma = ReturnType<typeof makePrisma>
const makeService = (
  p: Prisma,
  w = makeWebhooks(),
  n = makeNotifications(),
  r = makeRealtime(),
) => new SlaService(p as never, w as never, n as never, r as never)

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { ...ADMIN, role: 'AGENT' }
const INACTIVE = { ...ADMIN, isActive: false }

const POLICY = {
  id: 'sp1',
  accountId: 'acc1',
  name: 'Standard',
  firstResponseLowMinutes: 240,
  firstResponseNormalMinutes: 120,
  firstResponseHighMinutes: 60,
  firstResponseUrgentMinutes: 15,
  resolutionLowMinutes: 24 * 60,
  resolutionNormalMinutes: 12 * 60,
  resolutionHighMinutes: 4 * 60,
  resolutionUrgentMinutes: 60,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
}

// ---------- CRUD ----------

describe('SlaService CRUD', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('list 403s for non-members', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('list 403s for inactive members', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(INACTIVE)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('list returns policies for any active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.slaPolicy.findMany.mockResolvedValue([POLICY])
    expect(await makeService(prisma).list('u1', 'acc1')).toEqual([POLICY])
  })

  it('create 403s for non-admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', { name: 'Fast' } as never),
    ).rejects.toThrow('Administrator role required')
  })

  it('create 403s for inactive admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(INACTIVE)
    await expect(
      makeService(prisma).create('u1', 'acc1', { name: 'Fast' } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('create persists with accountId injected', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.create.mockResolvedValue({ id: 'new', ...POLICY })
    await makeService(prisma).create('u1', 'acc1', { name: 'Fast' } as never)
    expect(prisma.slaPolicy.create).toHaveBeenCalledWith({
      data: { accountId: 'acc1', name: 'Fast' },
    })
  })

  it('update 403s for non-admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sp1', {} as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('update 404s for missing policy', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sp1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('update 404s on IDOR (other account)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue({ ...POLICY, accountId: 'other-acc' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'sp1', {} as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('update applies the input', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue(POLICY)
    prisma.slaPolicy.update.mockResolvedValue({ ...POLICY, name: 'Renamed' })
    await makeService(prisma).update('u1', 'acc1', 'sp1', { name: 'Renamed' } as never)
    expect(prisma.slaPolicy.update).toHaveBeenCalledWith({
      where: { id: 'sp1' },
      data: { name: 'Renamed' },
    })
  })

  it('remove 403s for non-admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).remove('u1', 'acc1', 'sp1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('remove 404s for missing policy', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'sp1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('remove 404s on IDOR', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue({ ...POLICY, accountId: 'other-acc' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'sp1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('remove deletes when authorised', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.slaPolicy.findUnique.mockResolvedValue(POLICY)
    await makeService(prisma).remove('u1', 'acc1', 'sp1')
    expect(prisma.slaPolicy.delete).toHaveBeenCalledWith({ where: { id: 'sp1' } })
  })
})

// ---------- computeStatus ----------

describe('SlaService.computeStatus', () => {
  const svc = makeService(makePrisma())
  const NOW = new Date('2026-05-04T15:00:00.000Z')

  it('NOT_APPLICABLE when no policy attached', () => {
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: NOW,
    }
    expect(svc.computeStatus(c, null, NOW)).toEqual({
      state: 'NOT_APPLICABLE',
      dimension: null,
      targetAt: null,
      minutesRemaining: null,
      secondsRemaining: null,
    })
  })

  it('NOT_APPLICABLE when conversation is RESOLVED', () => {
    const c = {
      priority: 'URGENT' as const,
      status: 'RESOLVED' as const,
      firstReplyAt: NOW,
      resolvedAt: NOW,
      createdAt: NOW,
    }
    expect(svc.computeStatus(c, POLICY as never, NOW).state).toBe('NOT_APPLICABLE')
  })

  it('ON_TRACK in the first-response dimension when well under target', () => {
    const created = new Date(NOW.getTime() - 30 * 60_000) // 30 min ago
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    const r = svc.computeStatus(c, POLICY as never, NOW)
    expect(r.state).toBe('ON_TRACK')
    expect(r.dimension).toBe('firstResponse')
    // 120 min target, elapsed 30 → 90 remaining
    expect(r.minutesRemaining).toBeGreaterThanOrEqual(89)
    expect(r.minutesRemaining).toBeLessThanOrEqual(91)
  })

  it('AT_RISK once we are 80% of the way to the target', () => {
    const created = new Date(NOW.getTime() - 100 * 60_000) // 100 min ago
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    // target 120 min, 100/120 = 83% → AT_RISK
    expect(svc.computeStatus(c, POLICY as never, NOW).state).toBe('AT_RISK')
  })

  it('BREACHED when the target time has already passed', () => {
    const created = new Date(NOW.getTime() - 200 * 60_000) // 200 min ago
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    const r = svc.computeStatus(c, POLICY as never, NOW)
    expect(r.state).toBe('BREACHED')
    expect(r.minutesRemaining).toBeLessThan(0)
  })

  it('switches to resolution dimension once firstReplyAt is set', () => {
    // First reply 30 min ago, status still OPEN, resolution target 12h = 720min
    const firstReply = new Date(NOW.getTime() - 30 * 60_000)
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: firstReply,
      resolvedAt: null,
      createdAt: new Date(NOW.getTime() - 60 * 60_000),
    }
    const r = svc.computeStatus(c, POLICY as never, NOW)
    expect(r.dimension).toBe('resolution')
    expect(r.state).toBe('ON_TRACK')
  })

  it('uses URGENT priority targets when set', () => {
    const created = new Date(NOW.getTime() - 10 * 60_000) // 10 min ago
    const c = {
      priority: 'URGENT' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    // urgent target 15 min, 10/15 = 67% → still ON_TRACK
    expect(svc.computeStatus(c, POLICY as never, NOW).state).toBe('ON_TRACK')
    // shift to 13 min → 87% → AT_RISK
    const c2 = { ...c, createdAt: new Date(NOW.getTime() - 13 * 60_000) }
    expect(svc.computeStatus(c2, POLICY as never, NOW).state).toBe('AT_RISK')
  })

  it('targetAt is an ISO string of start + targetMinutes', () => {
    const created = new Date('2026-05-04T14:00:00.000Z')
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    const r = svc.computeStatus(c, POLICY as never, NOW)
    // 120 min after 14:00 = 16:00
    expect(r.targetAt).toBe('2026-05-04T16:00:00.000Z')
  })

  it('uses Date.now() default when called without `now`', () => {
    const created = new Date(Date.now() - 30 * 60_000)
    const c = {
      priority: 'LOW' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    const r = svc.computeStatus(c, POLICY as never)
    expect(r.state).toBe('ON_TRACK')
  })

  it('falls back to 0-minute target when the policy field is missing (defensive)', () => {
    const created = new Date(NOW.getTime() - 10 * 60_000)
    const c = {
      priority: 'NORMAL' as const,
      status: 'OPEN' as const,
      firstReplyAt: null,
      resolvedAt: null,
      createdAt: created,
    }
    // policy without firstResponseNormalMinutes → key lookup returns undefined → 0 fallback
    const partialPolicy = { ...POLICY, firstResponseNormalMinutes: undefined } as never
    expect(svc.computeStatus(c, partialPolicy, NOW).state).toBe('BREACHED')
  })
})

// ---------- toDTO ----------

describe('SlaService.toDTO', () => {
  const svc = makeService(makePrisma())

  it('maps every minute field + ISO createdAt', () => {
    const dto = svc.toDTO(POLICY as never)
    expect(dto.firstResponseLowMinutes).toBe(240)
    expect(dto.firstResponseUrgentMinutes).toBe(15)
    expect(dto.resolutionLowMinutes).toBe(1440)
    expect(dto.resolutionUrgentMinutes).toBe(60)
    expect(dto.createdAt).toBe('2026-05-01T00:00:00.000Z')
  })
})


describe('SlaService.sweepBreaches (F10)', () => {
  const policy = {
    id: 'pol1',
    firstResponseNormalMinutes: 60,
    resolutionNormalMinutes: 480,
  }
  const breached = {
    id: 'cv1',
    accountId: 'acc1',
    inboxId: 'inb1',
    priority: 'NORMAL',
    status: 'OPEN',
    firstReplyAt: null,
    resolvedAt: null,
    // created 2h ago against a 60-minute first-response target → BREACHED
    createdAt: new Date(Date.now() - 2 * 3600_000),
    inbox: { slaPolicy: policy },
  }

  it('dispatches conversation.sla_breached once and stamps the marker', async () => {
    const p = makePrisma()
    const w = makeWebhooks()
    p.conversation.findMany.mockResolvedValue([breached])
    p.conversation.updateMany.mockResolvedValue({ count: 1 })
    await makeService(p, w).sweepBreaches()
    expect(p.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'cv1', slaBreachedNotifiedAt: null },
      data: { slaBreachedNotifiedAt: expect.any(Date) },
    })
    expect(w.dispatch).toHaveBeenCalledWith('acc1', 'conversation.sla_breached', {
      conversationId: 'cv1',
      inboxId: 'inb1',
      priority: 'NORMAL',
      dimension: 'firstResponse',
      targetAt: expect.any(String),
    })
  })

  it('a concurrent sweep that loses the claim does not dispatch', async () => {
    const p = makePrisma()
    const w = makeWebhooks()
    p.conversation.findMany.mockResolvedValue([breached])
    p.conversation.updateMany.mockResolvedValue({ count: 0 })
    await makeService(p, w).sweepBreaches()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('leaves on-track conversations untouched', async () => {
    const p = makePrisma()
    const w = makeWebhooks()
    p.conversation.findMany.mockResolvedValue([
      { ...breached, createdAt: new Date() },
    ])
    await makeService(p, w).sweepBreaches()
    expect(p.conversation.updateMany).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('only ever queries unresolved, unnotified conversations on policied inboxes', async () => {
    const p = makePrisma()
    p.conversation.findMany.mockResolvedValue([])
    await makeService(p).sweepBreaches()
    expect(p.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: 'RESOLVED' },
          controlMode: { not: 'BOT' },
          slaBreachedNotifiedAt: null,
          inbox: { slaPolicyId: { not: null } },
        },
        take: 500,
      }),
    )
  })

  it('a database failure is swallowed so the scheduler survives', async () => {
    const p = makePrisma()
    p.conversation.findMany.mockRejectedValue(new Error('db down'))
    await expect(makeService(p).sweepBreaches()).resolves.toBeUndefined()
  })
})


describe('SlaService.sweepBreaches — remaining branches', () => {
  it('skips a candidate whose inbox has no policy loaded', async () => {
    // The query filters on slaPolicyId != null, but the include can still
    // come back without the relation; treat it as "no policy", not a crash.
    const p = makePrisma()
    const w = makeWebhooks()
    p.conversation.findMany.mockResolvedValue([
      {
        id: 'cv1',
        accountId: 'acc1',
        inboxId: 'inb1',
        priority: 'NORMAL',
        status: 'OPEN',
        firstReplyAt: null,
        resolvedAt: null,
        createdAt: new Date(Date.now() - 5 * 3600_000),
        inbox: {},
      },
    ])
    await makeService(p, w).sweepBreaches()
    expect(p.conversation.updateMany).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('swallows a non-Error rejection as well', async () => {
    const p = makePrisma()
    p.conversation.findMany.mockRejectedValue('boom')
    await expect(makeService(p).sweepBreaches()).resolves.toBeUndefined()
  })
})

// ---------- pilot item 11: seconds, the human queue, the alarm, the report ----------

describe('SlaService — second-level targets and the human queue', () => {
  const NOW = new Date('2026-10-16T12:00:00.000Z')
  const secPolicy = { ...POLICY, firstResponseSeconds: 60 } as never
  const base = {
    priority: 'NORMAL' as const,
    status: 'OPEN' as const,
    firstReplyAt: null,
    resolvedAt: null,
    controlMode: 'HUMAN' as const,
  }
  const svc = makeService(makePrisma())

  it('counts a 60 s first-response target from when the conversation entered the queue', () => {
    const queuedAt = new Date(NOW.getTime() - 50_000)
    const s = svc.computeStatus(
      { ...base, createdAt: new Date(NOW.getTime() - 3_600_000), queuedAt },
      secPolicy,
      NOW,
    )
    expect(s).toMatchObject({ state: 'AT_RISK', dimension: 'firstResponse', secondsRemaining: 10 })
    expect(s.targetAt).toBe(new Date(queuedAt.getTime() + 60_000).toISOString())
    const later = new Date(NOW.getTime() + 15_000)
    expect(svc.computeStatus({ ...base, createdAt: queuedAt, queuedAt }, secPolicy, later).state).toBe('BREACHED')
    expect(svc.computeStatus({ ...base, createdAt: NOW, queuedAt: null }, secPolicy, NOW).state).toBe('ON_TRACK')
  })

  it('has no SLA while the bot is handling the conversation', () => {
    expect(
      svc.computeStatus({ ...base, controlMode: 'BOT', createdAt: new Date(0) }, secPolicy, NOW).state,
    ).toBe('NOT_APPLICABLE')
  })

  it('keeps minute targets for resolution even with a seconds override', () => {
    const s = svc.computeStatus(
      { ...base, createdAt: new Date(0), firstReplyAt: NOW },
      secPolicy,
      new Date(NOW.getTime() + 60 * 60_000),
    )
    expect(s).toMatchObject({ state: 'ON_TRACK', dimension: 'resolution' })
  })

  it('maps the seconds override in the DTO', () => {
    expect(svc.toDTO({ ...POLICY, firstResponseSeconds: 60 } as never).firstResponseSeconds).toBe(60)
  })
})

describe('SlaService.sweepBreaches — the alarm', () => {
  const conv = {
    id: 'cv1',
    displayId: 42,
    accountId: 'acc1',
    inboxId: 'inb1',
    teamId: 't1',
    assigneeId: null,
    priority: 'NORMAL',
    status: 'OPEN',
    controlMode: 'HUMAN',
    firstReplyAt: null,
    resolvedAt: null,
    createdAt: new Date(Date.now() - 3_600_000),
    queuedAt: new Date(Date.now() - 65_000),
    inbox: { slaPolicy: { ...POLICY, firstResponseSeconds: 60 } },
  }

  it('notifies, pushes a realtime alarm to the same people, then the webhook', async () => {
    const p = makePrisma()
    const n = makeNotifications()
    const r = makeRealtime()
    const w = makeWebhooks()
    p.conversation.findMany.mockResolvedValue([conv])
    p.conversation.updateMany.mockResolvedValue({ count: 1 })
    await makeService(p, w, n, r).sweepBreaches()
    expect(n.createSlaBreach).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      assigneeId: null,
      teamId: 't1',
    })
    expect(r.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SlaBreached',
        conversationId: 'cv1',
        displayId: 42,
        teamId: 't1',
        dimension: 'firstResponse',
        userIds: ['u1', 'u9'],
      }),
    )
    expect(w.dispatch).toHaveBeenCalled()
  })

  it('never runs two sweeps at once', async () => {
    const p = makePrisma()
    let release: () => void = () => undefined
    p.conversation.findMany.mockImplementation(
      () => new Promise((res) => { release = () => res([]) }),
    )
    const svc = makeService(p)
    const first = svc.sweepBreaches()
    await svc.sweepBreaches()
    expect(p.conversation.findMany).toHaveBeenCalledTimes(1)
    release()
    await first
    p.conversation.findMany.mockResolvedValue([])
    await svc.sweepBreaches()
    expect(p.conversation.findMany).toHaveBeenCalledTimes(2)
  })
})

describe('SlaService.misses — the missed-conversations report', () => {
  function prismaWith(rows: unknown[], role = 'SUPERVISOR') {
    const p = makePrisma() as Prisma & { conversation: { findMany: ReturnType<typeof vi.fn> } }
    p.accountMember.findUnique.mockResolvedValue({ ...ADMIN, role })
    p.conversation.findMany.mockResolvedValue(rows)
    return p
  }
  const queuedAt = new Date('2026-10-16T12:00:00.000Z')
  const row = {
    id: 'cv1',
    displayId: 42,
    priority: 'NORMAL',
    status: 'OPEN',
    createdAt: new Date('2026-10-16T11:00:00.000Z'),
    queuedAt,
    firstReplyAt: null,
    slaBreachedNotifiedAt: new Date('2026-10-16T12:01:05.000Z'),
    inbox: { name: 'WhatsApp', slaPolicy: { ...POLICY, firstResponseSeconds: 60 } },
    team: { name: 'Financeiro' },
    assignee: null,
    contact: { name: 'Ana; "VIP"' },
  }

  it('lists date, time and sector of each miss, newest first', async () => {
    const p = prismaWith([row])
    const out = await makeService(p).misses('u1', 'acc1', { teamId: 't1', inboxId: 'inb1' })
    expect(out).toEqual([
      {
        conversationId: 'cv1',
        displayId: 42,
        contactName: 'Ana; "VIP"',
        inboxName: 'WhatsApp',
        teamName: 'Financeiro',
        assigneeName: null,
        queuedAt: '2026-10-16T12:00:00.000Z',
        targetAt: '2026-10-16T12:01:00.000Z',
        breachedAt: '2026-10-16T12:01:05.000Z',
        firstReplyAt: null,
        status: 'OPEN',
      },
    ])
    const where = p.conversation.findMany.mock.calls[0]![0].where
    expect(where).toMatchObject({ accountId: 'acc1', teamId: 't1', inboxId: 'inb1' })
    expect(where.slaBreachedNotifiedAt.gte).toBeInstanceOf(Date)
  })

  it('uses minute targets, createdAt, names and no policy as given', async () => {
    const p = prismaWith([
      {
        ...row,
        queuedAt: null,
        firstReplyAt: new Date('2026-10-16T13:00:00.000Z'),
        inbox: { name: 'Site', slaPolicy: POLICY },
        team: null,
        assignee: { fullName: null, email: 'bia@x' },
        contact: null,
      },
      { ...row, inbox: { name: 'Sem política', slaPolicy: null }, assignee: { fullName: 'Bia', email: 'b' } },
    ], 'ADMINISTRATOR')
    const [a, b] = await makeService(p).misses('u1', 'acc1', {
      from: new Date('2026-10-01'),
      to: new Date('2026-10-31'),
    })
    expect(a).toMatchObject({
      teamName: null,
      assigneeName: 'bia@x',
      contactName: null,
      queuedAt: '2026-10-16T11:00:00.000Z',
      targetAt: '2026-10-16T13:00:00.000Z',
      firstReplyAt: '2026-10-16T13:00:00.000Z',
    })
    expect(b).toMatchObject({ assigneeName: 'Bia', targetAt: b!.queuedAt })
  })

  it('is for administrators and supervisors only', async () => {
    await expect(makeService(prismaWith([], 'AGENT')).misses('u1', 'acc1', {})).rejects.toThrow(ForbiddenException)
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(INACTIVE)
    await expect(makeService(p).misses('u1', 'acc1', {})).rejects.toThrow(ForbiddenException)
  })

  it('exports CSV with the sector, quoting what needs quoting', async () => {
    const svc = makeService(prismaWith([]))
    const rows = await makeService(prismaWith([row])).misses('u1', 'acc1', {})
    const csv = svc.missesCsv(rows)
    const [head, line] = csv.trim().split('\n')
    expect(head).toBe('conversa;contato;setor;caixa;responsavel;entrou_na_fila;prazo;estourou_em;primeira_resposta;status')
    expect(line).toBe('42;"Ana; ""VIP""";Financeiro;WhatsApp;;2026-10-16T12:00:00.000Z;2026-10-16T12:01:00.000Z;2026-10-16T12:01:05.000Z;;OPEN')
  })
})
