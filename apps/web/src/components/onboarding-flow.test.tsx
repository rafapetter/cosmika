// OnboardingFlow: the four screens shown right after signup.
//
// What has to hold, whatever else changes: an invited member never sees the
// account questions, skipping always gets you out (even when the API is
// down), each screen saves on its own so giving up halfway still leaves the
// earlier answers behind, and coming back resumes where it stopped.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const T = (k: string, vars?: Record<string, unknown>) =>
  vars ? `${k}:${Object.values(vars).join(',')}` : k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const replace = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
}))

const getAccountProfile = vi.fn()
const saveAccountProfile = vi.fn()
const updateAccount = vi.fn()
const updateMe = vi.fn()
vi.mock('../lib/api', () => ({
  api: {
    getAccountProfile: (...a: unknown[]) => getAccountProfile(...a),
    saveAccountProfile: (...a: unknown[]) => saveAccountProfile(...a),
    updateAccount: (...a: unknown[]) => updateAccount(...a),
    updateMe: (...a: unknown[]) => updateMe(...a),
  },
}))

const useStoredSessionMock = vi.fn()
const writeSession = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
  writeSession: (...a: unknown[]) => writeSession(...a),
}))

import {
  OnboardingFlow,
  guessLocale,
  guessTimezone,
  looksLikeDomain,
} from './onboarding-flow'

const ACCOUNT = {
  id: 'acc1',
  slug: 'acme',
  name: 'Acme',
  domain: null,
  status: 'ACTIVE',
  plan: 'ROCKET',
  defaultLocale: 'pt-BR',
  defaultTimezone: 'America/Sao_Paulo',
  createdAt: '2026-09-18T00:00:00.000Z',
}

function session(role = 'ADMINISTRATOR') {
  return {
    session: { token: 'tok' },
    user: { id: 'u1', email: 'a@e.com', fullName: 'Ana Souza', phone: null },
    account: ACCOUNT,
    membership: { role },
  }
}

function profile(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acc1',
    businessIndustry: null,
    companySize: null,
    businessDescription: null,
    supportToday: null,
    channelsToday: [],
    conversationVolume: null,
    intendedFeatures: [],
    expectedVolume: null,
    expectedAiShare: null,
    version: 1,
    lastStep: null,
    startedAt: '2026-09-18T10:00:00.000Z',
    completedAt: null,
    skippedAt: null,
    ...over,
  }
}

/** Pick an option out of a Radix Select by its trigger id. */
async function choose(user: ReturnType<typeof userEvent.setup>, id: string, label: string) {
  await user.click(document.getElementById(id)!)
  await user.click(await screen.findByRole('option', { name: label }))
}

const setSession = vi.fn()

beforeEach(() => {
  replace.mockReset()
  push.mockReset()
  getAccountProfile.mockReset().mockResolvedValue(null)
  saveAccountProfile.mockReset().mockResolvedValue(profile())
  updateAccount.mockReset().mockResolvedValue(ACCOUNT)
  updateMe.mockReset().mockResolvedValue(session().user)
  writeSession.mockReset()
  setSession.mockReset()
  useStoredSessionMock.mockReturnValue({ session: session(), ready: true, setSession })
})

describe('OnboardingFlow access', () => {
  it('renders nothing until the stored session has been read', () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: false, setSession })
    const { container } = render(<OnboardingFlow />)
    expect(container).toBeEmptyDOMElement()
    expect(replace).not.toHaveBeenCalled()
  })

  it('sends a visitor with no session to sign in', async () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: true, setSession })
    render(<OnboardingFlow />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/sign-in'))
  })

  it.each(['AGENT', 'SUPERVISOR'])(
    'never shows the account questions to an invited %s',
    async (role) => {
      useStoredSessionMock.mockReturnValue({
        session: session(role),
        ready: true,
        setSession,
      })
      render(<OnboardingFlow />)
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/inbox'))
      expect(getAccountProfile).not.toHaveBeenCalled()
      expect(screen.queryByText('onboardingFlow.company.title')).toBeNull()
    },
  )

  it.each([
    ['completed', { completedAt: '2026-09-18T11:00:00.000Z' }],
    ['skipped', { skippedAt: '2026-09-18T11:00:00.000Z' }],
  ])('does not ask again once the flow was %s', async (_name, over) => {
    getAccountProfile.mockResolvedValue(profile(over))
    render(<OnboardingFlow />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/inbox'))
  })

  it('still opens when the profile call fails', async () => {
    getAccountProfile.mockRejectedValue(new Error('down'))
    render(<OnboardingFlow />)
    expect(await screen.findByText('onboardingFlow.company.title')).toBeInTheDocument()
  })
})

describe('OnboardingFlow screens', () => {
  it('starts on screen one with the progress bar counting steps, not percent', async () => {
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '4')
    expect(screen.getAllByText('onboardingFlow.step_of:1,4').length).toBeGreaterThan(0)
  })

  it('prefills the company screen from the account, and offers skip on it', async () => {
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    expect(screen.getByLabelText('onboardingFlow.company.name')).toHaveValue('Acme')
    expect(screen.getByText('onboardingFlow.skip')).toBeInTheDocument()
    // And what skipping costs is said before the click, not after it.
    expect(screen.getByText('onboardingFlow.skipped_notice')).toBeInTheDocument()
    // Nothing on the first screen is required.
    expect(document.querySelectorAll('[required]')).toHaveLength(0)
  })

  it('saves the company screen to the account and the industry to the profile', async () => {
    const user = userEvent.setup()
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')

    await user.clear(screen.getByLabelText('onboardingFlow.company.name'))
    await user.type(screen.getByLabelText('onboardingFlow.company.name'), 'Clínica Sol')
    await user.type(screen.getByLabelText('onboardingFlow.company.domain'), 'sol.com.br')
    await choose(user, 'profile-industry', 'onboardingFlow.industries.healthcare')
    await choose(user, 'profile-size', 'onboardingFlow.sizes.upTo15')
    await user.click(screen.getByText('onboardingFlow.continue'))

    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith('tok', 'acc1', {
        name: 'Clínica Sol',
        domain: 'sol.com.br',
        defaultLocale: expect.any(String),
        defaultTimezone: expect.any(String),
      }),
    )
    expect(saveAccountProfile).toHaveBeenCalledWith('tok', 'acc1', {
      lastStep: 'admin',
      state: 'in_progress',
      businessIndustry: 'healthcare',
      companySize: 'upTo15',
    })
    // The shell reads the account from storage, so the rename has to land now.
    expect(writeSession).toHaveBeenCalled()
    expect(await screen.findByText('onboardingFlow.admin.title')).toBeInTheDocument()
  })

  it('saves the timezone and language the person actually picked', async () => {
    const user = userEvent.setup()
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')

    const tz = screen.getByLabelText('onboardingFlow.company.timezone')
    await user.clear(tz)
    await user.type(tz, 'Europe/Lisbon')
    // Not English: jsdom reports navigator.language as en-US, so the screen
    // already starts there and Radix would not fire a change at all.
    await choose(user, 'welcome-locale', 'Español')
    await user.click(screen.getByText('onboardingFlow.continue'))

    await waitFor(() =>
      expect(updateAccount.mock.calls[0]![2]).toMatchObject({
        defaultTimezone: 'Europe/Lisbon',
        defaultLocale: 'es',
      }),
    )
  })

  it('records a name typed on the admin screen', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'admin' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.admin.title')
    const name = screen.getByLabelText('onboardingFlow.admin.full_name')
    await user.clear(name)
    await user.type(name, 'Ana Paula')
    await user.click(screen.getByText('onboardingFlow.continue'))
    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith('tok', {
        fullName: 'Ana Paula',
        phone: null,
      }),
    )
  })

  it('keeps the current name when the field is emptied', async () => {
    const user = userEvent.setup()
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    await user.clear(screen.getByLabelText('onboardingFlow.company.name'))
    await user.click(screen.getByText('onboardingFlow.continue'))
    await waitFor(() =>
      expect(updateAccount.mock.calls[0]![2]).toMatchObject({ name: 'Acme' }),
    )
  })

  it('refuses a site that is not an address, and only when one was typed', async () => {
    const user = userEvent.setup()
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    await user.type(screen.getByLabelText('onboardingFlow.company.domain'), 'not a site')
    await user.click(screen.getByText('onboardingFlow.continue'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'onboardingFlow.company.domain_error',
    )
    expect(updateAccount).not.toHaveBeenCalled()
  })

  it('saves the admin screen to the person, not to the account', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'admin' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.admin.title')

    await user.type(screen.getByLabelText('onboardingFlow.admin.phone'), '+55 11 90000-0000')
    await user.click(screen.getByText('onboardingFlow.continue'))

    await waitFor(() =>
      expect(updateMe).toHaveBeenCalledWith('tok', {
        fullName: 'Ana Souza',
        phone: '+55 11 90000-0000',
      }),
    )
    expect(saveAccountProfile).toHaveBeenCalledWith('tok', 'acc1', {
      lastStep: 'business',
      state: 'in_progress',
    })
  })

  it('sends a blank name and phone as nothing rather than as empty text', async () => {
    const user = userEvent.setup()
    useStoredSessionMock.mockReturnValue({
      session: { ...session(), user: { id: 'u1', email: 'a@e.com', fullName: null, phone: null } },
      ready: true,
      setSession,
    })
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'admin' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.admin.title')
    await user.click(screen.getByText('onboardingFlow.continue'))
    await waitFor(() => expect(updateMe).toHaveBeenCalledWith('tok', { phone: null }))
  })

  it('saves the business screen answers', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'business' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.business.title')

    await user.type(
      screen.getByLabelText('onboardingFlow.business.description'),
      'Clínica de fisioterapia',
    )
    await choose(user, 'profile-support-today', 'onboardingFlow.support.internalTeam')
    await user.click(screen.getByLabelText('onboardingFlow.channels.whatsapp'))
    await user.click(screen.getByLabelText('onboardingFlow.channels.email'))
    // Ticking twice takes it back off.
    await user.click(screen.getByLabelText('onboardingFlow.channels.email'))
    await choose(user, 'welcome-volume', 'onboardingFlow.volumes.upTo500')
    await user.click(screen.getByText('onboardingFlow.continue'))

    await waitFor(() =>
      expect(saveAccountProfile).toHaveBeenCalledWith('tok', 'acc1', {
        lastStep: 'intent',
        state: 'in_progress',
        businessDescription: 'Clínica de fisioterapia',
        supportToday: 'internalTeam',
        channelsToday: ['whatsapp'],
        conversationVolume: 'upTo500',
      }),
    )
  })

  it('leaves an unanswered description null instead of an empty string', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'business' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.business.title')
    await user.click(screen.getByText('onboardingFlow.continue'))
    await waitFor(() =>
      expect(saveAccountProfile.mock.calls[0]![2]).toMatchObject({
        businessDescription: null,
      }),
    )
  })

  it('asks how much the AI should answer only when the AI agent was ticked', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')

    expect(screen.queryByLabelText('onboardingFlow.intent.ai_share')).toBeNull()
    await user.click(screen.getByLabelText('onboardingFlow.features.aiAgent'))
    expect(screen.getByLabelText('onboardingFlow.intent.ai_share')).toBeInTheDocument()
  })

  it('shows the privacy line with the contact address, and no plan or price', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', 'support@acme.example')
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')
    expect(
      screen.getByText('onboardingFlow.intent.privacy:support@acme.example'),
    ).toBeInTheDocument()
    vi.unstubAllEnvs()
    for (const word of ['Rocket', 'Spaceship', 'Explorer', 'R$']) {
      expect(screen.queryByText(new RegExp(word))).toBeNull()
    }
  })

  it('leaves the privacy line out on an install with no support address', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '')
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')
    expect(screen.queryByText(/onboardingFlow\.intent\.privacy/)).toBeNull()
    vi.unstubAllEnvs()
  })

  it('finishes on the last screen and lands on the closing card', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')

    await user.click(screen.getByLabelText('onboardingFlow.features.aiAgent'))
    await choose(user, 'profile-ai-share', 'onboardingFlow.ai_shares.aboutHalf')
    await choose(user, 'welcome-expected-volume', 'onboardingFlow.volumes.upTo1500')
    await user.click(screen.getByText('onboardingFlow.finish'))

    await waitFor(() =>
      expect(saveAccountProfile).toHaveBeenCalledWith('tok', 'acc1', {
        lastStep: 'done',
        state: 'completed',
        intendedFeatures: ['aiAgent'],
        expectedVolume: 'upTo1500',
        expectedAiShare: 'aboutHalf',
      }),
    )
    expect(
      await screen.findByText('onboardingFlow.done.title:Ana'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'onboardingFlow.done.primary' })).toHaveAttribute(
      'href',
      '/inboxes/new',
    )
    expect(screen.getByTestId('trial-note')).toHaveTextContent(
      'onboardingFlow.done.trial',
    )
  })

  it('the closing note names no plan and quotes no price', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')
    await user.click(screen.getByText('onboardingFlow.finish'))
    await screen.findByTestId('trial-note')

    // The guard is on the whole card, not just the note: a price or a plan
    // name anywhere here is a number that goes stale inside the product,
    // where the pricing page and cosmo-admin are the authority.
    const card = document.querySelector('[data-screen="done"]')!
    expect(card.textContent).not.toMatch(
      /Explorer|Jetpack|Rocket|Spaceship|Enterprise|R\$|US\$|\d+[.,]\d{2}/i,
    )
  })

  it('drops the AI expectation when the AI agent was unticked again', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(
      profile({ lastStep: 'intent', intendedFeatures: ['aiAgent'], expectedAiShare: 'most' }),
    )
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')
    await user.click(screen.getByLabelText('onboardingFlow.features.aiAgent'))
    await user.click(screen.getByText('onboardingFlow.finish'))
    await waitFor(() =>
      expect(saveAccountProfile.mock.calls[0]![2]).toMatchObject({
        intendedFeatures: [],
        expectedAiShare: null,
      }),
    )
  })

  it('greets without a name when the account has none', async () => {
    const user = userEvent.setup()
    useStoredSessionMock.mockReturnValue({
      session: { ...session(), user: { id: 'u1', email: 'a@e.com', fullName: null, phone: null } },
      ready: true,
      setSession,
    })
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'intent' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.intent.title')
    await user.click(screen.getByText('onboardingFlow.finish'))
    expect(
      await screen.findByText('onboardingFlow.done.title_anonymous'),
    ).toBeInTheDocument()
  })
})

describe('OnboardingFlow resuming, going back and skipping', () => {
  it('resumes at the screen the person stopped on', async () => {
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'business' }))
    render(<OnboardingFlow />)
    expect(await screen.findByText('onboardingFlow.business.title')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
  })

  it('brings back what was already answered', async () => {
    getAccountProfile.mockResolvedValue(
      profile({
        lastStep: 'business',
        businessDescription: 'Vendemos café',
        channelsToday: ['telegram'],
      }),
    )
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.business.title')
    expect(screen.getByLabelText('onboardingFlow.business.description')).toHaveValue(
      'Vendemos café',
    )
    expect(screen.getByLabelText('onboardingFlow.channels.telegram')).toBeChecked()
  })

  it('a stale done marker with no end timestamp restarts rather than dead-ending', async () => {
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'done' }))
    render(<OnboardingFlow />)
    expect(await screen.findByText('onboardingFlow.company.title')).toBeInTheDocument()
  })

  it('goes back without saving, and screen one has no back button', async () => {
    const user = userEvent.setup()
    getAccountProfile.mockResolvedValue(profile({ lastStep: 'admin' }))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.admin.title')
    await user.click(screen.getByText('onboardingFlow.back'))
    expect(await screen.findByText('onboardingFlow.company.title')).toBeInTheDocument()
    expect(screen.queryByText('onboardingFlow.back')).toBeNull()
    expect(updateAccount).not.toHaveBeenCalled()
  })

  it('skipping writes it down and lets the person into the product', async () => {
    const user = userEvent.setup()
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    await user.click(screen.getByText('onboardingFlow.skip'))
    await waitFor(() =>
      expect(saveAccountProfile).toHaveBeenCalledWith('tok', 'acc1', {
        state: 'skipped',
        lastStep: 'company',
      }),
    )
    expect(push).toHaveBeenCalledWith('/inbox')
  })

  it('skipping still lets the person in when the save fails', async () => {
    const user = userEvent.setup()
    saveAccountProfile.mockRejectedValue(new Error('down'))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    await user.click(screen.getByText('onboardingFlow.skip'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/inbox'))
  })

  it('a failed save keeps the screen and says so, without losing what was typed', async () => {
    const user = userEvent.setup()
    updateAccount.mockRejectedValue(new Error('down'))
    render(<OnboardingFlow />)
    await screen.findByText('onboardingFlow.company.title')
    await user.type(screen.getByLabelText('onboardingFlow.company.name'), '!')
    await user.click(screen.getByText('onboardingFlow.continue'))
    expect(await screen.findByRole('alert')).toHaveTextContent('onboardingFlow.save_error')
    expect(screen.getByText('onboardingFlow.company.title')).toBeInTheDocument()
    expect(screen.getByLabelText('onboardingFlow.company.name')).toHaveValue('Acme!')
    // And the way out is still there.
    expect(screen.getByText('onboardingFlow.skip')).toBeInTheDocument()
  })
})

describe('prefill helpers', () => {
  it('guessTimezone takes the browser zone when it resolves', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({
        resolvedOptions: () => ({ timeZone: 'Europe/Lisbon' }),
      } as never)
    expect(guessTimezone('America/Sao_Paulo')).toBe('Europe/Lisbon')
    spy.mockRestore()
  })

  it('guessTimezone falls back on an unusable answer', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({ resolvedOptions: () => ({ timeZone: '' }) } as never)
    expect(guessTimezone('America/Sao_Paulo')).toBe('America/Sao_Paulo')
    spy.mockRestore()
  })

  it('guessTimezone falls back when the browser throws', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl')
    })
    expect(guessTimezone('UTC')).toBe('UTC')
    spy.mockRestore()
  })

  it.each([
    ['pt-BR', 'pt-BR'],
    ['pt', 'pt-BR'],
    ['es-ES', 'es'],
    ['en-GB', 'en'],
    ['de-DE', 'en'],
  ])('guessLocale maps %s to %s', (nav, expected) => {
    const spy = vi.spyOn(navigator, 'language', 'get').mockReturnValue(nav)
    expect(guessLocale('en')).toBe(expected)
    spy.mockRestore()
  })

  it.each([
    ['', true],
    ['acme.com', true],
    ['https://acme.com.br', true],
    ['acme', false],
    ['not a site', false],
  ])('looksLikeDomain(%s) is %s', (value, expected) => {
    expect(looksLikeDomain(value)).toBe(expected)
  })
})
