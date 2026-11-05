/**
 * Who-and-where context for security events (login, logout). `req.ip` is
 * already the client: Fastify resolves it from `X-Forwarded-For` only when
 * the hop is a trusted proxy (loopback or the Docker gateway, see
 * common/trust-proxy.ts). Reading the header here directly let anyone who
 * reached the API write any address they liked into the audit log.
 */
export function requestMeta(req: {
  ip?: string
  headers?: Record<string, string | string[] | undefined>
}): { ip: string | null; userAgent: string | null } {
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v) ?? null
  const userAgent = first(req.headers?.['user-agent'])?.slice(0, 300) ?? null
  return { ip: req.ip || null, userAgent }
}
