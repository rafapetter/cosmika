import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PageContainer, PageHeader } from './page'

describe('PageContainer', () => {
  it('renders children inside the outer scroll wrapper', () => {
    render(
      <PageContainer>
        <p>hello world</p>
      </PageContainer>,
    )
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('applies custom className to the inner wrapper', () => {
    const { container } = render(
      <PageContainer className="bg-red-500">
        <span>x</span>
      </PageContainer>,
    )
    // Inner div is the second wrapper.
    const inner = container.querySelector('.bg-red-500')
    expect(inner).not.toBeNull()
  })
})

describe('PageHeader', () => {
  it('renders title alone', () => {
    render(<PageHeader title="Hello" />)
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
  })

  it('renders subtitle when supplied', () => {
    render(<PageHeader title="T" subtitle="Sub line" />)
    expect(screen.getByText('Sub line')).toBeInTheDocument()
  })

  it('omits subtitle when not supplied', () => {
    const { container } = render(<PageHeader title="T" />)
    // No <p> tag (subtitle is rendered as <p>)
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders actions when supplied', () => {
    render(<PageHeader title="T" actions={<button>Save</button>} />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('omits actions container when not supplied', () => {
    const { container } = render(<PageHeader title="T" />)
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(0)
  })
})
