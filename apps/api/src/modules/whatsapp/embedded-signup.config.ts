/**
 * Settings for WhatsApp Embedded Signup, read from the environment on every
 * call so a test (or an operator flipping the flag and recreating the
 * container) never meets a stale value.
 *
 * The feature is OFF unless WHATSAPP_EMBEDDED_SIGNUP_ENABLED is "1" or "true"
 * AND every Meta value it needs is present. Half a configuration is treated as
 * off, so the button never appears for a flow that would fail at the last
 * step with the customer's 30-second code already spent.
 */

/** Graph API version used by the SDK on the page and by our server calls. */
export const DEFAULT_META_GRAPH_API_VERSION = 'v25.0'

export type EmbeddedSignupSettings = {
  appId: string
  appSecret: string
  configId: string
  graphApiVersion: string
  /** `https://graph.facebook.com/<version>`, no trailing slash. */
  graphBase: string
  /** Public base of this API, as Meta must call it. No trailing slash. */
  publicApiUrl: string
}

function value(name: string): string | null {
  const raw = process.env[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export function embeddedSignupFlagOn(): boolean {
  const flag = value('WHATSAPP_EMBEDDED_SIGNUP_ENABLED')?.toLowerCase()
  return flag === '1' || flag === 'true'
}

/** The full settings, or null when the feature is off or incomplete. */
export function embeddedSignupSettings(): EmbeddedSignupSettings | null {
  if (!embeddedSignupFlagOn()) return null
  const appId = value('META_APP_ID')
  const appSecret = value('META_APP_SECRET')
  const configId = value('META_ES_CONFIG_ID')
  const publicApiUrl = value('API_PUBLIC_URL')
  if (!appId || !appSecret || !configId || !publicApiUrl) return null
  const graphApiVersion =
    value('META_GRAPH_API_VERSION') ?? DEFAULT_META_GRAPH_API_VERSION
  const graphRoot = (value('META_GRAPH_BASE_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')
  return {
    appId,
    appSecret,
    configId,
    graphApiVersion,
    graphBase: `${graphRoot}/${graphApiVersion}`,
    publicApiUrl: publicApiUrl.replace(/\/+$/, ''),
  }
}

/**
 * Which accounts see the "Conectar WhatsApp" button and may complete a signup,
 * from WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS: account ids separated by commas,
 * or "*" for every account. Unset or blank means no account, so turning the
 * flag on alone exposes nothing.
 */
export function embeddedSignupAccountAllowed(accountId: string): boolean {
  const ids = (value('WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.includes('*') || ids.includes(accountId)
}

export type AppWebhookSettings = {
  appSecret: string
  /** What Meta echoes back when it verifies the callback. */
  verifyToken: string
}

/**
 * Our app-level callback (App Dashboard > WhatsApp > Configuration). Active
 * whenever the app secret and its verify token are set, independent of the
 * Embedded Signup flag and allowlist: Meta verifies the URL once, and keeps
 * delivering account and template events for every WABA that is subscribed
 * to the app, whoever onboarded it.
 */
export function appWebhookSettings(): AppWebhookSettings | null {
  const appSecret = value('META_APP_SECRET')
  const verifyToken = value('META_WEBHOOK_VERIFY_TOKEN')
  if (!appSecret || !verifyToken) return null
  return { appSecret, verifyToken }
}
