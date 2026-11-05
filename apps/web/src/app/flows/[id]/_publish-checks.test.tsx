import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FlowCheckCode, messages } from '@cosmika/shared'

// The real Portuguese bundle: the point of this panel is the wording an
// author reads, so a missing key must fail here instead of shipping the key
// name to the screen.
const pt = messages['pt-BR'] as unknown as Record<string, Record<string, string>>
function translate(key: string): string {
  const [ns, k] = key.split('.')
  return pt[ns!]?.[k!] ?? `MISSING:${key}`
}
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const raw = translate(key)
    // Enough ICU for `{count, plural, one {#…} other {#…}}`.
    return raw.replace(/\{count, plural,.*?\}\}/, String(params?.count ?? ''))
  },
}))

import { PublishChecks } from './_publish-checks'

const CHECK = {
  code: 'unreachable_group' as const,
  groupId: 'g2',
  groupTitle: 'Falar com consultor',
}

describe('PublishChecks', () => {
  it('renders nothing when the flow is clean', () => {
    const { container } = render(
      <PublishChecks checks={[]} onFocusGroup={vi.fn()} onDismiss={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('names the group and says what is wrong, in the account language', () => {
    render(<PublishChecks checks={[CHECK]} onFocusGroup={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByTestId('editor-checks')).toBeTruthy()
    expect(screen.getByText('Publicado, mas vale revisar')).toBeTruthy()
    expect(screen.getByText('Falar com consultor')).toBeTruthy()
    expect(screen.getByText('Nada leva até este grupo, então ele nunca roda.')).toBeTruthy()
  })

  it('takes the author to the group, and gets out of the way', () => {
    const onFocusGroup = vi.fn()
    const onDismiss = vi.fn()
    render(
      <PublishChecks checks={[CHECK]} onFocusGroup={onFocusGroup} onDismiss={onDismiss} />,
    )
    fireEvent.click(screen.getByTestId('editor-check-g2'))
    expect(onFocusGroup).toHaveBeenCalledWith('g2')
    fireEvent.click(screen.getByTestId('editor-checks-dismiss'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('has a sentence for every code the API can send, in all three languages', () => {
    for (const code of FlowCheckCode.options) {
      for (const locale of ['pt-BR', 'es', 'en'] as const) {
        const bundle = messages[locale] as unknown as Record<string, Record<string, string>>
        const sentence = bundle.flows?.[`check_${code}`]
        expect(sentence, `${locale} flows.check_${code}`).toBeTruthy()
      }
    }
  })

  it('renders one line per finding, keeping repeats of the same group', () => {
    render(
      <PublishChecks
        checks={[CHECK, { ...CHECK, code: 'menu_without_route' }]}
        onFocusGroup={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getAllByText('Falar com consultor')).toHaveLength(2)
  })
})
