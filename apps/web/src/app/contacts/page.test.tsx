// The contacts grid is keyboard-first (Twenty-style): a single click opens
// the editor, arrow keys move a cell cursor, Enter/typing edit, Escape backs
// out. These interactions are pure client behavior, so jsdom can pin them.
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
// The router object must keep its identity across renders: it sits in the
// load effect's dependency array, so a fresh object per render re-runs the
// effect forever (render → new router → effect → setState → render …).
const ROUTER = { replace: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => ROUTER }))

const listContacts = vi.fn()
const updateContact = vi.fn()
const listSavedViews = vi.fn()
vi.mock('../../lib/api', () => ({
  api: {
    listContacts: (...a: unknown[]) => listContacts(...a),
    updateContact: (...a: unknown[]) => updateContact(...a),
    listSavedViews: (...a: unknown[]) => listSavedViews(...a),
    bulkContactAction: vi.fn(),
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

// Stable identity across renders, same as production React state.
const STORED = {
  session: { token: 't' },
  account: { id: 'acc1' },
  membership: { role: 'ADMINISTRATOR' },
}
let sessionValue: { session: typeof STORED | null; ready: boolean }
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => sessionValue,
}))

import ContactsPage from './page'

const contact = (over: Record<string, unknown> = {}) => ({
  id: 'ct1',
  accountId: 'acc1',
  name: 'Ana Silva',
  email: 'ana@ex.com',
  phoneNumber: '+55119999',
  identifier: null,
  avatarUrl: null,
  blockedAt: null,
  lastActivityAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

const ROWS = [
  contact(),
  contact({ id: 'ct2', name: 'Bruno Costa', email: 'bruno@ex.com', phoneNumber: null }),
]

beforeEach(() => {
  sessionValue = { session: STORED, ready: true }
  listContacts
    .mockReset()
    .mockResolvedValue({ data: ROWS, nextCursor: null, total: 2 })
  updateContact.mockReset().mockResolvedValue(contact({ email: 'new@ex.com' }))
  listSavedViews.mockReset().mockResolvedValue([])
  window.localStorage.clear()
})

async function renderGrid() {
  render(<ContactsPage />)
  await screen.findByText('Ana Silva')
}

describe('ContactsPage cell editing', () => {
  it('opens the editor on a single click of an editable cell', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-email-ct1'))
    expect(screen.getByTestId('edit-email-ct1')).toHaveValue('ana@ex.com')
  })

  it('does not open an editor on a non-editable cell', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-identifier-ct1'))
    expect(screen.queryByTestId('edit-identifier-ct1')).toBeNull()
  })

  it('does not open an editor for a role without mutate rights', async () => {
    sessionValue = {
      session: { ...STORED, membership: { role: 'AGENT' } },
      ready: true,
    }
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-email-ct1'))
    expect(screen.queryByTestId('edit-email-ct1')).toBeNull()
  })

  it('saves on Enter and closes the editor', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-email-ct1'))
    const input = screen.getByTestId('edit-email-ct1')
    await userEvent.clear(input)
    await userEvent.type(input, 'new@ex.com{Enter}')
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('t', 'acc1', 'ct1', {
        email: 'new@ex.com',
      }),
    )
    expect(screen.queryByTestId('edit-email-ct1')).toBeNull()
  })

  it('abandons the edit on Escape without saving', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-email-ct1'))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('edit-email-ct1')).toBeNull()
    expect(updateContact).not.toHaveBeenCalled()
    // Focus must land back on the cell so arrow keys keep working.
    expect(document.activeElement).toBe(screen.getByTestId('cell-email-ct1'))
  })
})

describe('ContactsPage keyboard navigation', () => {
  it('moves the cell cursor with arrow keys', async () => {
    await renderGrid()
    // The identifier cell is not editable, so clicking it only focuses it.
    await userEvent.click(screen.getByTestId('cell-identifier-ct1'))
    expect(document.activeElement).toBe(screen.getByTestId('cell-identifier-ct1'))
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByTestId('cell-phoneNumber-ct1'))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByTestId('cell-phoneNumber-ct2'))
    // Bottom edge: ArrowDown stays put instead of wrapping.
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByTestId('cell-phoneNumber-ct2'))
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByTestId('cell-email-ct1'))
    // Left edge: no wrap either.
    await userEvent.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(screen.getByTestId('cell-email-ct1'))
  })

  it('opens the editor with Enter on a focused editable cell', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-identifier-ct1'))
    await userEvent.keyboard('{ArrowLeft}{Enter}')
    expect(screen.getByTestId('edit-phoneNumber-ct1')).toHaveValue('+55119999')
  })

  it('typing over a focused cell opens the editor seeded with the character', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-identifier-ct1'))
    await userEvent.keyboard('{ArrowLeft}x')
    // Spreadsheet semantics: the typed character replaces the value.
    expect(screen.getByTestId('edit-phoneNumber-ct1')).toHaveValue('x')
  })

  it('ignores typed characters over a non-editable cell', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('cell-identifier-ct1'))
    await userEvent.keyboard('x')
    expect(screen.queryByTestId('edit-identifier-ct1')).toBeNull()
  })
})

describe('ContactsPage record panel', () => {
  it('opens the side panel from the name and edits a field in place', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('contact-ct1'))
    expect(screen.getByTestId('record-panel')).toBeInTheDocument()
    // Name is editable in the panel even though the grid has no name column.
    await userEvent.click(screen.getByTestId('panel-field-name'))
    const input = screen.getByTestId('panel-edit-name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Ana Souza{Enter}')
    await waitFor(() =>
      expect(updateContact).toHaveBeenCalledWith('t', 'acc1', 'ct1', {
        name: 'Ana Souza',
      }),
    )
    // The optimistic save flows into the panel through items.
    expect(screen.getByTestId('panel-field-name')).toHaveTextContent('Ana Souza')
  })

  it('keeps a full-page link and closes on demand', async () => {
    await renderGrid()
    await userEvent.click(screen.getByTestId('contact-ct1'))
    expect(screen.getByTestId('panel-open-full').closest('a')).toHaveAttribute(
      'href',
      '/contacts/ct1',
    )
    await userEvent.click(screen.getByTestId('record-panel-close'))
    expect(screen.queryByTestId('record-panel')).toBeNull()
  })

  it('offers no editing affordance to an agent', async () => {
    sessionValue = {
      session: { ...STORED, membership: { role: 'AGENT' } },
      ready: true,
    }
    await renderGrid()
    await userEvent.click(screen.getByTestId('contact-ct1'))
    expect(screen.getByTestId('panel-field-name')).toBeDisabled()
    expect(screen.getByTestId('panel-blocked')).toBeDisabled()
  })
})
