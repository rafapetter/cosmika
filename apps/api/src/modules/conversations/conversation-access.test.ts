import { describe, expect, it } from 'vitest'

import { conversationAccessWhere } from './conversation-access'

const agent = { accountId: 'acc1', userId: 'u1', role: 'AGENT' as const }

describe('conversationAccessWhere', () => {
  it('lets administrators and supervisors see the whole account', () => {
    expect(conversationAccessWhere({ ...agent, role: 'ADMINISTRATOR' }, true)).toEqual({ accountId: 'acc1' })
    expect(conversationAccessWhere({ ...agent, role: 'SUPERVISOR' }, false)).toEqual({ accountId: 'acc1' })
  })

  it('shows an agent their inboxes, assignments and participations', () => {
    expect(conversationAccessWhere(agent, false)).toEqual({
      accountId: 'acc1',
      OR: [
        { assigneeId: 'u1' },
        { participants: { some: { userId: 'u1' } } },
        { inbox: { members: { some: { userId: 'u1' } } } },
      ],
    })
  })

  it('with team scoping, keeps other teams\' conversations out of the inbox part', () => {
    expect(conversationAccessWhere(agent, true)).toEqual({
      accountId: 'acc1',
      OR: [
        { assigneeId: 'u1' },
        { participants: { some: { userId: 'u1' } } },
        {
          AND: [
            { inbox: { members: { some: { userId: 'u1' } } } },
            { OR: [{ teamId: null }, { team: { members: { some: { userId: 'u1' } } } }] },
          ],
        },
      ],
    })
  })
})
