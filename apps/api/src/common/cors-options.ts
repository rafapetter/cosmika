/**
 * Per-request CORS for @fastify/cors.
 *
 * The console API only answers our own web app (CORS_ORIGIN, with cookies).
 * The public widget routes are different: the chat box runs on the
 * customer's website, so any origin may call them, without credentials (the
 * visitor token travels in the body). Which sites may embed a given widget is
 * still enforced per inbox by WidgetService against its configured
 * websiteUrl; CORS only has to stop blocking the browser from asking.
 */
export type CorsDecision = { origin: boolean | string[]; credentials: boolean }

export function corsOptionsFor(url: string | undefined, allowList: string[]): CorsDecision {
  if (url?.startsWith('/widget/')) return { origin: true, credentials: false }
  return { origin: allowList, credentials: true }
}

export function corsAllowList(raw: string | undefined): string[] {
  return (raw ?? 'http://localhost:3100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
