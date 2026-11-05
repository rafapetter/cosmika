import type { MessageDTO } from '@cosmika/shared'
import { describe, expect, it } from 'vitest'

import {
  confirmPending,
  isPendingLocal,
  mergePending,
  optimisticMessage,
  reactionsOf,
  withBusinessReaction,
  withReactions,
  withoutStaleDrafts,
} from './optimistic-messages'

const NOW = new Date('2026-10-28T10:00:00.000Z')

function pending(content = 'oi', over: Partial<Parameters<typeof optimisticMessage>[0]> = {}) {
  return optimisticMessage({
    seq: 1,
    conversationId: 'cv1',
    accountId: 'acc1',
    userId: 'u1',
    content,
    isPrivate: false,
    now: NOW,
    ...over,
  })
}

function server(over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    ...pending(),
    id: 'm1',
    inboxId: 'inb1',
    status: 'SENT',
    createdAt: '2026-10-28T10:00:01.000Z',
    ...over,
  }
}

describe('optimisticMessage', () => {
  it('is our own text, marked as still sending', () => {
    const m = pending('olá', { inReplyToId: 'parent', isPrivate: true })
    expect(m).toMatchObject({
      id: 'pending-1',
      senderType: 'USER',
      senderUserId: 'u1',
      content: 'olá',
      status: 'PENDING',
      isPrivate: true,
      inReplyToId: 'parent',
      createdAt: NOW.toISOString(),
    })
    expect(isPendingLocal(m)).toBe(true)
    expect(m.contentAttributes).toEqual({})
    expect(pending('x', { contentAttributes: { aiDraft: 'sent' } }).contentAttributes).toEqual({
      aiDraft: 'sent',
    })
    expect(isPendingLocal(server())).toBe(false)
  })

  it('defaults to now and to no reply', () => {
    const m = optimisticMessage({
      seq: 2, conversationId: 'cv1', accountId: 'acc1', userId: 'u1', content: 'x', isPrivate: false,
    })
    expect(m.inReplyToId).toBeNull()
    expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false)
  })
})

describe('mergePending', () => {
  it('keeps a send the server has not shown yet at the end', () => {
    const p = pending()
    const list = [server({ id: 'old', content: 'antes', createdAt: '2026-10-28T09:00:00.000Z' })]
    expect(mergePending(list, [p]).map((m) => m.id)).toEqual(['old', 'pending-1'])
  })

  it('does not repeat a send whose real row already arrived', () => {
    const list = [server()]
    expect(mergePending(list, [pending()])).toBe(list)
  })

  it('matches each real row to one send only: two identical texts stay two', () => {
    const a = pending('ok', { seq: 1 })
    const b = pending('ok', { seq: 2 })
    const out = mergePending([server({ content: 'ok' })], [a, b])
    expect(out.map((m) => m.id)).toEqual(['m1', 'pending-2'])
  })

  it('does not mistake an older message, a note, someone else or the bot for the send', () => {
    const p = pending()
    for (const other of [
      server({ createdAt: '2026-10-28T09:00:00.000Z' }),
      server({ isPrivate: true }),
      server({ senderUserId: 'u2' }),
      server({ senderType: 'AGENT_BOT' }),
      server({ content: 'outra coisa' }),
      server({ content: null }),
      { ...p, id: 'pending-9' },
    ]) {
      expect(mergePending([other], [p]).map((m) => m.id)).toEqual([other.id, 'pending-1'])
    }
  })

  it('matches empty content on both sides', () => {
    const p = { ...pending(), content: null }
    expect(mergePending([server({ content: null })], [p]).map((m) => m.id)).toEqual(['m1'])
  })
})

describe('confirmPending', () => {
  it('turns the pending bubble into the real row in place', () => {
    const p = pending()
    const before = server({ id: 'a', content: 'antes' })
    const after = server({ id: 'b', content: 'depois' })
    const out = confirmPending([before, p, after], p.id, server())
    expect(out.map((m) => m.id)).toEqual(['a', 'm1', 'b'])
  })

  it('drops the bubble when a reload already brought the real row, updating it', () => {
    const p = pending()
    const sent = server({ status: 'DELIVERED' })
    const out = confirmPending([server(), p], p.id, sent)
    expect(out).toEqual([sent])
  })

  it('adds the row when the bubble is gone (a file send, or a reload in between)', () => {
    const other = server({ id: 'a' })
    expect(confirmPending([other], 'pending-7', server()).map((m) => m.id)).toEqual(['a', 'm1'])
    expect(confirmPending([other], '', server()).map((m) => m.id)).toEqual(['a', 'm1'])
  })
})

describe('reactions', () => {
  it('reads both sides and ignores anything malformed', () => {
    expect(reactionsOf(server({ contentAttributes: {} }))).toEqual({})
    expect(reactionsOf(server({ contentAttributes: { reactions: 'x' } }))).toEqual({})
    expect(reactionsOf({ contentAttributes: undefined as never })).toEqual({})
    expect(
      reactionsOf(
        server({
          contentAttributes: {
            reactions: { contact: { emoji: '👍', at: 't' }, business: { emoji: '' }, other: { emoji: '❤️' } },
          },
        }),
      ),
    ).toEqual({ contact: { emoji: '👍', at: 't' } })
    expect(
      reactionsOf(server({ contentAttributes: { reactions: { contact: 'x', business: { emoji: 3 } } } })),
    ).toEqual({})
  })

  it('replaces the whole set from a realtime event, keeping other attributes', () => {
    const m = server({ contentAttributes: { wamids: ['w'], reactions: { contact: { emoji: '👍' } } } })
    expect(withReactions(m, { business: { emoji: '🙏' } }).contentAttributes).toEqual({
      wamids: ['w'],
      reactions: { business: { emoji: '🙏' } },
    })
  })

  it('sets and removes our side only', () => {
    const m = server({ contentAttributes: { reactions: { contact: { emoji: '👍' } } } })
    const on = withBusinessReaction(m, '❤️')
    expect(on.contentAttributes.reactions).toEqual({ contact: { emoji: '👍' }, business: { emoji: '❤️' } })
    expect(withBusinessReaction(on, '').contentAttributes.reactions).toEqual({ contact: { emoji: '👍' } })
    expect(withBusinessReaction(server({ contentAttributes: {} }), '😂').contentAttributes.reactions).toEqual({
      business: { emoji: '😂' },
    })
  })
})

// Conversation 8746 (2026-10-28): a suggestion written for the contact's
// thumbs-up stayed on screen after she wrote again and a newer one came.
describe('withoutStaleDrafts', () => {
  const row = (id: string, senderType: string, over: Record<string, unknown> = {}) =>
    ({ id, senderType, isPrivate: false, status: 'SENT', ...over }) as never as MessageDTO
  const draft = (id: string) => row(id, 'AGENT_BOT', { isPrivate: true, status: 'PENDING' })
  const ids = (list: MessageDTO[]) => withoutStaleDrafts(list).map((m) => m.id)

  it('keeps the latest suggestion while nothing came after it', () => {
    const list = [row('c1', 'CONTACT'), draft('d1')]
    expect(withoutStaleDrafts(list)).toBe(list)
  })

  it('hides a suggestion once the contact, an agent or the bot spoke after it', () => {
    expect(ids([row('c1', 'CONTACT'), draft('d1'), row('c2', 'CONTACT')])).toEqual(['c1', 'c2'])
    expect(ids([draft('d1'), row('u1', 'USER')])).toEqual(['u1'])
    expect(ids([draft('d1'), row('b1', 'AGENT_BOT')])).toEqual(['b1'])
  })

  it('hides a suggestion a newer one replaced', () => {
    expect(ids([row('c1', 'CONTACT'), draft('d1'), row('c2', 'CONTACT'), draft('d2')])).toEqual([
      'c1',
      'c2',
      'd2',
    ])
    expect(ids([draft('d1'), draft('d2')])).toEqual(['d2'])
  })

  it('does not count internal notes or system rows as the conversation moving on', () => {
    const list = [
      draft('d1'),
      row('n1', 'USER', { isPrivate: true }),
      row('s1', 'SYSTEM'),
      row('f1', 'AGENT_BOT', { isPrivate: true, status: 'SENT' }),
    ]
    expect(withoutStaleDrafts(list)).toBe(list)
  })
})
