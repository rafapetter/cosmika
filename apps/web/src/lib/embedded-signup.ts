/**
 * Browser side of WhatsApp Embedded Signup (v4).
 *
 * Meta's popup reports back in two separate channels, in no fixed order:
 *  - FB.login's callback carries the exchangeable `code` (valid 30 seconds);
 *  - a window `message` event of type WA_EMBEDDED_SIGNUP carries the WABA,
 *    phone number and business ids, or the reason the customer stopped.
 * `createSignupSession` collects both and hands them over exactly once, the
 * moment the pair is complete, so the server gets the code while it is alive.
 */

export const FACEBOOK_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js'

export type EmbeddedSignupFinishEvent =
  | 'FINISH'
  | 'FINISH_ONLY_WABA'
  | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'

export type EmbeddedSignupMessage =
  | {
      kind: 'finish'
      event: EmbeddedSignupFinishEvent
      wabaId: string
      phoneNumberId?: string
      businessId?: string
    }
  | { kind: 'cancel'; currentStep?: string }
  | { kind: 'error'; errorCode?: string; errorMessage?: string; sessionId?: string }

const FINISH_EVENTS = new Set<string>([
  'FINISH',
  'FINISH_ONLY_WABA',
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
])

/**
 * Only facebook.com and its subdomains, over https. Meta's sample checks
 * `endsWith('facebook.com')`, which would also accept "evilfacebook.com".
 */
export function isFacebookOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))
    )
  } catch {
    return false
  }
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v
  if (typeof v === 'number') return String(v)
  return undefined
}

/** A WA_EMBEDDED_SIGNUP message from Meta, or null for anything else. */
export function parseEmbeddedSignupMessage(
  origin: string,
  raw: unknown,
): EmbeddedSignupMessage | null {
  if (!isFacebookOrigin(origin)) return null
  let msg: unknown = raw
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { type?: unknown; event?: unknown; data?: unknown }
  if (m.type !== 'WA_EMBEDDED_SIGNUP' || typeof m.event !== 'string') return null
  const data = (m.data && typeof m.data === 'object' ? m.data : {}) as Record<string, unknown>

  if (FINISH_EVENTS.has(m.event)) {
    const wabaId = str(data.waba_id)
    if (!wabaId) return null
    return {
      kind: 'finish',
      event: m.event as EmbeddedSignupFinishEvent,
      wabaId,
      phoneNumberId: str(data.phone_number_id),
      businessId: str(data.business_id),
    }
  }
  // A customer who reports a problem from inside the flow also arrives as
  // CANCEL, but with an error code and session id instead of a step.
  if (m.event === 'ERROR' || (m.event === 'CANCEL' && data.error_code !== undefined)) {
    return {
      kind: 'error',
      errorCode: str(data.error_code),
      errorMessage: str(data.error_message),
      sessionId: str(data.session_id),
    }
  }
  if (m.event === 'CANCEL') return { kind: 'cancel', currentStep: str(data.current_step) }
  return null
}

export type SignupReady = {
  code: string
  finish: Extract<EmbeddedSignupMessage, { kind: 'finish' }>
}

/**
 * Pairs the login code with the finish message. `ready` fires once, with both;
 * `stopped` fires once if the customer cancelled or Meta reported an error.
 * Whatever arrives after either is ignored.
 */
export function createSignupSession(handlers: {
  ready: (r: SignupReady) => void
  stopped: (m: Exclude<EmbeddedSignupMessage, { kind: 'finish' }> | { kind: 'no_code' }) => void
}) {
  let code: string | null = null
  let finish: SignupReady['finish'] | null = null
  let done = false

  const settle = () => {
    if (done || !code || !finish) return
    done = true
    handlers.ready({ code, finish })
  }

  return {
    /** FB.login's callback. No code means the popup was closed or refused. */
    onLogin(authCode: string | null | undefined) {
      if (done) return
      if (authCode) {
        code = authCode
        settle()
        return
      }
      // The CANCEL message usually arrives just before the callback; if it
      // did, it has already settled the session with a better reason.
      done = true
      handlers.stopped({ kind: 'no_code' })
    },
    onMessage(msg: EmbeddedSignupMessage) {
      if (done) return
      if (msg.kind === 'finish') {
        finish = msg
        settle()
        return
      }
      done = true
      handlers.stopped(msg)
    },
  }
}

// ─── Facebook JS SDK ─────────────────────────────────────────────────

export type FacebookSdk = {
  init(opts: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void
  login(
    cb: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    opts: Record<string, unknown>,
  ): void
}

declare global {
  interface Window {
    FB?: FacebookSdk
    fbAsyncInit?: () => void
  }
}

let sdkPromise: Promise<FacebookSdk> | null = null

/** Loads the SDK once per page and initialises it with our app. */
export function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    const init = () => {
      const FB = window.FB!
      FB.init({ appId, autoLogAppEvents: true, xfbml: true, version })
      resolve(FB)
    }
    if (window.FB) {
      init()
      return
    }
    window.fbAsyncInit = init
    const script = document.createElement('script')
    script.src = FACEBOOK_SDK_URL
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => {
      sdkPromise = null
      reject(new Error('facebook sdk failed to load'))
    }
    document.body.appendChild(script)
  })
  return sdkPromise
}

/** For tests: forget the cached SDK promise. */
export function resetFacebookSdkForTests(): void {
  sdkPromise = null
}

/** The FB.login options Embedded Signup v4 expects. */
export function embeddedSignupLoginOptions(configId: string): Record<string, unknown> {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    // v4 takes its products and features from the Login for Business
    // configuration; Meta's v4 reference leaves extras empty on purpose.
    extras: {},
  }
}
