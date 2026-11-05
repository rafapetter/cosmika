import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const T = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key} ${JSON.stringify(vars)}` : key
vi.mock('next-intl', () => ({
  useTranslations: () => T,
  useFormatter: () => ({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }), useLocale: () => 'pt-BR'
}))

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const apiMock = vi.hoisted(() => ({ getBillingStatus: vi.fn(), signOut: vi.fn() }))
vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number) {
      super('x')
      this.status = status
    }
  },
}))

const sessionState = vi.hoisted(() => ({ value: null as unknown, clear: vi.fn() }))
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => ({ session: sessionState.value, ready: true }),
  clearSession: sessionState.clear,
}))

import { ApiError } from '../../lib/api'
import SubscriptionPage from './page'

const SESSION = { session: { token: 'tok' }, account: { id: 'acc1' } }

beforeEach(() => {
  sessionState.value = SESSION
  apiMock.signOut.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('SubscriptionPage', () => {
  it('offers the payment link and finance contact when the trial ended', async () => {
    apiMock.getBillingStatus.mockResolvedValue({
      accessAllowed: false,
      paying: false,
      trialExpiresAt: '2026-09-20',
      checkoutUrl: 'https://www.asaas.com/c/abc',
    })
    vi.stubEnv('NEXT_PUBLIC_FINANCE_EMAIL', 'financeiro@acme.example')
    render(<SubscriptionPage />)
    expect(await screen.findByTestId('subscription-title')).toHaveTextContent('billing.ended_title_trial')
    expect(screen.getByTestId('pay-now')).toHaveAttribute('href', 'https://www.asaas.com/c/abc')
    expect(screen.getByText('billing.contact_finance').closest('a')).toHaveAttribute(
      'href',
      'mailto:financeiro@acme.example',
    )
    expect(screen.getByText(/billing.ended_trial_date/)).toHaveTextContent('2026-09-20')
  })

  it('falls back to the finance contact when there is no stored link', async () => {
    apiMock.getBillingStatus.mockResolvedValue({
      accessAllowed: false,
      paying: false,
      trialExpiresAt: null,
      checkoutUrl: null,
    })
    render(<SubscriptionPage />)
    expect(await screen.findByTestId('subscription-title')).toHaveTextContent('billing.ended_title')
    expect(screen.queryByTestId('pay-now')).toBeNull()
    expect(screen.getByText('billing.no_link')).toBeInTheDocument()
  })

  // An open-source install must not send its users to CosmoBots' finance.
  it('shows no finance contact when the install set none', async () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_EMAIL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '')
    apiMock.getBillingStatus.mockResolvedValue({
      accessAllowed: false, paying: false, trialExpiresAt: null, checkoutUrl: null,
    })
    render(<SubscriptionPage />)
    await screen.findByTestId('subscription-title')
    expect(screen.queryByText('billing.contact_finance')).toBeNull()
  })

  it('goes back to the app once access is allowed again, after checking again', async () => {
    apiMock.getBillingStatus.mockResolvedValueOnce({
      accessAllowed: false,
      paying: false,
      trialExpiresAt: null,
      checkoutUrl: null,
    })
    render(<SubscriptionPage />)
    await screen.findByTestId('subscription-title')
    apiMock.getBillingStatus.mockResolvedValueOnce({
      accessAllowed: true,
      paying: true,
      trialExpiresAt: null,
      checkoutUrl: null,
    })
    fireEvent.click(screen.getByText('billing.check_again'))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/inbox'))
  })

  it('shows a generic error when the status call fails, but stays quiet on 401', async () => {
    apiMock.getBillingStatus.mockRejectedValueOnce(new Error('network'))
    const { unmount } = render(<SubscriptionPage />)
    expect(await screen.findByText('auth.generic_error')).toBeInTheDocument()
    unmount()
    apiMock.getBillingStatus.mockRejectedValueOnce(new (ApiError as unknown as new (s: number) => Error)(401))
    render(<SubscriptionPage />)
    await waitFor(() => expect(apiMock.getBillingStatus).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('auth.generic_error')).toBeNull()
  })

  it('signs out, even if the server call fails', async () => {
    apiMock.getBillingStatus.mockResolvedValue({
      accessAllowed: false,
      paying: false,
      trialExpiresAt: null,
      checkoutUrl: null,
    })
    apiMock.signOut.mockRejectedValue(new Error('down'))
    render(<SubscriptionPage />)
    await screen.findByTestId('subscription-title')
    fireEvent.click(screen.getByText('auth.sign_out'))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in'))
    expect(sessionState.clear).toHaveBeenCalled()
  })

  it('sends a visitor without a session to sign-in', async () => {
    sessionState.value = null
    render(<SubscriptionPage />)
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in'))
    expect(apiMock.getBillingStatus).not.toHaveBeenCalled()
  })
})
