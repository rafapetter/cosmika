import type { MessageDTO } from '@cosmika/shared'

/**
 * Messages the agent just sent, shown before the server confirms them.
 *
 * The send waits for WhatsApp to accept the message (so a refusal shows as a
 * failure, not as a tick), which takes a second or more from Brazil. Until
 * then the composer was empty and the thread had nothing to show, so it
 * looked like the message had vanished. The bubble now appears at once with a
 * clock and turns into the real row when the server answers.
 */

const TEMP_PREFIX = 'pending-'

export function isPendingLocal(m: Pick<MessageDTO, 'id'>): boolean {
  return m.id.startsWith(TEMP_PREFIX)
}

export function optimisticMessage(args: {
  seq: number
  conversationId: string
  accountId: string
  userId: string
  content: string
  isPrivate: boolean
  inReplyToId?: string
  contentAttributes?: Record<string, unknown>
  now?: Date
}): MessageDTO {
  const at = (args.now ?? new Date()).toISOString()
  return {
    id: `${TEMP_PREFIX}${args.seq}`,
    conversationId: args.conversationId,
    inboxId: '',
    accountId: args.accountId,
    senderType: 'USER',
    senderUserId: args.userId,
    senderAgentBotId: null,
    senderContactId: null,
    content: args.content,
    contentType: 'TEXT',
    contentAttributes: args.contentAttributes ?? {},
    status: 'PENDING',
    isPrivate: args.isPrivate,
    externalSourceId: null,
    inReplyToId: args.inReplyToId ?? null,
    attachments: [],
    createdAt: at,
    updatedAt: at,
  }
}

// A reload can land between the server writing the row and answering the
// send (the realtime nudge goes out first). The same text from the same
// person, written no earlier than a little before we sent it, is that row.
const SAME_SEND_SLACK_MS = 10_000

function isSameSend(server: MessageDTO, pending: MessageDTO): boolean {
  return (
    !isPendingLocal(server) &&
    server.senderType === 'USER' &&
    server.senderUserId === pending.senderUserId &&
    server.isPrivate === pending.isPrivate &&
    (server.content ?? '') === (pending.content ?? '') &&
    Date.parse(server.createdAt) >= Date.parse(pending.createdAt) - SAME_SEND_SLACK_MS
  )
}

/**
 * The thread as the server sees it, plus the sends it has not confirmed yet.
 * A pending bubble whose real row is already in the list is not repeated.
 */
export function mergePending(server: MessageDTO[], pending: MessageDTO[]): MessageDTO[] {
  const used = new Set<string>()
  const extra: MessageDTO[] = []
  for (const p of pending) {
    const twin = server.find((s) => !used.has(s.id) && isSameSend(s, p))
    if (twin) used.add(twin.id)
    else extra.push(p)
  }
  return extra.length > 0 ? [...server, ...extra] : server
}

/** The server confirmed a send: the pending bubble becomes the real row, once. */
export function confirmPending(
  list: MessageDTO[],
  tempId: string,
  sent: MessageDTO,
): MessageDTO[] {
  const hasReal = list.some((m) => m.id === sent.id)
  const out: MessageDTO[] = []
  for (const m of list) {
    if (m.id === tempId) {
      if (!hasReal) out.push(sent)
    } else if (m.id === sent.id) {
      out.push(sent)
    } else {
      out.push(m)
    }
  }
  if (!hasReal && !list.some((m) => m.id === tempId)) out.push(sent)
  return out
}

type Reaction = { emoji: string } & Record<string, unknown>
export type Reactions = { contact?: Reaction; business?: Reaction }

/** The reactions on a message, ignoring anything malformed. */
export function reactionsOf(m: Pick<MessageDTO, 'contentAttributes'>): Reactions {
  const raw = (m.contentAttributes ?? {}).reactions
  if (!raw || typeof raw !== 'object') return {}
  const out: Reactions = {}
  for (const side of ['contact', 'business'] as const) {
    const r = (raw as Record<string, unknown>)[side]
    if (r && typeof r === 'object' && typeof (r as Reaction).emoji === 'string' && (r as Reaction).emoji) {
      out[side] = r as Reaction
    }
  }
  return out
}

/** The message with its reaction set replaced (what the realtime event carries). */
export function withReactions(m: MessageDTO, reactions: Record<string, unknown>): MessageDTO {
  return { ...m, contentAttributes: { ...m.contentAttributes, reactions } }
}

/** Our side's reaction set to `emoji`, or taken off when it is empty. */
export function withBusinessReaction(m: MessageDTO, emoji: string): MessageDTO {
  const current = { ...((m.contentAttributes.reactions ?? {}) as Record<string, unknown>) }
  if (emoji) current.business = { emoji }
  else delete current.business
  return withReactions(m, current)
}

/**
 * AI suggestions that are no longer the next thing to say. A suggestion
 * answers the conversation as it was when it was written: once anyone spoke
 * after it (the contact, an agent, the bot) or a newer suggestion came, it is
 * stale and only clutters the thread. Internal notes and system rows don't
 * count, since the contact never saw them. Hidden on screen only; nothing is
 * deleted.
 */
export function withoutStaleDrafts<
  M extends Pick<MessageDTO, 'id' | 'isPrivate' | 'senderType' | 'status'>,
>(messages: M[]): M[] {
  const isDraft = (m: M) => m.isPrivate && m.senderType === 'AGENT_BOT' && m.status === 'PENDING'
  const stale = new Set<string>()
  let somethingAfter = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (isDraft(m)) {
      if (somethingAfter) stale.add(m.id)
      somethingAfter = true
    } else if (!m.isPrivate && m.senderType !== 'SYSTEM') {
      somethingAfter = true
    }
  }
  return stale.size > 0 ? messages.filter((m) => !stale.has(m.id)) : messages
}
