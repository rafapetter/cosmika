// The structured attribute editor replaced a raw-JSON textarea (F3). The
// merge helper carries the real risk: customAttributes is replaced wholesale
// by the API, so a form that submits only its own fields would delete every
// key nobody defined in settings (migrated contacts carry those).
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

import { ContactAttributeFields, mergeDefinedAttributes } from './_attribute-fields'

const def = (over: Record<string, unknown> = {}) => ({
  id: 'ca1',
  accountId: 'acc1',
  target: 'CONTACT',
  key: 'plan',
  label: 'Plan',
  type: 'TEXT',
  options: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('mergeDefinedAttributes', () => {
  it('keeps stored keys that the form never showed', () => {
    // country_code comes from the Nebula migration and is not defined in
    // settings; saving the contact must not delete it.
    expect(
      mergeDefinedAttributes({ country_code: 'BR', plan: 'free' }, { plan: 'pro' }),
    ).toEqual({ country_code: 'BR', plan: 'pro' })
  })

  it('treats an emptied field as unset rather than storing an empty string', () => {
    expect(mergeDefinedAttributes({ plan: 'pro' }, { plan: '' })).toEqual({})
    expect(mergeDefinedAttributes({ plan: 'pro' }, { plan: null })).toEqual({})
  })

  it('keeps false, which is a real boolean value and not emptiness', () => {
    expect(mergeDefinedAttributes({}, { vip: false })).toEqual({ vip: false })
  })

  it('keeps zero, which is a real number and not emptiness', () => {
    expect(mergeDefinedAttributes({}, { score: 0 })).toEqual({ score: 0 })
  })
})

describe('ContactAttributeFields', () => {
  it('renders each definition with the control its type deserves', () => {
    render(
      <ContactAttributeFields
        definitions={[
          def(),
          def({ id: 'ca2', key: 'vip', label: 'VIP', type: 'BOOLEAN' }),
          def({ id: 'ca3', key: 'born', label: 'Born', type: 'DATE' }),
          def({ id: 'ca4', key: 'score', label: 'Score', type: 'NUMBER' }),
        ]}
        values={{ plan: 'pro', vip: true, born: '2026-01-02', score: 7 }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('attr-plan')).toHaveValue('pro')
    expect(screen.getByTestId('attr-vip')).toBeChecked()
    expect(screen.getByTestId('attr-born')).toHaveAttribute('type', 'date')
    expect(screen.getByTestId('attr-score')).toHaveAttribute('type', 'number')
  })

  it('reports edits by key', async () => {
    const onChange = vi.fn()
    render(
      <ContactAttributeFields definitions={[def()]} values={{}} onChange={onChange} />,
    )
    await userEvent.type(screen.getByTestId('attr-plan'), 'x')
    expect(onChange).toHaveBeenCalledWith('plan', 'x')
  })

  it('shows stored-but-undefined keys instead of hiding them', () => {
    render(
      <ContactAttributeFields
        definitions={[def()]}
        values={{ plan: 'pro', country_code: 'BR' }}
        onChange={vi.fn()}
      />,
    )
    const extras = screen.getByTestId('undefined-attributes')
    expect(extras).toHaveTextContent('country_code')
    expect(extras).toHaveTextContent('BR')
    // The defined one is a field, not an extra.
    expect(extras).not.toHaveTextContent('plan')
  })

  it('explains the empty state when nothing is defined or stored', () => {
    render(<ContactAttributeFields definitions={[]} values={{}} onChange={vi.fn()} />)
    expect(screen.getByTestId('no-attributes')).toBeInTheDocument()
  })

  it('a boolean read from a stringified value still renders checked', () => {
    // Values round-trip through JSON, so `true` can come back as 'true'.
    render(
      <ContactAttributeFields
        definitions={[def({ key: 'vip', label: 'VIP', type: 'BOOLEAN' })]}
        values={{ vip: 'true' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('attr-vip')).toBeChecked()
  })
})
