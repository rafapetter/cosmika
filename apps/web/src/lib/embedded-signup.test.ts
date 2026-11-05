import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSignupSession,
  embeddedSignupLoginOptions,
  FACEBOOK_SDK_URL,
  isFacebookOrigin,
  loadFacebookSdk,
  parseEmbeddedSignupMessage,
  resetFacebookSdkForTests,
} from './embedded-signup'

const FB_ORIGIN = 'https://www.facebook.com'

describe('isFacebookOrigin', () => {
  it.each([
    ['https://www.facebook.com', true],
    ['https://facebook.com', true],
    ['https://business.facebook.com', true],
    ['http://www.facebook.com', false],
    ['https://evilfacebook.com', false],
    ['https://facebook.com.evil.io', false],
    ['https://app.cosmobots.io', false],
    ['not a url', false],
    ['', false],
  ])('%s → %s', (origin, ok) => {
    expect(isFacebookOrigin(origin)).toBe(ok)
  })
})

describe('parseEmbeddedSignupMessage', () => {
  const finish = {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH',
    data: { phone_number_id: '2222', waba_id: '1111', business_id: '3333' },
  }

  it('reads a finish message, as a JSON string or an object', () => {
    const expected = {
      kind: 'finish',
      event: 'FINISH',
      wabaId: '1111',
      phoneNumberId: '2222',
      businessId: '3333',
    }
    expect(parseEmbeddedSignupMessage(FB_ORIGIN, JSON.stringify(finish))).toEqual(expected)
    expect(parseEmbeddedSignupMessage(FB_ORIGIN, finish)).toEqual(expected)
  })

  it('reads numeric ids and the other finish types', () => {
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        data: { waba_id: 1111, phone_number_id: 2222 },
      }),
    ).toEqual({
      kind: 'finish',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      wabaId: '1111',
      phoneNumberId: '2222',
      businessId: undefined,
    })
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'FINISH_ONLY_WABA',
        data: { waba_id: '1111' },
      }),
    ).toMatchObject({ kind: 'finish', event: 'FINISH_ONLY_WABA', phoneNumberId: undefined })
  })

  it('a finish without a WABA is not usable', () => {
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '' } }),
    ).toBeNull()
  })

  it('reads a cancel with its step, and one with no data', () => {
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'CANCEL',
        data: { current_step: 'PHONE_NUMBER_SETUP' },
      }),
    ).toEqual({ kind: 'cancel', currentStep: 'PHONE_NUMBER_SETUP' })
    expect(parseEmbeddedSignupMessage(FB_ORIGIN, { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL' })).toEqual({
      kind: 'cancel',
      currentStep: undefined,
    })
  })

  it('a customer-reported error (CANCEL with an error code) and ERROR are errors', () => {
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'CANCEL',
        data: { error_message: 'boom', error_code: 524126, session_id: 'S1', timestamp: 1 },
      }),
    ).toEqual({ kind: 'error', errorCode: '524126', errorMessage: 'boom', sessionId: 'S1' })
    expect(
      parseEmbeddedSignupMessage(FB_ORIGIN, { type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: {} }),
    ).toEqual({ kind: 'error', errorCode: undefined, errorMessage: undefined, sessionId: undefined })
  })

  it.each([
    ['another origin', 'https://evil.example', finish],
    ['bad JSON', FB_ORIGIN, '{oops'],
    ['a number', FB_ORIGIN, 42],
    ['null', FB_ORIGIN, null],
    ['another type', FB_ORIGIN, { ...finish, type: 'OTHER' }],
    ['no event', FB_ORIGIN, { type: 'WA_EMBEDDED_SIGNUP' }],
    ['an unknown event', FB_ORIGIN, { type: 'WA_EMBEDDED_SIGNUP', event: 'SOMETHING' }],
  ])('ignores %s', (_l, origin, raw) => {
    expect(parseEmbeddedSignupMessage(origin, raw)).toBeNull()
  })
})

describe('createSignupSession', () => {
  const FINISH = { kind: 'finish' as const, event: 'FINISH' as const, wabaId: '1', phoneNumberId: '2' }

  function session() {
    const ready = vi.fn()
    const stopped = vi.fn()
    return { s: createSignupSession({ ready, stopped }), ready, stopped }
  }

  it('fires ready once when the message comes before the code', () => {
    const { s, ready, stopped } = session()
    s.onMessage(FINISH)
    expect(ready).not.toHaveBeenCalled()
    s.onLogin('the-code')
    s.onLogin('again')
    s.onMessage(FINISH)
    expect(ready).toHaveBeenCalledTimes(1)
    expect(ready).toHaveBeenCalledWith({ code: 'the-code', finish: FINISH })
    expect(stopped).not.toHaveBeenCalled()
  })

  it('fires ready when the code comes first', () => {
    const { s, ready } = session()
    s.onLogin('the-code')
    s.onMessage(FINISH)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('a cancel message wins over the empty login callback that follows it', () => {
    const { s, ready, stopped } = session()
    s.onMessage({ kind: 'cancel', currentStep: 'X' })
    s.onLogin(null)
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(stopped).toHaveBeenCalledWith({ kind: 'cancel', currentStep: 'X' })
    expect(ready).not.toHaveBeenCalled()
  })

  it('a login without code and no message stops as no_code', () => {
    const { s, stopped } = session()
    s.onLogin(undefined)
    s.onMessage({ kind: 'error', errorCode: '1' })
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(stopped).toHaveBeenCalledWith({ kind: 'no_code' })
  })
})

describe('loadFacebookSdk', () => {
  afterEach(() => {
    resetFacebookSdkForTests()
    delete window.FB
    delete window.fbAsyncInit
    document.body.innerHTML = ''
  })

  it('injects the SDK once and initialises it with our app and version', async () => {
    const init = vi.fn()
    const p1 = loadFacebookSdk('app1', 'v25.0')
    const p2 = loadFacebookSdk('app1', 'v25.0')
    expect(p1).toBe(p2)
    const scripts = document.querySelectorAll('script')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!.src).toBe(FACEBOOK_SDK_URL)
    expect(scripts[0]!.async).toBe(true)
    expect(scripts[0]!.crossOrigin).toBe('anonymous')
    window.FB = { init, login: vi.fn() }
    window.fbAsyncInit!()
    await expect(p1).resolves.toBe(window.FB)
    expect(init).toHaveBeenCalledWith({ appId: 'app1', autoLogAppEvents: true, xfbml: true, version: 'v25.0' })
  })

  it('reuses an SDK that is already on the page', async () => {
    const init = vi.fn()
    window.FB = { init, login: vi.fn() }
    await expect(loadFacebookSdk('app1', 'v25.0')).resolves.toBe(window.FB)
    expect(document.querySelectorAll('script')).toHaveLength(0)
    expect(init).toHaveBeenCalledTimes(1)
  })

  it('rejects when the script cannot load, and lets a later call try again', async () => {
    const p = loadFacebookSdk('app1', 'v25.0')
    document.querySelector('script')!.onerror!(new Event('error'))
    await expect(p).rejects.toThrow('facebook sdk failed to load')
    expect(loadFacebookSdk('app1', 'v25.0')).not.toBe(p)
  })
})

describe('embeddedSignupLoginOptions', () => {
  it('asks for a code with the v4 configuration and empty extras', () => {
    expect(embeddedSignupLoginOptions('cfg1')).toEqual({
      config_id: 'cfg1',
      response_type: 'code',
      override_default_response_type: true,
      extras: {},
    })
  })
})
