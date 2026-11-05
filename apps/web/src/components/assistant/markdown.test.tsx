// The assistant answers in markdown with tables. The first version of this
// page rendered that as preformatted text, so the admin saw raw pipes where a
// table belonged — these tests exist to stop that coming back.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Markdown } from './markdown'

describe('Markdown', () => {
  it('renders a GFM table as a real table', () => {
    render(
      <Markdown>{`| Inbox | Mode |\n|---|---|\n| Suporte | AUTO_SAFE |`}</Markdown>,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Inbox' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'AUTO_SAFE' })).toBeInTheDocument()
  })

  it('renders headings and bold as elements, not literal characters', () => {
    render(<Markdown>{`## Visão geral\n\nO plano é **Enterprise**.`}</Markdown>)
    expect(screen.getByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(screen.getByText('Enterprise').tagName).toBe('STRONG')
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })

  it('renders lists', () => {
    render(<Markdown>{`- one\n- two`}</Markdown>)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders inline code and fenced blocks', () => {
    const { container } = render(<Markdown>{'use `agentbot-suporte`'}</Markdown>)
    expect(container.querySelector('code')).toHaveTextContent('agentbot-suporte')
  })

  it('opens links in a new tab without handing over the opener', () => {
    // Link targets are model output; a bare target=_blank would let the
    // destination reach back into the operator console.
    render(<Markdown>{'[docs](https://example.com)'}</Markdown>)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('does not execute raw HTML embedded in the answer', () => {
    // Tool output can carry anything a customer typed. It must never become
    // live markup just because the model echoed it.
    const { container } = render(
      <Markdown>{'<img src=x onerror="alert(1)"> and <b>bold</b>'}</Markdown>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('renders plain text unchanged', () => {
    render(<Markdown>{'Just a sentence.'}</Markdown>)
    expect(screen.getByText('Just a sentence.')).toBeInTheDocument()
  })
})
