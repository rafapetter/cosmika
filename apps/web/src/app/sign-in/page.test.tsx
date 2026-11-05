import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }))
const params = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => params.value,
}))

const apiMock = vi.hoisted(() => ({ signIn: vi.fn(), totpChallenge: vi.fn() }))
vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

const writeSession = vi.hoisted(() => vi.fn())
vi.mock('../../lib/session-store', () => ({ writeSession }))

import { ApiError } from '../../lib/api'
import SignInPage from './page'

const ENVELOPE = { session: { token: 'tok' } }

function fill() {
  fireEvent.change(screen.getByLabelText('auth.email'), { target: { value: 'a@b.co' } })
  fireEvent.change(screen.getByLabelText('auth.password'), { target: { value: 'senha-forte-1' } })
}

const button = () => screen.getAllByRole('button').find((b) => b.getAttribute('type') === 'submit')!

afterEach(() => {
  vi.clearAllMocks()
  params.value = new URLSearchParams()
})

describe('SignInPage', () => {
  it('prefetches where it will land', () => {
    params.value = new URLSearchParams('next=/tickets')
    render(<SignInPage />)
    expect(router.prefetch).toHaveBeenCalledWith('/tickets')
  })

  it('keeps the button disabled after a successful sign-in', async () => {
    apiMock.signIn.mockResolvedValue(ENVELOPE)
    render(<SignInPage />)
    fill()
    fireEvent.click(button())
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/inbox'))
    expect(button()).toBeDisabled()
  })

  it('re-enables the button for the 2FA step', async () => {
    apiMock.signIn.mockResolvedValue({ kind: 'totp', challengeToken: 'chal' })
    render(<SignInPage />)
    fill()
    fireEvent.click(button())
    const code = await screen.findByTestId('signin-totp')
    fireEvent.change(code, { target: { value: '123456' } })
    expect(button()).not.toBeDisabled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('keeps the button disabled after the 2FA code is accepted', async () => {
    apiMock.signIn.mockResolvedValue({ kind: 'totp', challengeToken: 'chal' })
    apiMock.totpChallenge.mockResolvedValue(ENVELOPE)
    render(<SignInPage />)
    fill()
    fireEvent.click(button())
    fireEvent.change(await screen.findByTestId('signin-totp'), { target: { value: '123456' } })
    fireEvent.click(button())
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/inbox'))
    expect(apiMock.totpChallenge).toHaveBeenCalledWith('chal', '123456')
    expect(button()).toBeDisabled()
  })

  it('re-enables the button on a wrong 2FA code', async () => {
    apiMock.signIn.mockResolvedValue({ kind: 'totp', challengeToken: 'chal' })
    apiMock.totpChallenge.mockRejectedValue(new ApiError(401, 'x', null))
    render(<SignInPage />)
    fill()
    fireEvent.click(button())
    fireEvent.change(await screen.findByTestId('signin-totp'), { target: { value: '000000' } })
    fireEvent.click(button())
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.totp_invalid')
    expect(button()).not.toBeDisabled()
  })

  it('re-enables the button on wrong credentials', async () => {
    apiMock.signIn.mockRejectedValue(new ApiError(401, 'x', null))
    render(<SignInPage />)
    fill()
    fireEvent.click(button())
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.invalid_credentials')
    expect(button()).not.toBeDisabled()
  })
})
