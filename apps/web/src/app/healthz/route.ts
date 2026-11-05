// Liveness probe for the web container. Lives at /healthz, NOT under /api:
// installs that put the API behind a same-origin proxy route /api/* to the
// API container, which would shadow anything the web app served there.
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return Response.json({ ok: true, service: 'web' }, { headers: { 'cache-control': 'no-store' } })
}
