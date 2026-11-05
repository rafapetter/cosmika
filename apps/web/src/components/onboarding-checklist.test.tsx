// OnboardingChecklist: who sees it, what it shows, and when it goes away.
// The checklist sits on the first screen every new customer lands on, so the
// failure modes that matter are showing it to the wrong person, blocking the
// dashboard on an API error, and pointing a step at the wrong place.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const T = (k: string, vars?: Record<string, unknown>) =>
  vars ? `${k}:${Object.values(vars).join(',')}` : k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const getOnboarding = vi.fn()
vi.mock('../lib/api', () => ({
  api: { getOnboarding: (...a: unknown[]) => getOnboarding(...a) },
}))

const useStoredSessionMock = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

import { OnboardingChecklist, hiddenKey } from './onboarding-checklist'

function session(role = 'ADMINISTRATOR') {
  return {
    session: { token: 'tok' },
    user: { id: 'u1', email: 'a@e.com' },
    account: { id: 'acc1', name: 'Acme' },
    membership: { role },
  }
}

function status(done: Partial<Record<string, boolean>>) {
  const steps = {
    channel: false,
    firstMessage: false,
    automation: false,
    team: false,
    availability: false,
    ...done,
  }
  const completed = Object.values(steps).filter(Boolean).length
  return { steps, completed, total: 5 }
}

beforeEach(() => {
  getOnboarding.mockReset()
  useStoredSessionMock.mockReturnValue({ session: session(), ready: true })
})

describe('OnboardingChecklist', () => {
  it('shows every step with the next one as the primary action', async () => {
    getOnboarding.mockResolvedValue(status({ channel: true }))
    render(<OnboardingChecklist />)

    expect(await screen.findByText('title')).toBeInTheDocument()
    expect(getOnboarding).toHaveBeenCalledWith('tok', 'acc1')
    expect(screen.getByText('progress:1,5')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')

    const done = document.querySelector('[data-step="channel"]')!
    expect(done).toHaveAttribute('data-done', 'true')
    expect(done).toHaveTextContent('done')

    const next = screen.getByRole('link', { name: 'steps.firstMessage.action' })
    expect(next).toHaveAttribute('href', '/conversations')
    expect(next.className).toContain('bg-primary')

    const later = screen.getByRole('link', { name: 'steps.team.action' })
    expect(later).toHaveAttribute('href', '/settings/members')
    expect(later.className).not.toContain('bg-primary')
  })

  it('points each step at the right screen and help page', async () => {
    getOnboarding.mockResolvedValue(status({}))
    render(<OnboardingChecklist />)
    await screen.findByText('title')

    const hrefs = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      'https://docs.cosmobots.io/cosmika/whatsapp',
      '/inboxes/new',
      'https://docs.cosmobots.io/cosmika/primeiros-passos',
      '/conversations',
      'https://docs.cosmobots.io/cosmika/atendimento-automatico',
      '/assistant',
      'https://docs.cosmobots.io/cosmika/equipe',
      '/settings/members',
      'https://docs.cosmobots.io/cosmika/disponibilidade',
      '/settings/availability',
      'https://docs.cosmobots.io/cosmika/primeiros-passos',
    ])
    for (const a of screen.getAllByRole('link')) {
      if (a.getAttribute('href')!.startsWith('https://')) {
        expect(a).toHaveAttribute('target', '_blank')
        expect(a).toHaveAttribute('rel', 'noopener noreferrer')
      }
    }
  })

  it('renders nothing once every step is done', async () => {
    getOnboarding.mockResolvedValue(
      status({
        channel: true,
        firstMessage: true,
        automation: true,
        team: true,
        availability: true,
      }),
    )
    const { container } = render(<OnboardingChecklist />)
    await waitFor(() => expect(getOnboarding).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('stays out of the way when the status request fails', async () => {
    getOnboarding.mockRejectedValue(new Error('boom'))
    const { container } = render(<OnboardingChecklist />)
    await waitFor(() => expect(getOnboarding).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('is never shown to agents, and does not even ask the API', async () => {
    useStoredSessionMock.mockReturnValue({ session: session('AGENT'), ready: true })
    const { container } = render(<OnboardingChecklist />)
    expect(container).toBeEmptyDOMElement()
    expect(getOnboarding).not.toHaveBeenCalled()
  })

  it('renders nothing without a session', () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: true })
    const { container } = render(<OnboardingChecklist />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides on request and stays hidden for that account', async () => {
    getOnboarding.mockResolvedValue(status({}))
    const { unmount } = render(<OnboardingChecklist />)
    await userEvent.click(await screen.findByRole('button', { name: 'hide' }))

    expect(screen.queryByText('title')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(hiddenKey('acc1'))).toBe('1')

    unmount()
    const { container } = render(<OnboardingChecklist />)
    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(2))
    expect(container).toBeEmptyDOMElement()
  })

  it('still hides when storage is unavailable', async () => {
    getOnboarding.mockResolvedValue(status({}))
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('denied')
      })
    render(<OnboardingChecklist />)
    await userEvent.click(await screen.findByRole('button', { name: 'hide' }))
    expect(screen.queryByText('title')).not.toBeInTheDocument()
    spy.mockRestore()
  })

  it('treats unreadable storage as not hidden', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    getOnboarding.mockResolvedValue(status({}))
    render(<OnboardingChecklist />)
    expect(await screen.findByText('title')).toBeInTheDocument()
    spy.mockRestore()
  })

  it('re-checks progress when the tab regains focus', async () => {
    getOnboarding
      .mockResolvedValueOnce(status({}))
      .mockResolvedValueOnce(status({ channel: true }))
    render(<OnboardingChecklist />)
    expect(await screen.findByText('progress:0,5')).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByText('progress:1,5')).toBeInTheDocument()
  })
})
