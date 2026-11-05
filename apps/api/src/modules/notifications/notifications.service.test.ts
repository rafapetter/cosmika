import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsService } from './notifications.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    notification: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'n1' }),
    },
    notificationPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]), // default: no opt-outs
      upsert: vi.fn(),
    },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const makeService = (p: Prisma) => new NotificationsService(p as never)
const MEMBER = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'AGENT', isActive: true }

describe('NotificationsService.list', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('defaults limit to 25', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notification.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', {} as never)
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 }),
    )
  })

  it('caps limit at 100', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notification.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', { limit: 999 } as never)
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    )
  })

  it('honors onlyUnread filter when true', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notification.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', { onlyUnread: true } as never)
    const arg = prisma.notification.findMany.mock.calls[0]![0]
    expect(arg.where).toEqual(expect.objectContaining({ readAt: null }))
  })

  it('omits readAt filter when onlyUnread is falsy', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notification.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', { onlyUnread: false } as never)
    const arg = prisma.notification.findMany.mock.calls[0]![0]
    expect(arg.where).not.toHaveProperty('readAt')
  })

  it('scopes per-user — user A never sees user B\'s notifications', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notification.findMany.mockResolvedValue([])
    await makeService(prisma).list('u1', 'acc1', {} as never)
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountId: 'acc1', userId: 'u1' }),
      }),
    )
  })
})

describe('NotificationsService.unreadCount', () => {
  it('403 non-member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).unreadCount('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('returns count from prisma scoped to (acc, user, unread)', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(MEMBER)
    p.notification.count.mockResolvedValue(7)
    expect(await makeService(p).unreadCount('u1', 'acc1')).toBe(7)
    expect(p.notification.count).toHaveBeenCalledWith({
      where: { accountId: 'acc1', userId: 'u1', readAt: null },
    })
  })
})

describe('NotificationsService.markRead', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
  })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).markRead('u1', 'acc1', 'n1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown notification', async () => {
    prisma.notification.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).markRead('u1', 'acc1', 'n1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (wrong account)', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      accountId: 'other',
      userId: 'u1',
    })
    await expect(makeService(prisma).markRead('u1', 'acc1', 'n1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (wrong user — per-user privacy)', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      accountId: 'acc1',
      userId: 'other-user',
    })
    await expect(makeService(prisma).markRead('u1', 'acc1', 'n1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('sets readAt when unread', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      accountId: 'acc1',
      userId: 'u1',
      readAt: null,
    })
    await makeService(prisma).markRead('u1', 'acc1', 'n1')
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { readAt: expect.any(Date) },
    })
  })

  it('is a no-op when already read (avoids re-touching the timestamp)', async () => {
    prisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      accountId: 'acc1',
      userId: 'u1',
      readAt: new Date('2026-01-01'),
    })
    await makeService(prisma).markRead('u1', 'acc1', 'n1')
    expect(prisma.notification.update).not.toHaveBeenCalled()
  })
})

describe('NotificationsService.markAllRead', () => {
  it('403 non-member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).markAllRead('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('updates all unread to read + returns count', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(MEMBER)
    p.notification.updateMany.mockResolvedValue({ count: 4 })
    expect(await makeService(p).markAllRead('u1', 'acc1')).toEqual({ updated: 4 })
    expect(p.notification.updateMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1', userId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) },
    })
  })
})

describe('NotificationsService.createMentions', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('drops the self-mention (mentioner is excluded from targets)', async () => {
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u1', 'u2'],
    })
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ userId: 'u2', type: 'MENTION' }),
      ],
      skipDuplicates: true,
    })
  })

  it('does nothing when there are no real targets (only self)', async () => {
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u1'],
    })
    expect(prisma.notification.createMany).not.toHaveBeenCalled()
  })

  it('does nothing when targetUserIds is empty', async () => {
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: [],
    })
    expect(prisma.notification.createMany).not.toHaveBeenCalled()
  })

  it('creates one row per non-self target, includes the message + conv refs', async () => {
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u2', 'u3', 'u4'],
    })
    const arg = prisma.notification.createMany.mock.calls[0]![0]
    expect(arg.data).toHaveLength(3)
    for (const row of arg.data) {
      expect(row.accountId).toBe('acc1')
      expect(row.conversationId).toBe('cv1')
      expect(row.messageId).toBe('m1')
      expect(row.mentionedByUserId).toBe('u1')
      expect(row.type).toBe('MENTION')
    }
    expect(arg.skipDuplicates).toBe(true)
  })
})

describe('NotificationsService.toDTO', () => {
  const svc = new NotificationsService(makePrisma() as never)

  it('maps a fully-hydrated mention with conversation + actor', () => {
    const dto = svc.toDTO(
      {
        id: 'n1',
        accountId: 'acc1',
        userId: 'u1',
        type: 'MENTION',
        conversationId: 'cv1',
        messageId: 'm1',
        mentionedByUserId: 'u2',
        readAt: new Date('2026-02-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        mentionedBy: { id: 'u2', email: 'b@c.com', fullName: 'B' },
        conversation: { id: 'cv1', displayId: 42, contactId: 'ct1', contact: { name: 'Alice' } },
      } as never,
      'preview text',
    )
    expect(dto.id).toBe('n1')
    expect(dto.mentionedBy).toEqual({ id: 'u2', email: 'b@c.com', fullName: 'B' })
    expect(dto.conversation).toEqual({ id: 'cv1', displayId: 42, contactName: 'Alice' })
    expect(dto.messagePreview).toBe('preview text')
    expect(dto.readAt).toBe('2026-02-01T00:00:00.000Z')
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('emits null fields when actor / conversation / preview / readAt are absent', () => {
    const dto = svc.toDTO({
      id: 'n1',
      accountId: 'acc1',
      userId: 'u1',
      type: 'MENTION',
      conversationId: null,
      messageId: null,
      mentionedByUserId: null,
      readAt: null,
      createdAt: new Date(),
      mentionedBy: null,
      conversation: null,
    } as never)
    expect(dto.mentionedBy).toBeNull()
    expect(dto.conversation).toBeNull()
    expect(dto.messagePreview).toBeNull()
    expect(dto.readAt).toBeNull()
  })

  it('handles conversation with null contact (deleted contact case)', () => {
    const dto = svc.toDTO({
      id: 'n1',
      accountId: 'acc1',
      userId: 'u1',
      type: 'MENTION',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u2',
      readAt: null,
      createdAt: new Date(),
      mentionedBy: null,
      conversation: { id: 'cv1', displayId: 1, contactId: 'ct1', contact: null },
    } as never)
    expect(dto.conversation?.contactName).toBeNull()
  })
})

describe('NotificationsService preferences', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('getPreferences 403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).getPreferences('u1', 'acc1')).rejects.toThrow()
  })

  it('getPreferences defaults to all-on when no row exists', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notificationPreference.findUnique.mockResolvedValue(null)
    expect(await makeService(prisma).getPreferences('u1', 'acc1')).toEqual({
      mentionsEnabled: true,
      assignmentsEnabled: true,
    })
  })

  it('getPreferences reflects a stored row', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notificationPreference.findUnique.mockResolvedValue({
      mentionsEnabled: false,
      assignmentsEnabled: true,
    })
    expect(await makeService(prisma).getPreferences('u1', 'acc1')).toEqual({
      mentionsEnabled: false,
      assignmentsEnabled: true,
    })
  })

  it('updatePreferences upserts only the provided fields and returns the row', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notificationPreference.upsert.mockResolvedValue({
      mentionsEnabled: false,
      assignmentsEnabled: true,
    })
    const out = await makeService(prisma).updatePreferences('u1', 'acc1', {
      mentionsEnabled: false,
    })
    expect(out).toEqual({ mentionsEnabled: false, assignmentsEnabled: true })
    const call = prisma.notificationPreference.upsert.mock.calls[0]![0]
    expect(call.where).toEqual({ accountId_userId: { accountId: 'acc1', userId: 'u1' } })
    expect(call.create.mentionsEnabled).toBe(false)
    expect(call.update.mentionsEnabled).toBe(false)
    // assignmentsEnabled not supplied → not in the create/update patch
    expect('assignmentsEnabled' in call.update).toBe(false)
  })

  it('updatePreferences applies assignmentsEnabled when supplied', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
    prisma.notificationPreference.upsert.mockResolvedValue({
      mentionsEnabled: true,
      assignmentsEnabled: false,
    })
    await makeService(prisma).updatePreferences('u1', 'acc1', {
      assignmentsEnabled: false,
    })
    const call = prisma.notificationPreference.upsert.mock.calls[0]![0]
    expect(call.create.assignmentsEnabled).toBe(false)
    expect(call.update.assignmentsEnabled).toBe(false)
  })

  it('createMentions skips a target who muted mentions', async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'u3' }])
    prisma.notification.createMany.mockResolvedValue({ count: 1 })
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u2', 'u3'],
    })
    const arg = prisma.notification.createMany.mock.calls[0]![0]
    // only u2 (u3 opted out)
    expect(arg.data.map((d: { userId: string }) => d.userId)).toEqual(['u2'])
  })

  it('createMentions creates nothing when every target muted mentions', async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'u2' }])
    await makeService(prisma).createMentions({
      accountId: 'acc1',
      conversationId: 'cv1',
      messageId: 'm1',
      mentionedByUserId: 'u1',
      targetUserIds: ['u2'],
    })
    expect(prisma.notification.createMany).not.toHaveBeenCalled()
  })
})

// Nothing in the product ever created one of these, while Profile showed an
// "Assignments" toggle switched on. These are the rules that make the toggle
// tell the truth.
describe('NotificationsService.createAssignment', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(MEMBER)
  })

  const base = {
    accountId: 'acc1',
    conversationId: 'cv1',
    assigneeId: 'u1',
    assignedByUserId: 'u2',
    previousAssigneeId: null,
  }

  it('tells the new owner who handed it over', async () => {
    await makeService(prisma).createAssignment(base)

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc1',
        userId: 'u1',
        type: 'ASSIGNMENT',
        conversationId: 'cv1',
        mentionedByUserId: 'u2',
      },
    })
  })

  it('leaves the actor null for automatic distribution', async () => {
    await makeService(prisma).createAssignment({ ...base, assignedByUserId: null })

    // The bell reads this to say "assigned to you" instead of naming somebody
    // who never chose it.
    expect(prisma.notification.create.mock.calls[0]![0].data.mentionedByUserId).toBeNull()
  })

  it('says nothing when the assignee did not change', async () => {
    await makeService(prisma).createAssignment({
      ...base,
      assigneeId: 'u1',
      previousAssigneeId: 'u1',
    })

    expect(prisma.notification.create).not.toHaveBeenCalled()
    expect(prisma.notification.updateMany).not.toHaveBeenCalled()
  })

  it('does not notify someone who assigned it to themselves', async () => {
    await makeService(prisma).createAssignment({
      ...base,
      assigneeId: 'u1',
      assignedByUserId: 'u1',
    })

    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('respects an opt-out', async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'u1' }])
    await makeService(prisma).createAssignment(base)

    expect(prisma.notificationPreference.findMany.mock.calls[0]![0].where).toMatchObject({
      assignmentsEnabled: false,
    })
    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('never notifies a bot, which has no bell', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...MEMBER, role: 'BOT' })
    await makeService(prisma).createAssignment(base)

    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('never notifies a deactivated member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...MEMBER, isActive: false })
    await makeService(prisma).createAssignment(base)

    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('never notifies someone who is not a member at all', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await makeService(prisma).createAssignment(base)

    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  // Instead of suppressing rapid reassignment with an arbitrary time window:
  // every real change is announced, and losing the conversation retires the
  // previous owner's pending one.
  it('clears the previous owner\'s pending notification', async () => {
    await makeService(prisma).createAssignment({ ...base, previousAssigneeId: 'u9' })

    const where = prisma.notification.updateMany.mock.calls[0]![0].where
    expect(where).toEqual({
      accountId: 'acc1',
      userId: 'u9',
      conversationId: 'cv1',
      type: 'ASSIGNMENT',
      readAt: null,
    })
    expect(prisma.notification.create).toHaveBeenCalled()
  })

  it('clears the previous owner even when nobody takes over', async () => {
    await makeService(prisma).createAssignment({
      ...base,
      assigneeId: null,
      previousAssigneeId: 'u9',
    })

    expect(prisma.notification.updateMany).toHaveBeenCalled()
    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  it('clears the previous owner even when the new one opted out', async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'u1' }])
    await makeService(prisma).createAssignment({ ...base, previousAssigneeId: 'u9' })

    expect(prisma.notification.updateMany).toHaveBeenCalled()
    expect(prisma.notification.create).not.toHaveBeenCalled()
  })

  // The fallback hands a conversation to somebody who is not working. That is a
  // coverage hole, and the person who received it cannot fix it from bed.
  describe('the off-shift fallback also warns whoever can fix it', () => {
    const fallback = { ...base, offlineFallback: true }

    it('warns the administrators and supervisors, not the whole inbox', async () => {
      prisma.accountMember.findMany.mockResolvedValue([
        { userId: 'boss1' },
        { userId: 'boss2' },
      ])

      await makeService(prisma).createAssignment(fallback)

      const where = prisma.accountMember.findMany.mock.calls[0]![0].where
      expect(where).toMatchObject({
        accountId: 'acc1',
        isActive: true,
        role: { in: ['ADMINISTRATOR', 'SUPERVISOR'] },
        // The agent who got it already has an ASSIGNMENT row; telling them
        // twice about one event is noise.
        userId: { not: 'u1' },
      })
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          { accountId: 'acc1', userId: 'boss1', type: 'ASSIGNMENT_FALLBACK', conversationId: 'cv1' },
          { accountId: 'acc1', userId: 'boss2', type: 'ASSIGNMENT_FALLBACK', conversationId: 'cv1' },
        ],
        skipDuplicates: true,
      })
    })

    it('names nobody as the author, because nobody did it', async () => {
      prisma.accountMember.findMany.mockResolvedValue([{ userId: 'boss1' }])

      await makeService(prisma).createAssignment(fallback)

      // mentionedByUserId means who caused this. Putting the assignee there
      // would make the column lie; the bell says what happened without a name.
      const row = prisma.notification.createMany.mock.calls[0]![0].data[0]
      expect(row).not.toHaveProperty('mentionedByUserId')
    })

    it('still sends the ordinary assignment notice to the agent', async () => {
      prisma.accountMember.findMany.mockResolvedValue([{ userId: 'boss1' }])

      await makeService(prisma).createAssignment(fallback)

      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'u1', type: 'ASSIGNMENT' }),
      })
    })

    it('says nothing extra on an ordinary round robin', async () => {
      await makeService(prisma).createAssignment({ ...base, offlineFallback: false })

      expect(prisma.accountMember.findMany).not.toHaveBeenCalled()
      expect(prisma.notification.createMany).not.toHaveBeenCalled()
    })

    it('respects the same mute the assignment notice respects', async () => {
      prisma.accountMember.findMany.mockResolvedValue([{ userId: 'boss1' }])
      prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'boss1' }])

      await makeService(prisma).createAssignment(fallback)

      expect(prisma.notification.createMany).not.toHaveBeenCalled()
    })

    it('writes nothing when the account has no supervisor to tell', async () => {
      prisma.accountMember.findMany.mockResolvedValue([])

      await makeService(prisma).createAssignment(fallback)

      expect(prisma.notification.createMany).not.toHaveBeenCalled()
      // The agent is still told, which is the part the customer depends on.
      expect(prisma.notification.create).toHaveBeenCalled()
    })
  })

  it('never costs someone their assignment when the bell write fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    prisma.notification.create.mockRejectedValue(new Error('db down'))
    await expect(makeService(prisma).createAssignment(base)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()

    prisma.notification.create.mockRejectedValue('a string blow-up')
    await expect(makeService(prisma).createAssignment(base)).resolves.toBeUndefined()
    err.mockRestore()
  })
})

describe('NotificationsService.createSlaBreach', () => {
  function prismaFor() {
    const p = makePrisma() as Prisma & { teamMember: { findMany: ReturnType<typeof vi.fn> } }
    p.teamMember = { findMany: vi.fn().mockResolvedValue([{ userId: 'tm1' }, { userId: 'tm2' }]) }
    p.accountMember.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.role && (where.role as { in?: string[] }).in) return [{ userId: 'sup1' }]
      // Active, non-bot filter: everyone asked except 'gone'.
      const ids = ((where.userId as { in: string[] }).in ?? []).filter((id) => id !== 'gone')
      return ids.map((userId) => ({ userId }))
    })
    return p
  }

  it('tells the assignee and the supervisors, and returns who was told', async () => {
    const p = prismaFor()
    const out = await makeService(p).createSlaBreach({
      accountId: 'acc1', conversationId: 'cv1', assigneeId: 'u7', teamId: 't1',
    })
    expect(out).toEqual(['u7', 'sup1'])
    expect(p.teamMember.findMany).not.toHaveBeenCalled()
    expect(p.notification.createMany).toHaveBeenCalledWith({
      data: [
        { accountId: 'acc1', userId: 'u7', type: 'SLA_BREACH', conversationId: 'cv1' },
        { accountId: 'acc1', userId: 'sup1', type: 'SLA_BREACH', conversationId: 'cv1' },
      ],
      skipDuplicates: true,
    })
  })

  it('tells the whole team when nobody has the conversation, minus inactive and muted people', async () => {
    const p = prismaFor()
    p.teamMember.findMany.mockResolvedValue([{ userId: 'tm1' }, { userId: 'gone' }])
    p.notificationPreference.findMany.mockResolvedValue([{ userId: 'sup1' }])
    const out = await makeService(p).createSlaBreach({
      accountId: 'acc1', conversationId: 'cv1', assigneeId: null, teamId: 't1',
    })
    expect(out).toEqual(['tm1'])
  })

  it('without assignee or team only the supervisors hear, and nobody means no rows', async () => {
    const p = prismaFor()
    await expect(
      makeService(p).createSlaBreach({ accountId: 'acc1', conversationId: 'cv1', assigneeId: null, teamId: null }),
    ).resolves.toEqual(['sup1'])
    p.notificationPreference.findMany.mockResolvedValue([{ userId: 'sup1' }])
    p.notification.createMany.mockClear()
    await expect(
      makeService(p).createSlaBreach({ accountId: 'acc1', conversationId: 'cv1', assigneeId: null, teamId: null }),
    ).resolves.toEqual([])
    expect(p.notification.createMany).not.toHaveBeenCalled()
  })

  it('never throws, so the sweep goes on', async () => {
    const p = prismaFor()
    p.accountMember.findMany.mockRejectedValueOnce(new Error('db down'))
    await expect(
      makeService(p).createSlaBreach({ accountId: 'acc1', conversationId: 'cv1', assigneeId: 'u7', teamId: null }),
    ).resolves.toEqual([])
    p.accountMember.findMany.mockRejectedValueOnce('string')
    await expect(
      makeService(p).createSlaBreach({ accountId: 'acc1', conversationId: 'cv1', assigneeId: 'u7', teamId: null }),
    ).resolves.toEqual([])
  })
})
