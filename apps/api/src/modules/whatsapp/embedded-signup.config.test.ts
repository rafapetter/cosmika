import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appWebhookSettings,
  DEFAULT_META_GRAPH_API_VERSION,
  embeddedSignupAccountAllowed,
  embeddedSignupFlagOn,
  embeddedSignupSettings,
} from './embedded-signup.config'

const FULL = {
  WHATSAPP_EMBEDDED_SIGNUP_ENABLED: '1',
  META_APP_ID: ' 100000000000001 ',
  META_APP_SECRET: 'secret',
  META_ES_CONFIG_ID: '999',
  API_PUBLIC_URL: 'https://app.cosmobots.io/api//',
}

function env(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v)
}

afterEach(() => vi.unstubAllEnvs())

describe('embedded signup settings', () => {
  it('is off by default', () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', undefined as unknown as string)
    expect(embeddedSignupFlagOn()).toBe(false)
    expect(embeddedSignupSettings()).toBeNull()
  })

  it.each(['1', 'true', 'TRUE', ' true '])('flag %j turns it on', (flag) => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', flag)
    expect(embeddedSignupFlagOn()).toBe(true)
  })

  it.each(['0', 'false', 'yes', ''])('flag %j keeps it off', (flag) => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', flag)
    expect(embeddedSignupFlagOn()).toBe(false)
  })

  it('reads and normalises every value', () => {
    env(FULL)
    vi.stubEnv('META_GRAPH_API_VERSION', '')
    vi.stubEnv('META_GRAPH_BASE_URL', '')
    expect(embeddedSignupSettings()).toEqual({
      appId: '100000000000001',
      appSecret: 'secret',
      configId: '999',
      graphApiVersion: DEFAULT_META_GRAPH_API_VERSION,
      graphBase: `https://graph.facebook.com/${DEFAULT_META_GRAPH_API_VERSION}`,
      publicApiUrl: 'https://app.cosmobots.io/api',
    })
  })

  it('honours a pinned Graph version and base', () => {
    env({ ...FULL, META_GRAPH_API_VERSION: 'v26.0', META_GRAPH_BASE_URL: 'http://graph.local/' })
    expect(embeddedSignupSettings()).toMatchObject({
      graphApiVersion: 'v26.0',
      graphBase: 'http://graph.local/v26.0',
    })
  })

  it.each(['META_APP_ID', 'META_APP_SECRET', 'META_ES_CONFIG_ID', 'API_PUBLIC_URL'])(
    'flag on but %s missing is still off',
    (missing) => {
      env({ ...FULL, [missing]: '  ' })
      expect(embeddedSignupSettings()).toBeNull()
    },
  )

})

describe('embeddedSignupAccountAllowed', () => {
  it('nobody when the list is unset or blank', () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', undefined as unknown as string)
    expect(embeddedSignupAccountAllowed('acc1')).toBe(false)
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', ' , ')
    expect(embeddedSignupAccountAllowed('acc1')).toBe(false)
  })

  it('only the listed accounts, spaces ignored', () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', ' acc1 ,acc2')
    expect(embeddedSignupAccountAllowed('acc1')).toBe(true)
    expect(embeddedSignupAccountAllowed('acc2')).toBe(true)
    expect(embeddedSignupAccountAllowed('acc3')).toBe(false)
    expect(embeddedSignupAccountAllowed('')).toBe(false)
  })

  it('"*" opens it to every account', () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS', '*')
    expect(embeddedSignupAccountAllowed('anything')).toBe(true)
  })
})

describe('appWebhookSettings', () => {
  it('needs the app secret and the verify token, not the signup flag', () => {
    vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', '0')
    vi.stubEnv('META_APP_SECRET', ' secret ')
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', ' tok ')
    expect(appWebhookSettings()).toEqual({ appSecret: 'secret', verifyToken: 'tok' })
  })

  it.each(['META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'])('off without %s', (missing) => {
    vi.stubEnv('META_APP_SECRET', 'secret')
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'tok')
    vi.stubEnv(missing, '')
    expect(appWebhookSettings()).toBeNull()
  })
})
