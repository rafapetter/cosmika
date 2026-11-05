/**
 * The handful of Graph API calls Embedded Signup makes, in one place so the
 * error handling is shared and no caller ever logs a URL (the token exchange
 * carries the app secret in its query string, as Meta specifies).
 */

/** Per-call ceiling. The code exchange has to finish inside Meta's 30 s TTL. */
export const GRAPH_TIMEOUT_MS = 10_000

export type GraphError = {
  /** HTTP status, or 0 when the request never got an answer. */
  status: number
  code: number | null
  subcode: number | null
  fbtraceId: string | null
  /** Meta's own message. Never contains our token; safe to log. */
  message: string
}

export type GraphResult<T> = { ok: true; data: T } | { ok: false; error: GraphError }

type GraphErrorBody = {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    fbtrace_id?: string
  }
}

export async function graphCall<T>(
  base: string,
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE'
    token?: string
    query?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
): Promise<GraphResult<T>> {
  const url = new URL(`${base}/${path.replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    })
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 0,
        code: null,
        subcode: null,
        fbtraceId: null,
        message: err instanceof Error ? err.name : 'network error',
      },
    }
  }
  const json = (await res.json().catch(() => ({}))) as unknown
  if (!res.ok) {
    const e = (json as GraphErrorBody).error ?? {}
    return {
      ok: false,
      error: {
        status: res.status,
        code: e.code ?? null,
        subcode: e.error_subcode ?? null,
        fbtraceId: e.fbtrace_id ?? null,
        message: e.message ?? `HTTP ${res.status}`,
      },
    }
  }
  return { ok: true, data: json as T }
}

/** One line for the log: Meta's code, subcode and trace id, never a token. */
export function describeGraphError(e: GraphError): string {
  return `status=${e.status} code=${e.code ?? '-'} subcode=${e.subcode ?? '-'} fbtrace_id=${e.fbtraceId ?? '-'} message=${e.message}`
}
