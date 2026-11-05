// The evidence panel is what lets an admin verify the assistant instead of
// trusting it, so the two things that matter are: the real rows are shown, and
// a truncated view never reads as the whole set.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Translator stub: the key, then any params.
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, p?: Record<string, unknown>) =>
    p ? `${k} ${Object.values(p).join(' ')}` : k, useLocale: () => 'pt-BR'
}))

import { ResultPanel, ToolResults, Value } from './tool-result'

const label = (n: number) => `consulted ${n}`

describe('ToolResults', () => {
  it('renders nothing when the assistant used no tools', () => {
    const { container } = render(<ToolResults calls={[]} label={label} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names each tool in words rather than snake_case', () => {
    render(
      <ToolResults
        calls={[{ toolName: 'set_inbox_ai_mode', critical: true, output: {} }]}
        label={label}
      />,
    )
    expect(screen.getByText('assistantTools.set_inbox_ai_mode')).toBeInTheDocument()
  })

  it('opens a panel with the data behind an answer', async () => {
    render(
      <ToolResults
        calls={[{ toolName: 'ai_spend', critical: false, output: { monthToDateUsd: 0.0869 } }]}
        label={label}
      />,
    )
    expect(screen.queryByTestId('stat-grid')).toBeNull()
    await userEvent.click(screen.getByTestId('tool-chip-ai_spend'))
    expect(screen.getByTestId('stat-grid')).toBeInTheDocument()
    expect(screen.getByText('$0.09')).toBeInTheDocument()
  })

  it('closes again on a second click', async () => {
    render(
      <ToolResults
        calls={[{ toolName: 'ai_spend', critical: false, output: { monthToDateUsd: 1 } }]}
        label={label}
      />,
    )
    const chip = screen.getByTestId('tool-chip-ai_spend')
    await userEvent.click(chip)
    expect(screen.getByTestId('stat-grid')).toBeInTheDocument()
    await userEvent.click(chip)
    expect(screen.queryByTestId('stat-grid')).toBeNull()
  })

  it('disables the chip when the payload was too big to send back', async () => {
    // The turn still says the tool ran; it just cannot show the data.
    render(
      <ToolResults calls={[{ toolName: 'list_articles', critical: false }]} label={label} />,
    )
    const chip = screen.getByTestId('tool-chip-list_articles')
    expect(chip).toBeDisabled()
    await userEvent.click(chip)
    expect(screen.queryByTestId('stat-grid')).toBeNull()
  })
})

describe('ResultPanel', () => {
  it('shows a tool error as an error, not as data', () => {
    render(<ResultPanel output={{ error: 'no such inbox in this account' }} />)
    expect(screen.getByTestId('result-error')).toHaveTextContent('no such inbox')
    expect(screen.queryByTestId('stat-grid')).toBeNull()
  })

  it('renders rows as a table with a count', () => {
    render(
      <ResultPanel
        output={{
          inboxes: [
            { name: 'Suporte', aiAutoreplyMode: 'AUTO_SAFE', csatEnabled: false },
            { name: 'Financeiro', aiAutoreplyMode: 'AUTO_SAFE', csatEnabled: true },
          ],
        }}
      />,
    )
    expect(screen.getByTestId('data-table')).toHaveTextContent('assistantKeys.inboxes · 2')
    expect(screen.getByText('Suporte')).toBeInTheDocument()
    expect(screen.getByText('Financeiro')).toBeInTheDocument()
  })

  it('says so when a table is truncated', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `row${i}` }))
    render(<ResultPanel output={{ flows: rows }} />)
    expect(screen.getByText('assistant.showing_rows 25 40')).toBeInTheDocument()
    expect(screen.getByText('row24')).toBeInTheDocument()
    expect(screen.queryByText('row25')).toBeNull()
  })

  it('falls back to raw JSON for a shape it cannot classify', () => {
    render(<ResultPanel output={[1, 2, 3]} />)
    expect(screen.getByTestId('result-raw')).toBeInTheDocument()
  })

  it('shows both tiles and a table when the result has each', () => {
    render(<ResultPanel output={{ count: 1, articles: [{ title: 'A' }] }} />)
    expect(screen.getByTestId('stat-grid')).toBeInTheDocument()
    expect(screen.getByTestId('data-table')).toBeInTheDocument()
  })
})

describe('Value', () => {
  it('renders a boolean as a pill, not the word "true"', () => {
    render(<Value name="csatEnabled" value={true} />)
    expect(screen.getByText('common.yes')).toBeInTheDocument()
  })

  it('formats money', () => {
    render(<Value name="dailyBudgetUsd" value={3} />)
    expect(screen.getByText('$3.00')).toBeInTheDocument()
  })

  it('renders a missing value as a dash', () => {
    render(<Value name="agentBot" value={null} />)
    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('renders an enum as a word, not as the API\'s constant', () => {
    render(<Value name="aiAutoreplyMode" value="AUTO_SAFE" />)
    expect(screen.getByText('assistantValues.auto_safe')).toBeInTheDocument()
    expect(screen.queryByText('AUTO_SAFE')).toBeNull()
  })
})
