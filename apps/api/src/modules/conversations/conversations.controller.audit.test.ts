import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationsController } from './conversations.controller'

// PoC item 13: the operator actions the audit trail must show by user.
function setup() {
  const conversations = {
    assertConversationAccess: vi.fn(),
    update: vi.fn(),
    bulk: vi.fn(),
    autoAssign: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendTemplateMessage: vi.fn(),
    toSummaryDTO: vi.fn((c) => c),
    toMessageDTO: vi.fn((m) => m),
  }
  const audit = { record: vi.fn().mockResolvedValue({}) }
  const ctl = new ConversationsController(conversations as never, audit as never)
  return { ctl, conversations, audit }
}

const auth = { user: { id: 'u1' } } as never

describe('ConversationsController audit trail', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    s = setup()
  })

  it('records conversation.resolved when a PATCH closes an open conversation', async () => {
    s.conversations.assertConversationAccess.mockResolvedValue({
      conversation: { status: 'OPEN', assigneeId: 'u1' },
    })
    s.conversations.update.mockResolvedValue({ status: 'RESOLVED', displayId: 42 })
    await s.ctl.update(auth, 'acc1', 'c1', { status: 'RESOLVED' } as never)
    expect(s.audit.record).toHaveBeenCalledTimes(1)
    expect(s.audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'conversation.resolved',
      target: 'conversation:c1',
      metadata: { displayId: 42, from: 'OPEN' },
    })
  })

  it('does not record a resolve of an already resolved conversation', async () => {
    s.conversations.assertConversationAccess.mockResolvedValue({
      conversation: { status: 'RESOLVED', assigneeId: null },
    })
    s.conversations.update.mockResolvedValue({ status: 'RESOLVED', displayId: 42 })
    await s.ctl.update(auth, 'acc1', 'c1', { status: 'RESOLVED' } as never)
    expect(s.audit.record).not.toHaveBeenCalled()
  })

  it('records conversation.assigned with the previous owner', async () => {
    s.conversations.assertConversationAccess.mockResolvedValue({
      conversation: { status: 'OPEN', assigneeId: 'u2' },
    })
    s.conversations.update.mockResolvedValue({ status: 'OPEN', displayId: 7 })
    await s.ctl.update(auth, 'acc1', 'c1', { assigneeId: 'u3' } as never)
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conversation.assigned',
        metadata: { displayId: 7, assigneeId: 'u3', previousAssigneeId: 'u2' },
      }),
    )
  })

  it('skips the prior-state read for PATCHes that are neither resolve nor assign', async () => {
    s.conversations.update.mockResolvedValue({ status: 'OPEN' })
    await s.ctl.update(auth, 'acc1', 'c1', { priority: 'HIGH' } as never)
    expect(s.conversations.assertConversationAccess).not.toHaveBeenCalled()
    expect(s.audit.record).not.toHaveBeenCalled()
  })

  it('records one row per bulk resolve, with the ids', async () => {
    s.conversations.bulk.mockResolvedValue({ updated: 2 })
    await s.ctl.bulk(auth, 'acc1', {
      ids: ['c1', 'c2'],
      action: { type: 'STATUS', status: 'RESOLVED' },
    } as never)
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'conversation.resolved',
        metadata: { bulk: true, conversationIds: ['c1', 'c2'], updated: 2 },
      }),
    )
  })

  it('records nothing for a bulk label change or a bulk that touched nothing', async () => {
    s.conversations.bulk.mockResolvedValue({ updated: 3 })
    await s.ctl.bulk(auth, 'acc1', { ids: ['c1'], action: { type: 'APPLY_LABEL', labelId: 'l' } } as never)
    s.conversations.bulk.mockResolvedValue({ updated: 0 })
    await s.ctl.bulk(auth, 'acc1', { ids: ['c1'], action: { type: 'ASSIGN', assigneeId: 'u2' } } as never)
    expect(s.audit.record).not.toHaveBeenCalled()
  })

  it('records an auto-assign that picked someone', async () => {
    s.conversations.autoAssign.mockResolvedValue({ assigneeId: 'u9' })
    await s.ctl.autoAssign(auth, 'acc1', 'c1')
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.assigned', metadata: { assigneeId: 'u9', auto: true } }),
    )
  })

  it('records message.sent for agent replies and templates, without failing the send', async () => {
    s.conversations.sendAgentMessage.mockResolvedValue({ id: 'm1', isPrivate: true })
    s.audit.record.mockRejectedValueOnce(new Error('db down'))
    await expect(s.ctl.sendMessage(auth, 'acc1', 'c1', { content: 'x' } as never)).resolves.toEqual({
      id: 'm1',
      isPrivate: true,
    })
    s.conversations.sendTemplateMessage.mockResolvedValue({ id: 'm2', isPrivate: false })
    await s.ctl.sendTemplate(auth, 'acc1', 'c1', {} as never)
    expect(s.audit.record).toHaveBeenLastCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'message.sent',
      target: 'conversation:c1',
      metadata: { messageId: 'm2', isPrivate: false, template: true },
    })
  })
})
