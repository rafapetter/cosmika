// WhatsappEmbeddedSignup: hidden while the flag is off; otherwise opens Meta's
// popup, pairs the login code with the finish message and creates the channel,
// and says why when the customer stops or Meta fails.
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, string>) => (v ? `${k} ${JSON.stringify(v)}` : k),
  useLocale: () => 'pt-BR',
}))

const getEmbeddedSignupConfig = vi.fn()
const completeEmbeddedSignup = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      getEmbeddedSignupConfig: (...a: unknown[]) => getEmbeddedSignupConfig(...a),
      completeEmbeddedSignup: (...a: unknown[]) => completeEmbeddedSignup(...a),
    },
  }
})

type LoginCb = (r: { authResponse?: { code?: string } | null }) => void
const login = vi.fn<(cb: LoginCb, opts: Record<string, unknown>) => void>()
const loadFacebookSdk = vi.fn()
vi.mock('../lib/embedded-signup', async () => {
  const actual = await vi.importActual<typeof import('../lib/embedded-signup')>('../lib/embedded-signup')
  return { ...actual, loadFacebookSdk: (...a: unknown[]) => loadFacebookSdk(...a) }
})

import { ApiError } from '../lib/api'

import { FINISH_MESSAGE_WAIT_MS, WhatsappEmbeddedSignup } from './whatsapp-embedded-signup'

const ON = { enabled: true, appId: 'app1', configId: 'cfg1', graphApiVersion: 'v25.0' }
const FINISH = {
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH',
  data: { waba_id: '1111', phone_number_id: '2222', business_id: '3333' },
}

function meta(data: unknown, origin = 'https://www.facebook.com') {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin, data: JSON.stringify(data) }))
  })
}

function loginCallback(): LoginCb {
  return login.mock.calls.at(-1)![0]
}

async function renderOn(name?: string) {
  const onConnected = vi.fn()
  getEmbeddedSignupConfig.mockResolvedValue(ON)
  const view = render(
    <WhatsappEmbeddedSignup token="tok" accountId="acc1" name={name} onConnected={onConnected} />,
  )
  const button = await screen.findByRole('button', { name: 'inboxes.embedded_signup.connect' })
  return { onConnected, button, ...view }
}

beforeEach(() => {
  getEmbeddedSignupConfig.mockReset()
  completeEmbeddedSignup.mockReset()
  login.mockReset()
  loadFacebookSdk.mockReset().mockResolvedValue({ init: vi.fn(), login })
})

afterEach(() => vi.useRealTimers())

describe('WhatsappEmbeddedSignup', () => {
  it('renders nothing while the feature is off, or when the config cannot be read', async () => {
    getEmbeddedSignupConfig.mockResolvedValue({ enabled: false })
    const { container, unmount } = render(
      <WhatsappEmbeddedSignup token="tok" accountId="acc1" onConnected={vi.fn()} />,
    )
    await waitFor(() => expect(getEmbeddedSignupConfig).toHaveBeenCalledWith('tok', 'acc1'))
    expect(container).toBeEmptyDOMElement()
    unmount()

    getEmbeddedSignupConfig.mockRejectedValue(new Error('down'))
    const second = render(<WhatsappEmbeddedSignup token="tok" accountId="acc1" onConnected={vi.fn()} />)
    await waitFor(() => expect(getEmbeddedSignupConfig).toHaveBeenCalledTimes(2))
    expect(second.container).toBeEmptyDOMElement()
  })

  it('an enabled config missing a value is treated as off', async () => {
    getEmbeddedSignupConfig.mockResolvedValue({ enabled: true, appId: 'a' })
    const { container } = render(<WhatsappEmbeddedSignup token="tok" accountId="acc1" onConnected={vi.fn()} />)
    await waitFor(() => expect(getEmbeddedSignupConfig).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the popup with the v4 options and creates the channel (message first)', async () => {
    const inbox = { id: 'inb_new' }
    completeEmbeddedSignup.mockResolvedValue(inbox)
    const { button, onConnected } = await renderOn('  Recepção  ')
    await userEvent.click(button)

    expect(loadFacebookSdk).toHaveBeenCalledWith('app1', 'v25.0')
    expect(login.mock.calls[0]![1]).toEqual({
      config_id: 'cfg1',
      response_type: 'code',
      override_default_response_type: true,
      extras: {},
    })
    expect(screen.getByRole('button')).toHaveTextContent('inboxes.embedded_signup.opening')

    // A look-alike origin is ignored.
    meta(FINISH, 'https://evilfacebook.com')
    meta(FINISH)
    act(() => loginCallback()({ authResponse: { code: 'the-code' } }))

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(inbox))
    expect(completeEmbeddedSignup).toHaveBeenCalledWith('tok', 'acc1', {
      code: 'the-code',
      event: 'FINISH',
      wabaId: '1111',
      phoneNumberId: '2222',
      businessId: '3333',
      name: 'Recepção',
    })
  })

  it('code first, then message; no name and no business id are left out', async () => {
    completeEmbeddedSignup.mockReturnValue(new Promise(() => {}))
    const { button } = await renderOn('   ')
    await userEvent.click(button)
    act(() => loginCallback()({ authResponse: { code: 'c' } }))
    meta({ ...FINISH, data: { waba_id: '1111', phone_number_id: '2222' } })
    await waitFor(() => expect(completeEmbeddedSignup).toHaveBeenCalled())
    expect(completeEmbeddedSignup.mock.calls[0]![2]).toEqual({
      code: 'c',
      event: 'FINISH',
      wabaId: '1111',
      phoneNumberId: '2222',
    })
    expect(screen.getByRole('button')).toHaveTextContent('inboxes.embedded_signup.finishing')
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('a WABA without a number never reaches the server', async () => {
    const { button } = await renderOn()
    await userEvent.click(button)
    meta({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: '1111' } })
    act(() => loginCallback()({ authResponse: { code: 'c' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.whatsapp_es_phone_required')
    expect(completeEmbeddedSignup).not.toHaveBeenCalled()
  })

  it('a cancel says so, and the button works again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { button } = await renderOn()
    await userEvent.click(button)
    meta({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'WABA_SETUP' } })
    act(() => loginCallback()({ authResponse: null }))
    expect(await screen.findByRole('status')).toHaveTextContent('inboxes.embedded_signup.cancelled')
    expect(info).toHaveBeenCalledWith('[embedded-signup] cancelled', { current_step: 'WABA_SETUP' })
    expect(screen.getByRole('button')).toBeEnabled()
    info.mockRestore()
  })

  it('closing the popup without a message reads as a cancel', async () => {
    const { button } = await renderOn()
    await userEvent.click(button)
    act(() => loginCallback()({}))
    expect(await screen.findByRole('status')).toHaveTextContent('inboxes.embedded_signup.cancelled')
  })

  it('a Meta error is logged with its code and session id and shown for support', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { button } = await renderOn()
    await userEvent.click(button)
    meta({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'CANCEL',
      data: { error_message: 'x', error_code: '524126', session_id: 'S1' },
    })
    expect(warn).toHaveBeenCalledWith('[embedded-signup] error', { error_code: '524126', session_id: 'S1' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'inboxes.embedded_signup.error_meta {"code":"524126","session":"S1"}',
    )

    // And an ERROR without ids still renders.
    await userEvent.click(screen.getByRole('button'))
    meta({ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: {} })
    expect(await screen.findByRole('alert')).toHaveTextContent('{"code":"-","session":"-"}')
    warn.mockRestore()
  })

  it('the server refusing shows its translated reason; anything else the generic one', async () => {
    completeEmbeddedSignup.mockRejectedValueOnce(
      new ApiError(400, 'x', { code: 'whatsapp_es_code_rejected', message: 'x' }),
    )
    const { button } = await renderOn()
    await userEvent.click(button)
    meta(FINISH)
    act(() => loginCallback()({ authResponse: { code: 'c' } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.whatsapp_es_code_rejected')

    completeEmbeddedSignup.mockRejectedValueOnce(new Error('network'))
    await userEvent.click(screen.getByRole('button'))
    meta(FINISH)
    act(() => loginCallback()({ authResponse: { code: 'c2' } }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('auth.generic_error'))
  })

  it('the SDK failing to load is explained', async () => {
    loadFacebookSdk.mockRejectedValue(new Error('blocked'))
    const { button } = await renderOn()
    await userEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('inboxes.embedded_signup.error_sdk')
    expect(login).not.toHaveBeenCalled()
  })

  it('a code whose ids never arrive times out instead of spinning', async () => {
    const { button } = await renderOn()
    await userEvent.click(button)
    vi.useFakeTimers()
    act(() => loginCallback()({ authResponse: { code: 'c' } }))
    act(() => {
      vi.advanceTimersByTime(FINISH_MESSAGE_WAIT_MS)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('inboxes.embedded_signup.error_timeout')
    // A late finish message is no longer listened to.
    meta(FINISH)
    expect(completeEmbeddedSignup).not.toHaveBeenCalled()
  })

  it('stops listening when the screen goes away mid-flow', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { button, unmount } = await renderOn()
    await userEvent.click(button)
    unmount()
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    remove.mockRestore()
  })
})
