import { describe, expect, it } from 'vitest'

import { closingVariables, renderClosingMessage } from './closing-message'

const CONV = {
  displayId: 4821,
  contact: {
    name: ' Maria  Souza ',
    email: 'maria@x.com',
    phoneNumber: '+5511999990000',
    customAttributes: { protocolo: '2026-001', plano: 3, vip: true, extra: { a: 1 }, name: 'nope' },
  },
  inbox: { name: 'Financeiro' },
}

describe('closingVariables', () => {
  it('exposes the contact, the agent, the inbox and the conversation number', () => {
    const v = closingVariables(CONV, 'Rafael')
    expect(v).toMatchObject({
      'contact.name': 'Maria  Souza',
      'contact.first_name': 'Maria',
      'contact.email': 'maria@x.com',
      'contact.phone': '+5511999990000',
      name: 'Maria  Souza',
      first_name: 'Maria',
      'agent.name': 'Rafael',
      'inbox.name': 'Financeiro',
      'conversation.id': '4821',
      'contact.protocolo': '2026-001',
      'contact.plano': '3',
      'contact.vip': 'true',
    })
    // Objects are not text; a custom key never shadows a built-in field.
    expect(v['contact.extra']).toBeUndefined()
    expect(v['contact.name']).toBe('Maria  Souza')
  })

  it('a contact with nothing known (or no contact) leaves the fields empty', () => {
    const v = closingVariables({ ...CONV, contact: { name: '  ', email: null, phoneNumber: null, customAttributes: [] } }, null)
    expect(v['contact.name']).toBeNull()
    expect(v['contact.first_name']).toBeNull()
    expect(v['agent.name']).toBeNull()
    const none = closingVariables({ ...CONV, contact: null }, null)
    expect(none['contact.email']).toBeNull()
    expect(none['contact.phone']).toBeNull()
  })
})

describe('renderClosingMessage', () => {
  const vars = closingVariables(CONV, 'Rafael')
  it('fills variables and fallbacks, never leaving braces behind', () => {
    expect(
      renderClosingMessage(
        'Obrigado, {{ contact.first_name }}! Protocolo {{conversation.id}}. {{agent.name|Equipe}} · {{desconhecida}}{{contact.cpf|sem CPF }}',
        vars,
      ),
    ).toBe('Obrigado, Maria! Protocolo 4821. Rafael · sem CPF')
    expect(renderClosingMessage('Até logo, {{agent.name|equipe}}.', closingVariables(CONV, null))).toBe('Até logo, equipe.')
  })

  it('trims the result', () => {
    expect(renderClosingMessage('  {{nada}}  ', vars)).toBe('')
  })
})
