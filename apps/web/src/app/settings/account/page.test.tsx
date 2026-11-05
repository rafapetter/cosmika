// This page is the only place the admin assistant's approval mode can be
// changed — the assistant has no tool for it, deliberately. So the toggle has
// to reach the API, and has to default to the cautious side.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const updateAccount = vi.fn()
// The page also carries the "About the business" section, which reads the
// commercial profile on mount. It has its own test file; here it only has to
// not explode.
const getAccountProfile = vi.fn().mockResolvedValue(null)
vi.mock('../../../lib/api', () => ({
  api: {
    updateAccount: (...a: unknown[]) => updateAccount(...a),
    getAccountProfile: (...a: unknown[]) => getAccountProfile(...a),
    saveAccountProfile: vi.fn(),
  },
  ApiError: class extends Error {},
}))

const setSession = vi.fn()
let stored: unknown = null
vi.mock('../../../lib/session-store', () => ({
  useStoredSession: () => ({ session: stored, setSession }),
}))

import AccountSettingsPage from './page'

const account = (over: Record<string, unknown> = {}) => ({
  id: 'acc1', slug: 'cosmobots', name: 'CosmoBots', domain: null,
  status: 'ACTIVE', plan: 'ROCKET', defaultLocale: 'pt-BR',
  defaultTimezone: 'America/Sao_Paulo', adminAgentRequiresApproval: true,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
})

const asRole = (role: string, over: Record<string, unknown> = {}) => {
  stored = {
    session: { token: 't' },
    account: account(over),
    membership: { role },
  }
}

beforeEach(() => {
  asRole('ADMINISTRATOR')
  updateAccount.mockReset().mockResolvedValue(account())
  setSession.mockReset()
})

describe('admin assistant approval mode', () => {
  it('shows approval selected when the account requires it', () => {
    render(<AccountSettingsPage />)
    expect(screen.getByTestId('admin-agent-approval')).toBeChecked()
    expect(screen.getByTestId('admin-agent-auto')).not.toBeChecked()
  })

  it('shows autonomous selected when approval is off', () => {
    asRole('ADMINISTRATOR', { adminAgentRequiresApproval: false })
    render(<AccountSettingsPage />)
    expect(screen.getByTestId('admin-agent-auto')).toBeChecked()
  })

  it('defaults to asking when the stored session predates the field', () => {
    // Undefined is not "no" — an unknown value must never read as autonomy.
    asRole('ADMINISTRATOR', { adminAgentRequiresApproval: undefined })
    render(<AccountSettingsPage />)
    expect(screen.getByTestId('admin-agent-approval')).toBeChecked()
  })

  it('saves the switch to autonomous', async () => {
    render(<AccountSettingsPage />)
    await userEvent.click(screen.getByTestId('admin-agent-auto'))
    await userEvent.click(screen.getByRole('button', { name: 'accountPage.save' }))
    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith(
        't',
        'acc1',
        expect.objectContaining({ adminAgentRequiresApproval: false }),
      ),
    )
  })

  it('saves the switch back to asking', async () => {
    asRole('ADMINISTRATOR', { adminAgentRequiresApproval: false })
    render(<AccountSettingsPage />)
    await userEvent.click(screen.getByTestId('admin-agent-approval'))
    await userEvent.click(screen.getByRole('button', { name: 'accountPage.save' }))
    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith(
        't',
        'acc1',
        expect.objectContaining({ adminAgentRequiresApproval: true }),
      ),
    )
  })

  it('is not changeable by a non-administrator', () => {
    asRole('AGENT')
    render(<AccountSettingsPage />)
    expect(screen.getByTestId('admin-agent-auto')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'accountPage.save' })).toBeNull()
  })

  it('renders nothing without a session', () => {
    stored = null
    const { container } = render(<AccountSettingsPage />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reports a save failure instead of showing it as saved', async () => {
    updateAccount.mockRejectedValue(new Error('nope'))
    render(<AccountSettingsPage />)
    await userEvent.click(screen.getByRole('button', { name: 'accountPage.save' }))
    expect(await screen.findByText('errors.generic')).toBeInTheDocument()
    expect(screen.queryByText('accountPage.saved')).toBeNull()
  })
})
