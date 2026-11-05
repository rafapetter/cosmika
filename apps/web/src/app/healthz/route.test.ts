import { describe, expect, it } from 'vitest'

import { GET, dynamic } from './route'

describe('GET /healthz', () => {
  it('reports the web service as up, uncached', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    await expect(res.json()).resolves.toEqual({ ok: true, service: 'web' })
  })
  it('is never statically rendered', () => {
    expect(dynamic).toBe('force-dynamic')
  })
})
