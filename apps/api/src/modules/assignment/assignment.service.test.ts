import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYSTEM_ACTOR } from '../activity/activity.service'

import { AssignmentService, OFFLINE_FALLBACK_REASON } from './assignment.service'
import type { AvailabilitySlot } from './availability-window'

// ─── in-memory account ──────────────────────────────────────────────
// A small fake of the rows routing reads, so the tests exercise the real
// filter (active, not a bot, inbox member, team member) and the round robin
// state instead of asserting on query shapes alone.

type Member = {
  id: string
  userId: string
  accountId: string
  isActive: boolean
  role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' | 'BOT'
  inboxIds: string[]
  teamIds: string[]
  lastAutoAssignedAt: Date | null
  availabilities: AvailabilitySlot[]
  fullName: string | null
}

type Conv = {
  id: string
  accountId: string
  inboxId: string
  teamId: string | null
  assigneeId: string | null
  status: 'OPEN' | 'PENDING' | 'RESOLVED'
  controlMode: 'BOT' | 'HUMAN'
}

// Monday 2026-05-04, 14:30 UTC (11:30 in Sao Paulo).
const NOW = new Date('2026-05-04T14:30:00Z')

/** Monday 09:00 to 18:00: covers NOW in UTC and in Sao Paulo. */
const ON_SHIFT: AvailabilitySlot[] = [
  { dayOfWeek: 1, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
]
/** Tuesday only: not on shift on a Monday. */
const OFF_SHIFT: AvailabilitySlot[] = [
  { dayOfWeek: 2, openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0, closedAllDay: false },
]

function member(userId: string, over: Partial<Member> = {}): Member {
  return {
    id: `m-${userId}`,
    userId,
    accountId: 'acc1',
    isActive: true,
    role: 'AGENT',
    inboxIds: ['inb1'],
    teamIds: [],
    lastAutoAssignedAt: null,
    availabilities: ON_SHIFT,
    fullName: `Agent ${userId}`,
    ...over,
  }
}

function makeWorld(
  members: Member[],
  conv: Partial<Conv> = {},
  account: { defaultTimezone: string } | null = { defaultTimezone: 'UTC' },
) {
  const conversation: Conv = {
    id: 'cv1',
    accountId: 'acc1',
    inboxId: 'inb1',
    teamId: null,
    assigneeId: null,
    status: 'OPEN',
    controlMode: 'HUMAN',
    ...conv,
  }
  const prisma = {
    conversation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === conversation.id ? { ...conversation } : null,
      ),
      update: vi.fn(
        async ({ data }: { data: { assigneeId: string | null } }) => {
          conversation.assigneeId = data.assigneeId
          return { ...conversation }
        },
      ),
    },
    account: {
      findUnique: vi.fn(async () => account),
    },
    accountMember: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            accountId: string
            isActive: boolean
            role: { not: string }
            user: {
              inboxMemberships: { some: { inboxId: string } }
              teamMemberships?: { some: { teamId: string } }
            }
          }
        }) =>
          members
            .filter(
              (m) =>
                m.accountId === where.accountId &&
                m.isActive === where.isActive &&
                m.role !== where.role.not &&
                m.inboxIds.includes(where.user.inboxMemberships.some.inboxId) &&
                (!where.user.teamMemberships ||
                  m.teamIds.includes(where.user.teamMemberships.some.teamId)),
            )
            .map((m) => ({
              id: m.id,
              userId: m.userId,
              lastAutoAssignedAt: m.lastAutoAssignedAt,
              availabilities: m.availabilities,
              user: { fullName: m.fullName },
            })),
      ),
      // Compare-and-set, like the real conditional update.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; lastAutoAssignedAt: Date | null }
          data: { lastAutoAssignedAt: Date }
        }) => {
          const m = members.find((x) => x.id === where.id)
          const same =
            m !== undefined &&
            (m.lastAutoAssignedAt?.getTime() ?? null) ===
              (where.lastAutoAssignedAt?.getTime() ?? null)
          if (!m || !same) return { count: 0 }
          m.lastAutoAssignedAt = data.lastAutoAssignedAt
          return { count: 1 }
        },
      ),
    },
    teamMember: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { teamId_userId: { teamId: string; userId: string } }
        }) => {
          const { teamId, userId } = where.teamId_userId
          const m = members.find((x) => x.userId === userId)
          return m?.teamIds.includes(teamId) ? { id: `tm-${userId}` } : null
        },
      ),
    },
  }
  const activity = { log: vi.fn().mockResolvedValue(undefined) }
  const notifications = { createAssignment: vi.fn().mockResolvedValue(undefined) }
  const svc = new AssignmentService(
    prisma as never,
    activity as never,
    notifications as never,
  )
  return { svc, prisma, activity, notifications, conversation, members }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── availability ───────────────────────────────────────────────────

describe('AssignmentService.route: availability', () => {
  it('gives the conversation to the available agent, not the unavailable one', async () => {
    const w = makeWorld([
      member('off', { availabilities: OFF_SHIFT }),
      member('on', { availabilities: ON_SHIFT }),
    ])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out).toEqual({ assigneeId: 'on', pickedId: 'on' })
    expect(w.conversation.assigneeId).toBe('on')
    expect(w.activity.log).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cv1', inboxId: 'inb1', accountId: 'acc1' }),
      {
        type: 'assignee',
        text: `Conversation assigned to Agent on by ${SYSTEM_ACTOR}`,
        actorName: SYSTEM_ACTOR,
        from: null,
        to: 'Agent on',
      },
    )
  })

  it('treats an agent with no saved schedule as unavailable', async () => {
    const w = makeWorld([member('never', { availabilities: [] })])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
  })

  it('skips a day marked closed all day', async () => {
    const w = makeWorld([
      member('closed', { availabilities: [{ ...ON_SHIFT[0]!, closedAllDay: true }] }),
    ])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBeNull()
  })

  it('reads schedules in the account timezone', async () => {
    // 07:00 to 10:00 on Monday. NOW is 14:30 UTC but 11:30 in Sao Paulo:
    // off shift either way, while 12:00 UTC is 09:00 in Sao Paulo, on shift.
    const morning: AvailabilitySlot[] = [
      { dayOfWeek: 1, openHour: 7, openMinute: 0, closeHour: 10, closeMinute: 0, closedAllDay: false },
    ]
    const at = new Date('2026-05-04T12:00:00Z')
    const utc = makeWorld([member('a', { availabilities: morning })])
    expect((await utc.svc.route('cv1', 'conversation_created', { now: at }))?.pickedId).toBeNull()
    const sp = makeWorld([member('a', { availabilities: morning })], {}, {
      defaultTimezone: 'America/Sao_Paulo',
    })
    expect((await sp.svc.route('cv1', 'conversation_created', { now: at }))?.pickedId).toBe('a')
  })

  it('uses UTC when the account row has no timezone to offer', async () => {
    const w = makeWorld([member('a')], {}, null)
    expect((await w.svc.route('cv1', 'conversation_created', { now: NOW }))?.pickedId).toBe('a')
  })

  it('defaults to the current time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const w = makeWorld([member('a')])
      expect((await w.svc.route('cv1', 'conversation_created'))?.pickedId).toBe('a')
      expect(w.members[0]!.lastAutoAssignedAt).toEqual(NOW)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── nobody available ───────────────────────────────────────────────

describe('AssignmentService.route: nobody available (Nebula default)', () => {
  it('leaves the conversation unassigned in the queue', async () => {
    const w = makeWorld([
      member('a', { availabilities: OFF_SHIFT }),
      member('b', { availabilities: [] }),
    ])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
    expect(w.prisma.conversation.update).not.toHaveBeenCalled()
    expect(w.activity.log).not.toHaveBeenCalled()
    // Nobody's turn was consumed.
    expect(w.members.every((m) => m.lastAutoAssignedAt === null)).toBe(true)
  })

  // The one exception, and the reason it exists: on a bot handoff the contact
  // has just been told a human is coming. An off-shift owner can at least see
  // it; an empty queue is how "someone will reply" became a lie.
  it('a bot handoff falls back to an off-shift member rather than nobody', async () => {
    const w = makeWorld([
      member('a', { availabilities: OFF_SHIFT }),
      member('b', { availabilities: [] }),
    ])
    const out = await w.svc.route('cv1', 'bot_handoff', { now: NOW })
    expect(out?.pickedId).not.toBeNull()
    expect(w.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { assigneeId: out?.pickedId } }),
    )
  })

  it('tells the agent it picked, with no actor to name', async () => {
    const w = makeWorld([member('a')])
    await w.svc.route('cv1', 'conversation_created', { now: NOW })

    expect(w.notifications.createAssignment).toHaveBeenCalledWith({
      accountId: 'acc1',
      conversationId: 'cv1',
      assigneeId: 'a',
      // Distribution is nobody's doing, so the bell must not name a person.
      assignedByUserId: null,
      previousAssigneeId: null,
      // On shift: an ordinary round robin, no coverage gap to report.
      offlineFallback: false,
    })
  })

  it('tells the off-shift agent too, which is the whole point of the fallback', async () => {
    const w = makeWorld([member('a', { availabilities: OFF_SHIFT })])
    await w.svc.route('cv1', 'bot_handoff', { now: NOW })

    // Somebody asleep who is never told is the same customer waiting on
    // nobody, only with an owner's name on the conversation.
    expect(w.notifications.createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'a', assignedByUserId: null }),
    )
  })

  it('says nothing when nobody could be picked', async () => {
    const w = makeWorld([member('a', { inboxIds: ['other-inbox'] })])
    await w.svc.route('cv1', 'bot_handoff', { now: NOW })

    expect(w.notifications.createAssignment).not.toHaveBeenCalled()
  })

  it('flags the fallback so the coverage gap is reported too', async () => {
    const w = makeWorld([member('a', { availabilities: OFF_SHIFT })])
    await w.svc.route('cv1', 'bot_handoff', { now: NOW })

    expect(w.notifications.createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'a', offlineFallback: true }),
    )
  })

  it('marks the fallback assignment so a report can tell it apart', async () => {
    const w = makeWorld([member('a', { availabilities: OFF_SHIFT })])
    await w.svc.route('cv1', 'bot_handoff', { now: NOW })

    const entry = w.activity.log.mock.calls[0]![1]
    expect(entry.reason).toBe(OFFLINE_FALLBACK_REASON)
    expect(entry.text).toContain('(nobody on shift)')
  })

  it('a normal round robin carries no fallback marker', async () => {
    const w = makeWorld([member('on')])
    await w.svc.route('cv1', 'bot_handoff', { now: NOW })

    const entry = w.activity.log.mock.calls[0]![1]
    expect(entry.reason).toBeUndefined()
    expect(entry.text).not.toContain('nobody on shift')
  })

  it('the fallback round robin spreads across off-shift members', async () => {
    const earlier = new Date(NOW.getTime() - 60_000)
    const w = makeWorld([
      member('a', { availabilities: OFF_SHIFT, lastAutoAssignedAt: NOW }),
      member('b', { availabilities: OFF_SHIFT, lastAutoAssignedAt: earlier }),
    ])
    // Longest wait since their last automatic assignment wins, exactly as it
    // does on shift, so a fallback does not always land on the same person.
    const out = await w.svc.route('cv1', 'bot_handoff', { now: NOW })
    expect(out?.pickedId).toBe('b')
  })

  it('a bot handoff with nobody eligible at all still assigns nobody', async () => {
    const w = makeWorld([member('a', { inboxIds: ['other-inbox'] })])
    const out = await w.svc.route('cv1', 'bot_handoff', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
    expect(w.prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('prefers someone on shift over the handoff fallback', async () => {
    const w = makeWorld([
      member('off', { availabilities: OFF_SHIFT }),
      member('on'),
    ])
    const out = await w.svc.route('cv1', 'bot_handoff', { now: NOW })
    expect(out?.pickedId).toBe('on')
  })

  it('does not assign anyone when the inbox has no members', async () => {
    const w = makeWorld([member('a', { inboxIds: ['other-inbox'] })])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBeNull()
  })

  it('keeps an ineligible assignee when there is no team and nobody to replace them', async () => {
    const w = makeWorld([member('gone', { isActive: false })], { assigneeId: 'gone' })
    const out = await w.svc.route('cv1', 'conversation_reopened', { now: NOW })
    expect(out).toEqual({ assigneeId: 'gone', pickedId: null })
    expect(w.prisma.teamMember.findUnique).not.toHaveBeenCalled()
  })
})

// ─── eligibility ────────────────────────────────────────────────────

describe('AssignmentService.route: who is eligible', () => {
  it('never picks an inactive member, even on shift', async () => {
    const w = makeWorld([member('inactive', { isActive: false }), member('active')])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBe('active')
  })

  it('returns nobody when the only on-shift member is inactive', async () => {
    const w = makeWorld([member('inactive', { isActive: false })])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBeNull()
  })

  it('never picks a bot member or a member of another account', async () => {
    const w = makeWorld([
      member('bot', { role: 'BOT' }),
      member('stranger', { accountId: 'acc2' }),
    ])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBeNull()
  })

  it('only picks members of the conversation inbox', async () => {
    const w = makeWorld([member('elsewhere', { inboxIds: ['inb2'] }), member('here')])
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBe('here')
  })

  it('with a team, only picks inbox members who are in the team', async () => {
    const w = makeWorld(
      [member('inbox-only'), member('team', { teamIds: ['t1'] })],
      { teamId: 't1' },
    )
    const out = await w.svc.route('cv1', 'team_changed', { now: NOW })
    expect(out?.pickedId).toBe('team')
  })

  it('keeps the current assignee while they are still eligible', async () => {
    const w = makeWorld([member('a'), member('b')], { assigneeId: 'b' })
    const out = await w.svc.route('cv1', 'conversation_reopened', { now: NOW })
    expect(out).toEqual({ assigneeId: 'b', pickedId: null })
    expect(w.prisma.conversation.update).not.toHaveBeenCalled()
    expect(w.prisma.accountMember.updateMany).not.toHaveBeenCalled()
  })

  it('keeps an eligible assignee even when they are off shift', async () => {
    const w = makeWorld([member('a', { availabilities: OFF_SHIFT })], { assigneeId: 'a' })
    const out = await w.svc.route('cv1', 'conversation_reopened', { now: NOW })
    expect(out?.assigneeId).toBe('a')
  })

  it('replaces an assignee who was deactivated', async () => {
    const w = makeWorld(
      [member('old', { isActive: false }), member('new')],
      { assigneeId: 'old' },
    )
    const out = await w.svc.route('cv1', 'conversation_reopened', { now: NOW })
    expect(out).toEqual({ assigneeId: 'new', pickedId: 'new' })
    expect(w.activity.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: 'old', to: 'Agent new' }),
    )
  })

  it('names an agent without a full name generically in the transcript', async () => {
    const w = makeWorld([member('a', { fullName: null })])
    await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(w.activity.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: `Conversation assigned to an agent by ${SYSTEM_ACTOR}` }),
    )
  })
})

// ─── team change ────────────────────────────────────────────────────

describe('AssignmentService.route: team change', () => {
  it('moves the conversation to an available team member when the assignee is not in the team', async () => {
    const w = makeWorld(
      [member('outsider'), member('insider', { teamIds: ['t1'] })],
      { teamId: 't1', assigneeId: 'outsider' },
    )
    const out = await w.svc.route('cv1', 'team_changed', { now: NOW })
    expect(out).toEqual({ assigneeId: 'insider', pickedId: 'insider' })
  })

  it('sends it back to the queue when nobody in the team is available', async () => {
    const w = makeWorld(
      [member('outsider'), member('insider', { teamIds: ['t1'], availabilities: OFF_SHIFT })],
      { teamId: 't1', assigneeId: 'outsider' },
    )
    const out = await w.svc.route('cv1', 'team_changed', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
    expect(w.conversation.assigneeId).toBeNull()
    expect(w.activity.log).toHaveBeenCalledWith(expect.anything(), {
      type: 'assignee',
      text: `Conversation unassigned by ${SYSTEM_ACTOR}`,
      actorName: SYSTEM_ACTOR,
      from: 'outsider',
      to: null,
    })
  })

  it('keeps a team member who is ineligible for another reason when nobody can replace them', async () => {
    // In the team but no longer in the inbox: Nebula only clears on a team
    // mismatch, so they stay.
    const w = makeWorld(
      [member('member', { teamIds: ['t1'], inboxIds: [] })],
      { teamId: 't1', assigneeId: 'member' },
    )
    const out = await w.svc.route('cv1', 'team_changed', { now: NOW })
    expect(out).toEqual({ assigneeId: 'member', pickedId: null })
    expect(w.prisma.conversation.update).not.toHaveBeenCalled()
  })

  it('does nothing to an unassigned conversation when the team has nobody available', async () => {
    const w = makeWorld([member('insider', { teamIds: ['t1'], availabilities: [] })], {
      teamId: 't1',
    })
    const out = await w.svc.route('cv1', 'team_changed', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
    expect(w.prisma.teamMember.findUnique).not.toHaveBeenCalled()
  })
})

// ─── round robin ────────────────────────────────────────────────────

describe('AssignmentService.route: fair round robin among available agents', () => {
  it('rotates through every available agent before repeating anyone', async () => {
    const w = makeWorld([member('ana'), member('bia'), member('caio'), member('off', { availabilities: OFF_SHIFT })])
    const picks: (string | null)[] = []
    for (let i = 0; i < 6; i++) {
      w.conversation.assigneeId = null
      const at = new Date(NOW.getTime() + i * 60_000)
      picks.push((await w.svc.route('cv1', 'conversation_created', { now: at }))!.pickedId)
    }
    expect(picks).toEqual(['ana', 'bia', 'caio', 'ana', 'bia', 'caio'])
  })

  it('gives the next conversation to whoever waited longest, never-assigned first', async () => {
    const w = makeWorld([
      member('recent', { lastAutoAssignedAt: new Date('2026-05-04T14:00:00Z') }),
      member('older', { lastAutoAssignedAt: new Date('2026-05-04T09:00:00Z') }),
      member('never'),
    ])
    const first = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(first?.pickedId).toBe('never')
    w.conversation.assigneeId = null
    const second = await w.svc.route('cv1', 'conversation_created', {
      now: new Date(NOW.getTime() + 1000),
    })
    expect(second?.pickedId).toBe('older')
  })

  it('an agent coming on shift joins the rotation at the front', async () => {
    const members = [member('ana'), member('bia', { availabilities: OFF_SHIFT })]
    const w = makeWorld(members)
    expect((await w.svc.route('cv1', 'conversation_created', { now: NOW }))?.pickedId).toBe('ana')
    members[1]!.availabilities = ON_SHIFT
    w.conversation.assigneeId = null
    const next = await w.svc.route('cv1', 'conversation_created', {
      now: new Date(NOW.getTime() + 1000),
    })
    expect(next?.pickedId).toBe('bia')
  })

  it('moves on to the next agent when another routing claimed the first one', async () => {
    const w = makeWorld([member('ana'), member('bia')])
    // Simulate a concurrent routing that took "ana" between read and claim.
    w.prisma.accountMember.updateMany.mockResolvedValueOnce({ count: 0 })
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out?.pickedId).toBe('bia')
  })

  it('leaves the conversation in the queue if every claim was lost', async () => {
    const w = makeWorld([member('ana')])
    w.prisma.accountMember.updateMany.mockResolvedValue({ count: 0 })
    const out = await w.svc.route('cv1', 'conversation_created', { now: NOW })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
  })
})

// ─── when routing runs at all ───────────────────────────────────────

describe('AssignmentService.route: guards', () => {
  it('returns null for an unknown conversation', async () => {
    const w = makeWorld([member('a')])
    expect(await w.svc.route('nope', 'conversation_created', { now: NOW })).toBeNull()
  })

  it('never routes a resolved conversation', async () => {
    const w = makeWorld([member('a')], { status: 'RESOLVED' })
    const out = await w.svc.route('cv1', 'manual', { now: NOW, force: true })
    expect(out).toEqual({ assigneeId: null, pickedId: null })
    expect(w.prisma.accountMember.findMany).not.toHaveBeenCalled()
  })

  it('does not pull an agent in while the bot still drives the conversation', async () => {
    const w = makeWorld([member('a')], { controlMode: 'BOT' })
    for (const trigger of ['conversation_created', 'conversation_reopened', 'team_changed'] as const) {
      const out = await w.svc.route('cv1', trigger, { now: NOW })
      expect(out?.pickedId).toBeNull()
    }
    expect(w.prisma.accountMember.findMany).not.toHaveBeenCalled()
  })

  it('routes a bot handoff even before control has flipped (AI handoff tool)', async () => {
    const w = makeWorld([member('a')], { controlMode: 'BOT' })
    const out = await w.svc.route('cv1', 'bot_handoff', { now: NOW })
    expect(out?.pickedId).toBe('a')
  })

  it('a forced manual request re-picks even with an eligible assignee', async () => {
    const w = makeWorld(
      [member('a', { lastAutoAssignedAt: new Date('2026-05-04T14:00:00Z') }), member('b')],
      { assigneeId: 'a', controlMode: 'BOT' },
    )
    const out = await w.svc.route('cv1', 'manual', { now: NOW, force: true })
    expect(out).toEqual({ assigneeId: 'b', pickedId: 'b' })
  })

  it('a forced re-pick that lands on the current assignee writes nothing', async () => {
    const w = makeWorld([member('a')], { assigneeId: 'a' })
    const out = await w.svc.route('cv1', 'manual', { now: NOW, force: true })
    expect(out).toEqual({ assigneeId: 'a', pickedId: 'a' })
    expect(w.prisma.conversation.update).not.toHaveBeenCalled()
    expect(w.activity.log).not.toHaveBeenCalled()
  })

  it('a forced re-pick with nobody available leaves the assignee alone', async () => {
    const w = makeWorld([member('a', { availabilities: OFF_SHIFT })], { assigneeId: 'a' })
    const out = await w.svc.route('cv1', 'manual', { now: NOW, force: true })
    expect(out).toEqual({ assigneeId: 'a', pickedId: null })
  })

  describe('failures', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    it('never throws: a database error is logged and the outcome is unknown', async () => {
      const w = makeWorld([member('a')])
      w.prisma.accountMember.findMany.mockRejectedValue(new Error('db down'))
      expect(await w.svc.route('cv1', 'bot_handoff', { now: NOW })).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith('routing (bot_handoff) failed for cv1: db down')
    })

    it('logs non-Error rejections too', async () => {
      const w = makeWorld([member('a')])
      w.prisma.conversation.findUnique.mockRejectedValue('boom')
      expect(await w.svc.route('cv1', 'manual', { now: NOW })).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith('routing (manual) failed for cv1: boom')
    })
  })
})
