import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

const router = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const apiMock = vi.hoisted(() => ({ signUp: vi.fn() }))
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
import SignUpPage from './page'

const ENVELOPE = { session: { token: 'tok' } }

function fill() {
  fireEvent.change(screen.getByLabelText('auth.full_name'), { target: { value: 'Rafa' } })
  fireEvent.change(screen.getByLabelText('auth.account_name'), { target: { value: 'Acme' } })
  fireEvent.change(screen.getByLabelText('auth.email'), { target: { value: 'a@b.co' } })
  fireEvent.change(screen.getByLabelText('auth.password'), { target: { value: 'senha-forte-1' } })
}

const submit = () => screen.getByRole('button', { name: /auth.submit_sign_up|common.loading/ })

afterEach(() => vi.clearAllMocks())

describe('SignUpPage', () => {
  it('prefetches /welcome as soon as the form is on screen', () => {
    render(<SignUpPage />)
    expect(router.prefetch).toHaveBeenCalledWith('/welcome')
  })

  it('keeps the button disabled after success, while /welcome loads', async () => {
    // 20/10/2026: the button came back while /welcome was still loading and a
    // second click answered "email already registered" for the new account.
    apiMock.signUp.mockResolvedValue(ENVELOPE)
    render(<SignUpPage />)
    fill()
    fireEvent.click(submit())
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/welcome'))
    expect(writeSession).toHaveBeenCalledWith(ENVELOPE)
    expect(submit()).toBeDisabled()
    expect(submit()).toHaveTextContent('common.loading')
    fireEvent.click(submit())
    expect(apiMock.signUp).toHaveBeenCalledTimes(1)
  })

  it('re-enables the button and explains a taken address', async () => {
    apiMock.signUp.mockRejectedValue(new ApiError(409, 'x', null))
    render(<SignUpPage />)
    fill()
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.email_taken')
    expect(submit()).not.toBeDisabled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('re-enables the button on any other failure', async () => {
    apiMock.signUp.mockRejectedValue(new Error('network'))
    render(<SignUpPage />)
    fill()
    fireEvent.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('auth.generic_error')
    expect(submit()).not.toBeDisabled()
  })
})
