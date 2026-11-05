// Activity notes ("resolved by Ana", "assigned to Gabriel") in the account's
// language.
//
// The API stores each note twice: an English sentence in `content`, frozen at
// write time, and the facts behind it in `contentAttributes.activity`
// (type, actor, from, to, reason). The thread used to print the English
// sentence, so a Brazilian desk read "Conversation assigned to Gabriel
// Cintrão by Automation System (nobody on shift)" (conversation 8741,
// 2026-10-13). Building the sentence from the facts fixes every note already
// in the database, without a data migration. Anything it does not recognise
// falls back to the stored sentence rather than to nothing.

/** The actor name the API records for automatic actions. */
const SYSTEM_ACTOR = 'Automation System'
/** Prefix of the stored sentence for an inactivity close (rows before `reason`). */
const AUTO_RESOLVED_PREFIX = 'Conversation auto-resolved'
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

export type Translate = (key: string, values?: Record<string, string>) => string

type Activity = {
  type?: unknown
  actorName?: unknown
  from?: unknown
  to?: unknown
  reason?: unknown
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * The localized sentence for a SYSTEM message, or its stored `content` when
 * the message carries no activity facts this function understands.
 */
export function activityText(
  t: Translate,
  message: { content?: string | null; contentAttributes?: unknown },
): string {
  const fallback = message.content ?? '-'
  const attrs = (message.contentAttributes ?? {}) as Record<string, unknown>
  const a = attrs && typeof attrs === 'object' ? (attrs.activity as Activity | undefined) : undefined
  if (!a || typeof a !== 'object') return fallback

  const actor = str(a.actorName)
  const by =
    actor === SYSTEM_ACTOR
      ? t('activity.by_system')
      : actor
        ? t('activity.by', { name: actor })
        : ''
  const from = str(a.from)
  const to = str(a.to)

  switch (a.type) {
    case 'status': {
      const autoClosed =
        a.reason === 'inactivity' ||
        (fallback.startsWith(AUTO_RESOLVED_PREFIX) && to === 'RESOLVED')
      if (autoClosed) return t('activity.auto_resolved')
      if (to === 'RESOLVED') return t('activity.status_resolved', { by })
      if (from === 'RESOLVED') return t('activity.status_reopened', { by })
      if (to === 'PENDING') return t('activity.status_pending', { by })
      if (to === 'OPEN') return t('activity.status_open', { by })
      return fallback
    }
    case 'assignee': {
      if (!to) return t('activity.unassigned', { by })
      const offShift = a.reason === 'no_agent_on_shift' ? t('activity.off_shift') : ''
      return t('activity.assigned', { name: to, by }) + offShift
    }
    case 'team':
      return to ? t('activity.team_assigned', { name: to, by }) : t('activity.team_removed', { by })
    case 'label':
      if (to) return t('activity.label_added', { name: to, by })
      if (from) return t('activity.label_removed', { name: from, by })
      return fallback
    case 'priority': {
      const level = PRIORITIES.find((p) => p === to)
      return level
        ? t('activity.priority', { name: t(`activity.priority_${level.toLowerCase()}`), by })
        : fallback
    }
    default:
      return fallback
  }
}
