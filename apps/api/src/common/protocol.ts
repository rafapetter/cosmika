import { randomInt } from 'node:crypto'

/**
 * Service protocols: the number a contact is told and can quote back.
 *
 * One protocol covers a "case": every conversation of the same contact, on
 * any channel, while one is still open or within PROTOCOL_REUSE_MS after the
 * last one closed. Starting on Webchat and continuing on WhatsApp keeps it.
 */
export const PROTOCOL_REUSE_MS = 24 * 60 * 60 * 1000

/** `YYYYMMDD-NNNNNN`, the date in the account's sense of "today" (São Paulo). */
export function newProtocol(now: Date = new Date(), timeZone = 'America/Sao_Paulo'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return `${parts.replace(/-/g, '')}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`
}

/** Whether a previous conversation's protocol still covers a new one. */
export function protocolStillOpen(
  previous: { status: string; resolvedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (previous.status !== 'RESOLVED') return true
  return previous.resolvedAt !== null && now.getTime() - previous.resolvedAt.getTime() <= PROTOCOL_REUSE_MS
}
