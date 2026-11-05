import { describe, expect, it } from 'vitest'
import { messages } from '@cosmika/shared'

import { activityText, type Translate } from './activity-text'

// The real bundles, so a missing key fails here instead of reaching a desk.
function translator(locale: 'pt-BR' | 'es' | 'en'): Translate {
  const bundle = messages[locale] as unknown as Record<string, Record<string, string>>
  return (key, values) => {
    const [ns, k] = key.split('.')
    const raw = bundle[ns!]?.[k!]
    if (raw === undefined) throw new Error(`missing ${locale} ${key}`)
    return raw.replace(/\{(\w+)\}/g, (_m, name: string) => values?.[name] ?? '')
  }
}
const pt = translator('pt-BR')
const note = (activity: Record<string, unknown>, content = 'Conversation something') => ({
  content,
  contentAttributes: { activity },
})

describe('activityText', () => {
  // The exact note from conversation 8741.
  it('says who got the conversation, and that nobody was on shift, in Portuguese', () => {
    expect(
      activityText(
        pt,
        note(
          { type: 'assignee', actorName: 'Automation System', from: null, to: 'Maria Souza', reason: 'no_agent_on_shift' },
          'Conversation assigned to Maria Souza by Automation System (nobody on shift)',
        ),
      ),
    ).toBe('Conversa atribuída a Maria Souza pelo sistema (ninguém no turno)')
  })

  it('names a human actor, and drops the actor when unknown', () => {
    expect(activityText(pt, note({ type: 'assignee', actorName: 'Ana', to: 'Bia' }))).toBe('Conversa atribuída a Bia por Ana')
    expect(activityText(pt, note({ type: 'assignee', to: 'Bia' }))).toBe('Conversa atribuída a Bia')
    expect(activityText(pt, note({ type: 'assignee', actorName: 'Ana', to: null }))).toBe('Conversa ficou sem responsável por Ana')
  })

  it('covers every status change', () => {
    expect(activityText(pt, note({ type: 'status', actorName: 'Ana', from: 'OPEN', to: 'RESOLVED' }))).toBe('Conversa resolvida por Ana')
    expect(activityText(pt, note({ type: 'status', from: 'RESOLVED', to: 'OPEN' }))).toBe('Conversa reaberta')
    expect(activityText(pt, note({ type: 'status', from: 'OPEN', to: 'PENDING' }))).toBe('Conversa marcada como pendente')
    expect(activityText(pt, note({ type: 'status', from: 'PENDING', to: 'OPEN' }))).toBe('Conversa marcada como aberta')
    expect(activityText(pt, note({ type: 'status', from: 'OPEN', to: 'WEIRD' }, 'stored'))).toBe('stored')
  })

  it('recognises an inactivity close by its reason, and older rows by their stored sentence', () => {
    expect(
      activityText(pt, note({ type: 'status', actorName: 'Automation System', from: 'OPEN', to: 'RESOLVED', reason: 'inactivity' })),
    ).toBe('Conversa encerrada automaticamente por inatividade')
    expect(
      activityText(
        pt,
        note({ type: 'status', actorName: 'Automation System', from: 'OPEN', to: 'RESOLVED' }, 'Conversation auto-resolved after 7 days of inactivity'),
      ),
    ).toBe('Conversa encerrada automaticamente por inatividade')
  })

  it('covers teams, labels and priority', () => {
    expect(activityText(pt, note({ type: 'team', actorName: 'Ana', to: 'Suporte' }))).toBe('Conversa enviada para a equipe Suporte por Ana')
    expect(activityText(pt, note({ type: 'team', to: null }))).toBe('Conversa removida da equipe')
    expect(activityText(pt, note({ type: 'label', actorName: 'Ana', to: 'VIP' }))).toBe('Etiqueta VIP adicionada por Ana')
    expect(activityText(pt, note({ type: 'label', from: 'VIP' }))).toBe('Etiqueta VIP removida')
    expect(activityText(pt, note({ type: 'label' }, 'stored'))).toBe('stored')
    expect(activityText(pt, note({ type: 'priority', actorName: 'Ana', to: 'URGENT' }))).toBe('Prioridade alterada para urgente por Ana')
    expect(activityText(pt, note({ type: 'priority', to: 'NOPE' }, 'stored'))).toBe('stored')
  })

  it('falls back to the stored sentence for anything it does not understand', () => {
    expect(activityText(pt, { content: 'plain system text' })).toBe('plain system text')
    expect(activityText(pt, { content: 'x', contentAttributes: null })).toBe('x')
    expect(activityText(pt, { content: 'x', contentAttributes: { activity: 'oops' } })).toBe('x')
    expect(activityText(pt, note({ type: 'mystery' }, 'stored'))).toBe('stored')
    expect(activityText(pt, { content: null })).toBe('-')
  })

  it('has every sentence in Spanish and English too', () => {
    const all = { type: 'assignee', actorName: 'Automation System', to: 'Gabriel', reason: 'no_agent_on_shift' }
    expect(activityText(translator('es'), note(all))).toBe('Conversación asignada a Gabriel por el sistema (nadie en turno)')
    expect(activityText(translator('en'), note(all))).toBe('Conversation assigned to Gabriel by the system (nobody on shift)')
    for (const loc of ['pt-BR', 'es', 'en'] as const) {
      const t = translator(loc)
      for (const level of ['LOW', 'NORMAL', 'HIGH', 'URGENT']) {
        expect(() => activityText(t, note({ type: 'priority', to: level }))).not.toThrow()
      }
      for (const a of [
        { type: 'status', to: 'RESOLVED' }, { type: 'status', from: 'RESOLVED', to: 'OPEN' },
        { type: 'status', to: 'PENDING' }, { type: 'status', to: 'OPEN' },
        { type: 'status', to: 'RESOLVED', reason: 'inactivity' },
        { type: 'assignee', to: null }, { type: 'team', to: 'X' }, { type: 'team' },
        { type: 'label', to: 'X' }, { type: 'label', from: 'X' }, { type: 'assignee', actorName: 'Ana', to: 'X' },
      ]) {
        expect(() => activityText(t, note(a))).not.toThrow()
      }
    }
  })
})
