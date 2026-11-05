import { DEFAULT_META_GRAPH_API_VERSION } from '../whatsapp/embedded-signup.config'

/**
 * Settings for Messenger and Instagram Direct, read on every call so a test
 * or a recreated container never meets a stale value.
 *
 * Both ride on the same Meta app as WhatsApp Embedded Signup (META_APP_ID /
 * META_APP_SECRET). Meta keeps ONE callback URL per app and object (page,
 * instagram), so while another system still owns pages on this app, the
 * META_RELAY_* URLs receive, untouched and with their signature, every event
 * for a page or account that is not a Cosmika inbox.
 */
function value(name: string): string | null {
  const raw = process.env[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export type MetaMessagingSettings = {
  appSecret: string
  verifyToken: string | null
  graphBase: string
  relay: { page: string | null; instagram: string | null }
}

/** Null when the app secret is missing: then no Meta event can be trusted. */
export function metaMessagingSettings(): MetaMessagingSettings | null {
  const appSecret = value('META_APP_SECRET')
  if (!appSecret) return null
  const version = value('META_GRAPH_API_VERSION') ?? DEFAULT_META_GRAPH_API_VERSION
  const root = (value('META_GRAPH_BASE_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')
  return {
    appSecret,
    verifyToken: value('META_WEBHOOK_VERIFY_TOKEN'),
    graphBase: `${root}/${version}`,
    relay: {
      page: value('META_RELAY_PAGE_URL'),
      instagram: value('META_RELAY_INSTAGRAM_URL'),
    },
  }
}

/** The Graph base for sends, even when the webhook side is not configured. */
export function metaGraphBase(): string {
  const version = value('META_GRAPH_API_VERSION') ?? DEFAULT_META_GRAPH_API_VERSION
  const root = (value('META_GRAPH_BASE_URL') ?? 'https://graph.facebook.com').replace(/\/+$/, '')
  return `${root}/${version}`
}
