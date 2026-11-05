// WhatsappCredentialsForm: stored secrets are never shown (only "configured"),
// a save sends only what the admin changed, and API refusals land as readable
// messages on the right fields.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k, useLocale: () => 'pt-BR' }))

const updateWhatsappCredentials = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      updateWhatsappCredentials: (...a: unknown[]) => updateWhatsappCredentials(...a),
    },
  }
})

import { ApiError } from '../lib/api'

import { WhatsappCredentialsForm } from './whatsapp-credentials-form'

const ALL_SET = { accessToken: true, appSecret: true, webhookVerifyToken: true }

function renderForm(overrides: Partial<Parameters<typeof WhatsappCredentialsForm>[0]> = {}) {
  const onSaved = vi.fn()
  render(
    <WhatsappCredentialsForm
      token="tok"
      accountId="acc1"
      inboxId="inb1"
      canEdit
      phoneNumberId="phone-old"
      businessAccountId="waba-old"
      secrets={ALL_SET}
      onSaved={onSaved}
      {...overrides}
    />,
  )
  return { onSaved }
}

function dto(channelConfig: Record<string, unknown>) {
  return { id: 'inb1', channelType: 'WHATSAPP', channelConfig, whatsappSecrets: ALL_SET }
}

beforeEach(() => {
  updateWhatsappCredentials.mockReset()
})

describe('WhatsappCredentialsForm', () => {
  it('shows the IDs and masks stored secrets as configured, with no input holding them', () => {
    renderForm()
    expect(screen.getByLabelText('phone_number_id')).toHaveValue('phone-old')
    expect(screen.getByLabelText('business_account_id')).toHaveValue('waba-old')
    for (const field of ['accessToken', 'appSecret', 'webhookVerifyToken']) {
      expect(screen.getByTestId(`secret-${field}`)).toHaveTextContent('••••• configured')
    }
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'replace' })).toHaveLength(3)
    expect(screen.getByTestId('save-whatsapp-credentials')).toBeDisabled()
  })

  it('shows an empty input straight away for a secret that was never set', () => {
    renderForm({ secrets: { accessToken: true, appSecret: false, webhookVerifyToken: false } })
    expect(screen.getByLabelText('app_secret')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('webhook_verify_token')).toHaveValue('')
    expect(screen.getAllByRole('button', { name: 'replace' })).toHaveLength(1)
  })

  it('sends only the replaced secret, then clears it and reports success', async () => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockResolvedValue(
      dto({ phoneNumberId: 'phone-old', businessAccountId: 'waba-old' }),
    )
    const { onSaved } = renderForm()

    await user.click(screen.getAllByRole('button', { name: 'replace' })[1]!)
    const input = screen.getByLabelText('app_secret')
    expect(input).toHaveFocus()
    expect(screen.getByText('blank_keeps')).toBeInTheDocument()
    await user.type(input, 'NEW-APP-SECRET-123')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(updateWhatsappCredentials).toHaveBeenCalledWith('tok', 'acc1', 'inb1', {
      appSecret: 'NEW-APP-SECRET-123',
    })
    expect(screen.getByRole('status')).toHaveTextContent('saved')
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
  })

  it('sends a changed ID (trimmed) and nothing for untouched fields', async () => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockResolvedValue(
      dto({ phoneNumberId: 'phone-new', businessAccountId: 'waba-old' }),
    )
    renderForm()
    const phone = screen.getByLabelText('phone_number_id')
    await user.clear(phone)
    await user.type(phone, '  phone-new ')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))

    await waitFor(() => expect(updateWhatsappCredentials).toHaveBeenCalled())
    expect(updateWhatsappCredentials.mock.calls[0]![3]).toEqual({ phoneNumberId: 'phone-new' })
    await waitFor(() => expect(phone).toHaveValue('phone-new'))
  })

  it('treats a cleared ID as unchanged instead of sending a blank', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.clear(screen.getByLabelText('business_account_id'))
    expect(screen.getByTestId('save-whatsapp-credentials')).toBeDisabled()
  })

  it('"keep current" drops a half-typed replacement', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getAllByRole('button', { name: 'replace' })[0]!)
    await user.type(screen.getByLabelText('access_token'), 'NEW-ACCESS-TOKEN-123')
    expect(screen.getByTestId('save-whatsapp-credentials')).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'keep_current' }))
    expect(screen.getByTestId('secret-accessToken')).toHaveTextContent('configured')
    expect(screen.getByTestId('save-whatsapp-credentials')).toBeDisabled()
  })

  it('marks the fields the API rejected', async () => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockRejectedValue(
      new ApiError(400, 'Invalid input', {
        issues: [{ path: 'accessToken', message: 'too short' }, { message: 'no path' }],
      }),
    )
    renderForm()
    await user.click(screen.getAllByRole('button', { name: 'replace' })[0]!)
    await user.type(screen.getByLabelText('access_token'), 'short')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map((a) => a.textContent)).toEqual(['invalid_field', 'error_invalid'])
  })

  it('handles a 400 without an issues list', async () => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockRejectedValue(new ApiError(400, 'bad', null))
    renderForm()
    await user.type(screen.getByLabelText('business_account_id'), '9')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))
    expect(await screen.findByRole('alert')).toHaveTextContent('error_invalid')
    expect(updateWhatsappCredentials.mock.calls[0]![3]).toEqual({ businessAccountId: 'waba-old9' })
  })

  it.each([
    [new ApiError(403, 'Forbidden', null), 'admin_only'],
    [new ApiError(409, 'Conflict', null), 'error_phone_in_use'],
    [new ApiError(500, 'Internal', null), 'error_generic'],
    [new Error('network down'), 'error_generic'],
  ])('explains a failed save (%s)', async (failure, message) => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockRejectedValue(failure)
    const { onSaved } = renderForm()
    await user.type(screen.getByLabelText('phone_number_id'), '9')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('is read-only for someone who is not an administrator', () => {
    renderForm({
      canEdit: false,
      secrets: { accessToken: true, appSecret: false, webhookVerifyToken: true },
    })
    expect(screen.getByText('admin_only')).toBeInTheDocument()
    expect(screen.getByLabelText('phone_number_id')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'replace' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('save-whatsapp-credentials')).not.toBeInTheDocument()
    expect(screen.getByTestId('secret-appSecret')).toHaveTextContent('not_configured')
  })

  it('does not submit when nothing changed', async () => {
    renderForm()
    const form = screen.getByTestId('whatsapp-credentials').querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(updateWhatsappCredentials).not.toHaveBeenCalled()
  })

  it('keeps the typed IDs when the response carries none', async () => {
    const user = userEvent.setup()
    updateWhatsappCredentials.mockResolvedValue(dto({}))
    renderForm({ secrets: null })
    await user.type(screen.getByLabelText('access_token'), 'NEW-ACCESS-TOKEN-123')
    await user.click(screen.getByTestId('save-whatsapp-credentials'))
    await screen.findByRole('status')
    expect(screen.getByLabelText('phone_number_id')).toHaveValue('phone-old')
  })
})
