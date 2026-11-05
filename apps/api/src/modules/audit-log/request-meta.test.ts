import { describe, expect, it } from 'vitest'

import { requestMeta } from './request-meta'

describe('requestMeta', () => {
  it('uses req.ip and ignores a raw x-forwarded-for (Fastify already resolved trusted hops)', () => {
    expect(
      requestMeta({
        ip: '200.1.2.3',
        headers: { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'UA' },
      }),
    ).toEqual({ ip: '200.1.2.3', userAgent: 'UA' })
  })

  it('tolerates missing headers', () => {
    expect(requestMeta({ ip: '127.0.0.1' })).toEqual({ ip: '127.0.0.1', userAgent: null })
  })

  it('caps a huge user agent', () => {
    const out = requestMeta({ headers: { 'user-agent': 'x'.repeat(1000) } })
    expect(out.userAgent).toHaveLength(300)
    expect(out.ip).toBeNull()
  })
})
