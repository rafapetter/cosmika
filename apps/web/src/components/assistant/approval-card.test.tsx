// This card is the moment a human decides. Everything asserted here serves
// one question: does the admin see exactly what will change?
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Translator stub: the key, then any params.
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, p?: Record<string, unknown>) =>
    p ? `${k} ${Object.values(p).join(' ')}` : k, useLocale: () => 'pt-BR'
}))

import { ApprovalCard } from './approval-card'

const t = (k: string) => k

const call = {
  id: 'call1',
  toolName: 'set_inbox_ai_mode',
  input: { inboxId: 'cmpibdf08007bc1a7aa523113', mode: 'AUTO_FULL' },
}

describe('ApprovalCard', () => {
  it('names the action in words, not as a function name', () => {
    render(
      <ApprovalCard call={call} busy={false} t={t} onApprove={vi.fn()} onReject={vi.fn()} />,
    )
    expect(screen.getByText('assistantTools.set_inbox_ai_mode')).toBeInTheDocument()
  })

  it('shows every argument — a hidden field is a change nobody agreed to', () => {
    render(
      <ApprovalCard call={call} busy={false} t={t} onApprove={vi.fn()} onReject={vi.fn()} />,
    )
    expect(screen.getByText('assistantKeys.inbox_id')).toBeInTheDocument()
    expect(screen.getByText('assistantKeys.mode')).toBeInTheDocument()
    expect(screen.getByText('assistantValues.auto_full')).toBeInTheDocument()
    expect(screen.getByText('cmpibdf08007bc1a7aa523113')).toBeInTheDocument()
  })

  it('formats a boolean argument as a word rather than "true"', () => {
    render(
      <ApprovalCard
        call={{ id: 'c', toolName: 'set_csat_enabled', input: { enabled: true } }}
        busy={false}
        t={t}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    )
    expect(screen.getByText('common.yes')).toBeInTheDocument()
  })

  it('says so when the action takes no arguments', () => {
    render(
      <ApprovalCard
        call={{ id: 'c', toolName: 'do_thing', input: {} }}
        busy={false}
        t={t}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    )
    expect(screen.getByText('assistant.approval_no_fields')).toBeInTheDocument()
  })

  it('reports each decision to its own handler', async () => {
    const onApprove = vi.fn()
    const onReject = vi.fn()
    render(
      <ApprovalCard call={call} busy={false} t={t} onApprove={onApprove} onReject={onReject} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'assistant.approve' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'assistant.reject' }))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('cannot be double-submitted while a decision is in flight', async () => {
    const onApprove = vi.fn()
    render(
      <ApprovalCard call={call} busy t={t} onApprove={onApprove} onReject={vi.fn()} />,
    )
    const approve = screen.getByRole('button', { name: 'assistant.approve' })
    expect(approve).toBeDisabled()
    await userEvent.click(approve)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('tolerates a call whose input was stored as null', async () => {
    render(
      <ApprovalCard
        call={{ id: 'c', toolName: 'x', input: null as never }}
        busy={false}
        t={t}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    )
    expect(screen.getByTestId('assistant-approval')).toBeInTheDocument()
  })
})
