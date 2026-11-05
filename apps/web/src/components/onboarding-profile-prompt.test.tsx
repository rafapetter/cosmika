// OnboardingProfilePrompt: the invitation back into the welcome flow.
//
// It lives outside the first-steps checklist so that finishing setup, or
// dismissing that card, cannot take it away by accident. These tests are what
// keeps it that way: they render it alone, with no checklist in sight.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'pt-BR',
}))

const getAccountProfile = vi.fn()
vi.mock('../lib/api', () => ({
  api: { getAccountProfile: (...a: unknown[]) => getAccountProfile(...a) },
}))

const useStoredSessionMock = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

import { OnboardingProfilePrompt } from './onboarding-profile-prompt'

function session(role = 'ADMINISTRATOR') {
  return {
    session: { token: 'tok' },
    user: { id: 'u1', email: 'a@e.com' },
    account: { id: 'acc1', name: 'Acme' },
    membership: { role },
  }
}

function profile(over: Record<string, unknown> = {}) {
  return { accountId: 'acc1', completedAt: null, skippedAt: null, ...over }
}

beforeEach(() => {
  getAccountProfile.mockReset().mockResolvedValue(null)
  useStoredSessionMock.mockReturnValue({ session: session(), ready: true })
})

describe('OnboardingProfilePrompt', () => {
  it('invites an administrator whose account never started the flow', async () => {
    render(<OnboardingProfilePrompt />)
    expect(await screen.findByText('prompt.title')).toBeInTheDocument()
    expect(getAccountProfile).toHaveBeenCalledWith('tok', 'acc1')
    expect(screen.getByRole('link', { name: /prompt.action/ })).toHaveAttribute(
      'href',
      '/welcome',
    )
  })

  it('keeps inviting while the flow is only half done', async () => {
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'business' }))
    render(<OnboardingProfilePrompt />)
    expect(await screen.findByText('prompt.title')).toBeInTheDocument()
  })

  it.each([
    ['completed', { completedAt: '2026-09-18T10:00:00.000Z' }],
    ['skipped', { skippedAt: '2026-09-18T10:00:00.000Z' }],
  ])('goes away once the flow was %s', async (_name, over) => {
    getAccountProfile.mockResolvedValue(profile(over))
    render(<OnboardingProfilePrompt />)
    await waitFor(() => expect(getAccountProfile).toHaveBeenCalled())
    expect(screen.queryByText('prompt.title')).toBeNull()
  })

  it.each(['AGENT', 'SUPERVISOR'])('is not shown to a %s', async (role) => {
    useStoredSessionMock.mockReturnValue({ session: session(role), ready: true })
    render(<OnboardingProfilePrompt />)
    await waitFor(() => expect(getAccountProfile).not.toHaveBeenCalled())
    expect(screen.queryByText('prompt.title')).toBeNull()
  })

  it('renders nothing before the session is read', () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: false })
    const { container } = render(<OnboardingProfilePrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('a failed check never gets in the way of the dashboard', async () => {
    getAccountProfile.mockRejectedValue(new Error('down'))
    render(<OnboardingProfilePrompt />)
    // A refusal is not "pending": we did not learn anything, so we stay quiet.
    await waitFor(() => expect(getAccountProfile).toHaveBeenCalled())
    expect(screen.queryByText('prompt.title')).toBeNull()
  })

  it('can be put away for this visit without that counting as skipping', async () => {
    const user = userEvent.setup()
    render(<OnboardingProfilePrompt />)
    await screen.findByText('prompt.title')
    await user.click(screen.getByRole('button', { name: 'prompt.dismiss' }))
    expect(screen.queryByText('prompt.title')).toBeNull()
    // Nothing was written: only the flow itself records a skip.
    expect(getAccountProfile).toHaveBeenCalledTimes(1)
  })
})
