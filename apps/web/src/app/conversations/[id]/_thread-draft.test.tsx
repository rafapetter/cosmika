// The rules that decide whether a private AGENT_BOT message is an AI
// suggestion the agent can send, or just an internal note from a flow.
import { describe, expect, it } from 'vitest'

import { isAgentDraft, draftBody } from './_thread'

const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    senderType: 'AGENT_BOT',
    isPrivate: true,
    status: 'PENDING',
    content: '[draft] Olá!',
    attachments: [],
    createdAt: new Date().toISOString(),
    ...over,
  }) as never

describe('isAgentDraft', () => {
  it('accepts a pending private bot message', () => {
    expect(isAgentDraft(msg())).toBe(true)
  })

  it('rejects a flow internal note, which is private but already sent', () => {
    expect(isAgentDraft(msg({ status: 'SENT' }))).toBe(false)
  })

  it('rejects anything public, or from a human', () => {
    expect(isAgentDraft(msg({ isPrivate: false }))).toBe(false)
    expect(isAgentDraft(msg({ senderType: 'USER' }))).toBe(false)
  })
})

describe('draftBody', () => {
  it('strips the storage marker', () => {
    expect(draftBody(msg())).toBe('Olá!')
  })

  it('passes through content that has no marker, and handles null', () => {
    expect(draftBody(msg({ content: 'sem marcador' }))).toBe('sem marcador')
    expect(draftBody(msg({ content: null }))).toBe('')
  })
})
