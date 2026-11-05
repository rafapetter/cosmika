import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bannerKey, dismissedKey, UsageBanner } from './usage-banner'
import type { UsageDTO } from '../lib/api'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

const getUsage = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = (await vi.importActual('../lib/api')) as Record<string, unknown>
  return { ...actual, api: { getUsage: (...a: unknown[]) => getUsage(...a) } }
})

const session = {
  session: { token: 'tok' },
  account: { id: 'acc1' },
  membership: { role: 'ADMINISTRATOR' },
}
const useStoredSessionMock = vi.fn(() => ({ session, ready: true }))
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

function usage(over: Partial<UsageDTO> = {}): UsageDTO {
  return {
    plan: 'ROCKET',
    caps: {
      newConversationsPerMonth: 500,
      totalConversations: 5_000,
      contacts: 5_000,
      overageFraction: 0,
    },
    newConversationsThisMonth: 10,
    totalConversations: 100,
    contacts: 50,
    meters: [
      {
        key: 'newConversations',
        used: 10,
        cap: 500,
        absoluteLimit: 500,
        percent: 2,
        billableOver: 0,
      },
    ],
    state: 'ok',
    warning: [],
    estimatedPlanOverageBrl: 0,
    ai: {
      conversations: 0,
      included: 300,
      overagePriceBrl: null,
      capBrl: null,
      overConversations: 0,
      estimatedOverageBrl: 0,
      resetsAt: '2026-10-01T03:00:00.000Z',
    },
    canManageBilling: true,
    totalConversationsBilled: false,
    ...over,
  }
}

describe('bannerKey', () => {
  it('says nothing when nothing is near a limit', () => {
    expect(bannerKey(usage())).toBeNull()
  })

  it('leads with the AI case, because that is where behaviour changes', () => {
    // On a plan with no AI overage, new conversations stop being answered by
    // the AI and go to the team. That outranks a plan meter, which changes
    // nothing a contact would notice.
    const u = usage({
      state: 'warn',
      warning: ['contacts'],
      ai: { ...usage().ai, conversations: 300 },
    })
    expect(bannerKey(u)).toBe('banner_ai_upgrade')
  })

  it('does not raise the AI upgrade case on a plan that bills overage', () => {
    // Spaceship keeps answering and bills the extra conversations, so there
    // is nothing to upgrade for.
    const u = usage({
      state: 'overage',
      ai: {
        ...usage().ai,
        included: 1_000,
        conversations: 1_100,
        overagePriceBrl: 0.5,
      },
    })
    expect(bannerKey(u)).toBe('banner_overage')
  })

  it('offers an upgrade at a plan limit', () => {
    expect(bannerKey(usage({ state: 'upgrade' }))).toBe('banner_upgrade')
  })

  it('warns at 80% of the AI allowance, ahead of a plan warning', () => {
    const u = usage({
      state: 'warn',
      warning: ['contacts'],
      ai: { ...usage().ai, conversations: 240 },
    })
    expect(bannerKey(u)).toBe('banner_ai_warn')
  })

  it('warns about a plan meter at 90%', () => {
    expect(bannerKey(usage({ state: 'warn', warning: ['contacts'] }))).toBe(
      'banner_warn',
    )
  })

  it('never fires an AI case on a plan with no AI counter', () => {
    const u = usage({ ai: { ...usage().ai, included: null, conversations: 9_999 } })
    expect(bannerKey(u)).toBeNull()
  })
})

describe('UsageBanner', () => {
  beforeEach(() => {
    getUsage.mockReset()
    useStoredSessionMock.mockReturnValue({ session, ready: true } as never)
    window.localStorage.clear()
  })

  afterEach(cleanup)

  it('renders nothing while there is nothing to say', async () => {
    getUsage.mockResolvedValue(usage())
    render(<UsageBanner />)
    await waitFor(() => expect(getUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('usage-banner')).toBeNull()
  })

  it('shows the line and a link to the usage screen', async () => {
    getUsage.mockResolvedValue(usage({ state: 'warn', warning: ['contacts'] }))
    render(<UsageBanner />)
    expect(await screen.findByTestId('usage-banner')).toBeTruthy()
    expect(screen.getByText('banner_warn')).toBeTruthy()
    expect(screen.getByRole('link')).toHaveProperty(
      'href',
      expect.stringContaining('/settings/billing'),
    )
  })

  it('says nothing to an agent, who cannot act on it', async () => {
    // An agent cannot change a plan or a ceiling, so telling them their
    // employer's account is near a limit is noise in the middle of their work.
    useStoredSessionMock.mockReturnValue({
      session: { ...session, membership: { role: 'AGENT' } },
      ready: true,
    } as never)
    render(<UsageBanner />)
    await waitFor(() => expect(getUsage).not.toHaveBeenCalled())
    expect(screen.queryByTestId('usage-banner')).toBeNull()
  })

  it('shows it to a supervisor', async () => {
    useStoredSessionMock.mockReturnValue({
      session: { ...session, membership: { role: 'SUPERVISOR' } },
      ready: true,
    } as never)
    getUsage.mockResolvedValue(usage({ state: 'upgrade' }))
    render(<UsageBanner />)
    expect(await screen.findByTestId('usage-banner')).toBeTruthy()
  })

  it('renders nothing without a session', async () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: true } as never)
    render(<UsageBanner />)
    await waitFor(() => expect(getUsage).not.toHaveBeenCalled())
    expect(screen.queryByTestId('usage-banner')).toBeNull()
  })

  it('stays silent when the usage read fails', async () => {
    // A broken meter is not worth a word to the customer.
    getUsage.mockRejectedValue(new Error('offline'))
    render(<UsageBanner />)
    await waitFor(() => expect(getUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('usage-banner')).toBeNull()
  })

  it('dismisses per state, so a later and different warning still shows', async () => {
    getUsage.mockResolvedValue(usage({ state: 'warn', warning: ['contacts'] }))
    render(<UsageBanner />)
    await screen.findByTestId('usage-banner')
    await userEvent.click(screen.getByRole('button', { name: 'banner_dismiss' }))
    expect(screen.queryByTestId('usage-banner')).toBeNull()
    expect(window.localStorage.getItem(dismissedKey('acc1', 'banner_warn'))).toBe('1')
    // The account later crosses its limit: a different thing to know, so the
    // earlier dismissal does not hide it.
    cleanup()
    getUsage.mockResolvedValue(usage({ state: 'upgrade' }))
    render(<UsageBanner />)
    expect(await screen.findByTestId('usage-banner')).toBeTruthy()
  })

  it('stays hidden on reload once dismissed', async () => {
    window.localStorage.setItem(dismissedKey('acc1', 'banner_upgrade'), '1')
    getUsage.mockResolvedValue(usage({ state: 'upgrade' }))
    render(<UsageBanner />)
    await waitFor(() => expect(getUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('usage-banner')).toBeNull()
  })

  it('survives a browser that refuses local storage', async () => {
    const get = vi
      .spyOn(window.localStorage, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    const set = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    getUsage.mockResolvedValue(usage({ state: 'upgrade' }))
    render(<UsageBanner />)
    await screen.findByTestId('usage-banner')
    await userEvent.click(screen.getByRole('button', { name: 'banner_dismiss' }))
    // Dismissed for this view; it comes back on the next load, which beats
    // crashing the whole shell.
    expect(screen.queryByTestId('usage-banner')).toBeNull()
    get.mockRestore()
    set.mockRestore()
  })
})
