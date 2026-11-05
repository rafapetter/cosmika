// BusinessProfileForm: the "About the business" section in Settings.
//
// This is what makes "skip for now" reversible, so the things that matter are
// that it loads what was answered, that saving here does not move the flow's
// state, and that it is invisible to anyone who is not an administrator.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'pt-BR',
}))

const getAccountProfile = vi.fn()
const saveAccountProfile = vi.fn()
vi.mock('../lib/api', () => ({
  api: {
    getAccountProfile: (...a: unknown[]) => getAccountProfile(...a),
    saveAccountProfile: (...a: unknown[]) => saveAccountProfile(...a),
  },
}))

vi.mock('../lib/api-error', () => ({ apiErrorText: () => 'boom' }))

const useStoredSessionMock = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

import { BusinessProfileForm } from './business-profile-form'

function profile(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acc1',
    businessIndustry: 'retail',
    companySize: 'upTo5',
    businessDescription: 'Vendemos café',
    supportToday: 'myself',
    channelsToday: ['whatsapp'],
    conversationVolume: 'upTo500',
    intendedFeatures: ['flows'],
    expectedVolume: 'upTo1500',
    expectedAiShare: null,
    version: 1,
    lastStep: 'done',
    startedAt: '2026-09-18T10:00:00.000Z',
    completedAt: '2026-09-18T10:30:00.000Z',
    skippedAt: null,
    ...over,
  }
}

async function choose(user: ReturnType<typeof userEvent.setup>, id: string, label: string) {
  await user.click(document.getElementById(id)!)
  await user.click(await screen.findByRole('option', { name: label }))
}

beforeEach(() => {
  getAccountProfile.mockReset().mockResolvedValue(profile())
  saveAccountProfile.mockReset().mockResolvedValue(profile())
  useStoredSessionMock.mockReturnValue({
    session: {
      session: { token: 'tok' },
      user: { id: 'u1' },
      account: { id: 'acc1' },
      membership: { role: 'ADMINISTRATOR' },
    },
    ready: true,
  })
})

describe('BusinessProfileForm', () => {
  it('shows what was answered in the welcome flow', async () => {
    render(<BusinessProfileForm isAdmin />)
    expect(await screen.findByText('onboardingFlow.settings.title')).toBeInTheDocument()
    expect(screen.getByText('onboardingFlow.settings.subtitle')).toBeInTheDocument()
    expect(
      screen.getByLabelText('onboardingFlow.business.description'),
    ).toHaveValue('Vendemos café')
    expect(screen.getByLabelText('onboardingFlow.channels.whatsapp')).toBeChecked()
    expect(screen.getByLabelText('onboardingFlow.features.flows')).toBeChecked()
  })

  it('says so, rather than lying about it, when nothing was answered', async () => {
    getAccountProfile.mockResolvedValue(null)
    render(<BusinessProfileForm isAdmin />)
    expect(await screen.findByText('onboardingFlow.settings.empty')).toBeInTheDocument()
    expect(
      screen.getByLabelText('onboardingFlow.business.description'),
    ).toHaveValue('')
  })

  it('handles a profile saved with no description', async () => {
    getAccountProfile.mockResolvedValue(profile({ businessDescription: null }))
    render(<BusinessProfileForm isAdmin />)
    await screen.findByText('onboardingFlow.settings.title')
    expect(
      screen.getByLabelText('onboardingFlow.business.description'),
    ).toHaveValue('')
  })

  it('renders nothing before the stored session is read', () => {
    useStoredSessionMock.mockReturnValue({ session: null, ready: false })
    const { container } = render(<BusinessProfileForm isAdmin />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not exist for anyone who is not an administrator', async () => {
    const { container } = render(<BusinessProfileForm isAdmin={false} />)
    await waitFor(() => expect(getAccountProfile).not.toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing while the answers are still loading', () => {
    getAccountProfile.mockReturnValue(new Promise(() => {}))
    const { container } = render(<BusinessProfileForm isAdmin />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opens anyway when the answers cannot be read', async () => {
    getAccountProfile.mockRejectedValue(new Error('down'))
    render(<BusinessProfileForm isAdmin />)
    expect(await screen.findByText('onboardingFlow.settings.empty')).toBeInTheDocument()
  })

  it('saves an edit without moving the flow state', async () => {
    const user = userEvent.setup()
    render(<BusinessProfileForm isAdmin />)
    await screen.findByText('onboardingFlow.settings.title')

    await choose(user, 'profile-industry', 'onboardingFlow.industries.education')
    await user.click(screen.getByText('onboardingFlow.settings.save'))

    await waitFor(() => expect(saveAccountProfile).toHaveBeenCalled())
    const body = saveAccountProfile.mock.calls[0]![2]
    expect(body).toMatchObject({ businessIndustry: 'education' })
    // The two keys that would put a finished account back in the funnel.
    expect(body).not.toHaveProperty('state')
    expect(body).not.toHaveProperty('lastStep')
    expect(await screen.findByText('onboardingFlow.settings.saved')).toBeInTheDocument()
  })

  it('asks about the AI share only once the AI agent is ticked, and drops it otherwise', async () => {
    const user = userEvent.setup()
    render(<BusinessProfileForm isAdmin />)
    await screen.findByText('onboardingFlow.settings.title')
    expect(screen.queryByLabelText('onboardingFlow.intent.ai_share')).toBeNull()

    await user.click(screen.getByLabelText('onboardingFlow.features.aiAgent'))
    await choose(user, 'profile-ai-share', 'onboardingFlow.ai_shares.most')
    await user.click(screen.getByText('onboardingFlow.settings.save'))

    await waitFor(() =>
      expect(saveAccountProfile.mock.calls[0]![2]).toMatchObject({
        intendedFeatures: ['flows', 'aiAgent'],
        expectedAiShare: 'most',
      }),
    )
  })

  it('empties the description rather than storing a blank string', async () => {
    const user = userEvent.setup()
    render(<BusinessProfileForm isAdmin />)
    await screen.findByText('onboardingFlow.settings.title')
    await user.clear(screen.getByLabelText('onboardingFlow.business.description'))
    await user.click(screen.getByText('onboardingFlow.settings.save'))
    await waitFor(() =>
      expect(saveAccountProfile.mock.calls[0]![2]).toMatchObject({
        businessDescription: null,
      }),
    )
  })

  it('reports a refused save on the form', async () => {
    const user = userEvent.setup()
    saveAccountProfile.mockRejectedValue(new Error('down'))
    render(<BusinessProfileForm isAdmin />)
    await screen.findByText('onboardingFlow.settings.title')
    await user.click(screen.getByText('onboardingFlow.settings.save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})
