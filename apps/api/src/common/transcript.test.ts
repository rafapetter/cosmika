import { describe, expect, it } from 'vitest'

import { formatTranscript, TRANSCRIPT_CHARS } from './transcript'

describe('formatTranscript', () => {
  const rows = [
    { senderType: 'CONTACT', content: 'oi' },
    { senderType: 'USER', content: 'olá' },
    { senderType: 'AGENT_BOT', content: 'menu' },
  ]

  it('labels speakers in the account language, Portuguese by default and for unknown locales', () => {
    expect(formatTranscript(rows)).toBe('Cliente: oi\nAtendente: olá\nBot: menu')
    expect(formatTranscript(rows, 'es')).toBe('Cliente: oi\nAgente: olá\nBot: menu')
    expect(formatTranscript(rows, 'en')).toBe('Customer: oi\nAgent: olá\nBot: menu')
    expect(formatTranscript(rows, 'xx')).toBe('Cliente: oi\nAtendente: olá\nBot: menu')
  })

  it('flattens, clips, drops empties and reads an unknown sender as the bot', () => {
    const long = 'a'.repeat(TRANSCRIPT_CHARS + 50)
    expect(
      formatTranscript([
        { senderType: 'CONTACT', content: 'linha\n  dois ' },
        { senderType: 'CONTACT', content: '   ' },
        { senderType: 'CONTACT', content: null },
        { senderType: 'SOMETHING', content: long },
      ]),
    ).toBe(`Cliente: linha dois\nBot: ${'a'.repeat(TRANSCRIPT_CHARS)}…`)
  })
})
