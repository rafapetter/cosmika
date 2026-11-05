// The tickets page is now a record grid (Twenty-style): server-side sort and
// filters, enum cells that edit through a picker, inline category edit, and
// saved views. These tests pin the grid behaviors; the API side is pinned in
// support-tickets.service.test.ts.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const listTickets = vi.fn()
const updateTicket = vi.fn()
const listSavedViews = vi.fn()
vi.mock('../../lib/api', () => ({
  api: {
    listTickets: (...a: unknown[]) => listTickets(...a),
    updateTicket: (...a: unknown[]) => updateTicket(...a),
    listSavedViews: (...a: unknown[]) => listSavedViews(...a),
    createSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
  },
  ApiError: class extends Error {
    status: number
    constructor(status = 500) {
      super('api')
      this.status = status
    }
  },
}))

// Stable identity across renders — a fresh object per render re-runs the
// load effect forever (the same landmine the contacts test hit).
const STORED = {
  session: { token: 't' },
  account: { id: 'acc1' },
  membership: { role: 'ADMINISTRATOR' },
}
let sessionValue: { session: typeof STORED | null; ready: boolean }
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => sessionValue,
}))

import TicketsPage from './page'

const ticket = (over: Record<string, unknown> = {}) => ({
  id: 'tk1',
  accountId: 'acc1',
  number: 42,
  subject: 'Erro no relatório',
  description: 'd',
  category: null,
  priority: 'HIGH',
  status: 'OPEN',
  conversationId: 'cv1',
  contactId: 'ct1',
  contactName: 'Ana',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  sessionValue = { session: STORED, ready: true }
  listTickets.mockReset().mockResolvedValue([ticket()])
  updateTicket.mockReset().mockResolvedValue(ticket({ status: 'CLOSED' }))
  listSavedViews.mockReset().mockResolvedValue([])
  window.localStorage.clear()
})

describe('TicketsPage grid', () => {
  it('renders a ticket with its number, subject and contact', async () => {
    render(<TicketsPage />)
    expect(await screen.findByText('Erro no relatório')).toBeInTheDocument()
    expect(screen.getByText('#42')).toBeInTheDocument()
    expect(screen.getByText('Ana')).toBeInTheDocument()
  })

  it('opens the record panel from the subject, with the conversation linked', async () => {
    render(<TicketsPage />)
    await userEvent.click(await screen.findByTestId('ticket-tk1'))
    expect(screen.getByTestId('record-panel')).toBeInTheDocument()
    expect(
      screen.getByTestId('panel-open-conversation').closest('a'),
    ).toHaveAttribute('href', '/conversations/cv1')
    await userEvent.click(screen.getByTestId('record-panel-close'))
    expect(screen.queryByTestId('record-panel')).toBeNull()
  })

  it('offers no conversation link in the panel of an orphaned ticket', async () => {
    listTickets.mockResolvedValue([ticket({ conversationId: null })])
    render(<TicketsPage />)
    await userEvent.click(await screen.findByTestId('ticket-tk1'))
    expect(screen.getByTestId('record-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-open-conversation')).toBeNull()
  })

  it('edits category in place from the panel', async () => {
    render(<TicketsPage />)
    await userEvent.click(await screen.findByTestId('ticket-tk1'))
    await userEvent.click(screen.getByTestId('panel-field-category'))
    const input = screen.getByTestId('panel-edit-category')
    await userEvent.type(input, 'Financeiro{Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t', 'acc1', 'tk1', {
        category: 'Financeiro',
      }),
    )
    // The optimistic save flows back into the panel through items.
    expect(screen.getByTestId('panel-field-category')).toHaveTextContent('Financeiro')
  })

  it('requests server-side sort and filters', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    expect(listTickets).toHaveBeenCalledWith('t', 'acc1', {
      q: undefined,
      sort: 'createdAt',
      dir: 'desc',
      filters: undefined,
    })
    await userEvent.click(screen.getByTestId('sort-menu'))
    await userEvent.click(await screen.findByTestId('sort-priority'))
    await waitFor(() =>
      expect(listTickets).toHaveBeenLastCalledWith(
        't',
        'acc1',
        expect.objectContaining({ sort: 'priority' }),
      ),
    )
  })

  it('changes status through the picker cell', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    await userEvent.click(screen.getByTestId('pick-status-tk1'))
    await userEvent.click(await screen.findByTestId('option-status-RESOLVED-tk1'))
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t', 'acc1', 'tk1', {
        status: 'RESOLVED',
      }),
    )
  })

  it('changes priority through the picker cell', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    await userEvent.click(screen.getByTestId('pick-priority-tk1'))
    await userEvent.click(await screen.findByTestId('option-priority-URGENT-tk1'))
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t', 'acc1', 'tk1', {
        priority: 'URGENT',
      }),
    )
  })

  it('edits category inline with a single click and saves on Enter', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    await userEvent.click(screen.getByTestId('cell-category-tk1'))
    const input = screen.getByTestId('edit-category-tk1')
    await userEvent.type(input, 'Financeiro{Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t', 'acc1', 'tk1', {
        category: 'Financeiro',
      }),
    )
  })

  it('closes and reopens through the row actions menu', async () => {
    listTickets.mockResolvedValue([ticket({ status: 'CLOSED' })])
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    await userEvent.click(screen.getByTestId('actions-tk1'))
    await userEvent.click(await screen.findByTestId('action-toggle-tk1'))
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t', 'acc1', 'tk1', {
        status: 'OPEN',
      }),
    )
  })

  it('offers no mutation affordances to an agent', async () => {
    sessionValue = {
      session: { ...STORED, membership: { role: 'AGENT' } },
      ready: true,
    }
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    expect(screen.getByTestId('pick-status-tk1')).toBeDisabled()
    await userEvent.click(screen.getByTestId('cell-category-tk1'))
    expect(screen.queryByTestId('edit-category-tk1')).toBeNull()
  })

  it('navigates cells with arrow keys and opens the picker with Enter', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    // contactName is not editable: clicking it only focuses the cell.
    await userEvent.click(screen.getByTestId('cell-contactName-tk1'))
    expect(document.activeElement).toBe(screen.getByTestId('cell-contactName-tk1'))
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}')
    // contact → category → priority; Enter opens the priority picker.
    expect(await screen.findByTestId('option-priority-LOW-tk1')).toBeInTheDocument()
  })

  it('loads ticket saved views scoped to the TICKETS entity', async () => {
    render(<TicketsPage />)
    await screen.findByText('Erro no relatório')
    expect(listSavedViews).toHaveBeenCalledWith('t', 'acc1', 'TICKETS')
  })
})
