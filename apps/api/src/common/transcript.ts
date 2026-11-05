// A conversation as plain "Speaker: text" lines, for a model that needs to
// know what was already said.
//
// Two AI paths used to see a single message in isolation: the flow's
// off-script classifier (it asked a customer with a stopped bot for an "order
// number") and the AI agent, which only remembered its own session and drafted
// "Olá! Como posso ajudar?" to a customer who had been talking to the flow for
// forty minutes (conversation 8741, 2026-10-13). Both now read this.

export type TranscriptRow = { senderType: string; content: string | null }

/** Per-message cap: enough to know what was asked, cheap on a long thread. */
export const TRANSCRIPT_CHARS = 300

const SPEAKERS: Record<string, Record<string, string>> = {
  'pt-BR': { CONTACT: 'Cliente', AGENT_BOT: 'Bot', USER: 'Atendente' },
  es: { CONTACT: 'Cliente', AGENT_BOT: 'Bot', USER: 'Agente' },
  en: { CONTACT: 'Customer', AGENT_BOT: 'Bot', USER: 'Agent' },
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TRANSCRIPT_CHARS ? `${flat.slice(0, TRANSCRIPT_CHARS)}…` : flat
}

/**
 * Lines in the order given (callers pass oldest first). Empty messages are
 * dropped; an unknown sender reads as the bot, the speaker a model is least
 * likely to mistake for the customer.
 */
export function formatTranscript(rows: TranscriptRow[], locale = 'pt-BR'): string {
  const speakers = SPEAKERS[locale] ?? SPEAKERS['pt-BR']!
  return rows
    .filter((m) => (m.content ?? '').trim() !== '')
    .map((m) => `${speakers[m.senderType] ?? speakers.AGENT_BOT}: ${clip(m.content ?? '')}`)
    .join('\n')
}
