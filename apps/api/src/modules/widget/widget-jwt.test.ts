import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { signVisitorJwt, verifyVisitorJwt } from './widget-jwt'

// Same helpers as the impl, kept as local copies so the tests don't depend
// on internal exports.
function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const SECRET = 'super-secret-key-for-tests-only-do-not-use-in-prod'

const FIXED_PAYLOAD = {
  conversationId: 'cmpcv-abc-123',
  contactId: 'cmpct-def-456',
  inboxId: 'cmpib-ghi-789',
}

describe('signVisitorJwt', () => {
  it('returns a 3-part JWT (header.body.signature)', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    expect(token.split('.')).toHaveLength(3)
  })

  it('uses HS256 in the header', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [header] = token.split('.') as [string]
    const decoded = JSON.parse(
      Buffer.from(header, 'base64').toString('utf8'),
    ) as { alg: string; typ: string }
    expect(decoded.alg).toBe('HS256')
    expect(decoded.typ).toBe('JWT')
  })

  it('sets iat near Date.now() and exp = iat + ttlSeconds', () => {
    const before = Math.floor(Date.now() / 1000)
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET, 3600)
    const after = Math.floor(Date.now() / 1000)
    const [, body] = token.split('.') as [string, string]
    const decoded = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    ) as { iat: number; exp: number }
    expect(decoded.iat).toBeGreaterThanOrEqual(before)
    expect(decoded.iat).toBeLessThanOrEqual(after)
    expect(decoded.exp).toBe(decoded.iat + 3600)
  })

  it('defaults ttl to 24h when not specified', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [, body] = token.split('.') as [string, string]
    const decoded = JSON.parse(
      Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    ) as { iat: number; exp: number }
    expect(decoded.exp - decoded.iat).toBe(24 * 60 * 60)
  })

  it('produces a signature that matches HMAC-SHA256 of header.body', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [header, body, sig] = token.split('.') as [string, string, string]
    const expected = b64url(
      createHmac('sha256', SECRET).update(`${header}.${body}`).digest(),
    )
    expect(sig).toBe(expected)
  })

  it('produces different signatures for different secrets', () => {
    const t1 = signVisitorJwt(FIXED_PAYLOAD, 'secret-a')
    const t2 = signVisitorJwt(FIXED_PAYLOAD, 'secret-b')
    expect(t1).not.toBe(t2)
  })

  it('preserves the payload fields verbatim', () => {
    const payload = {
      conversationId: 'with/special:chars+a==b',
      contactId: 'with spaces',
      inboxId: 'unicode-ção-é',
    }
    const token = signVisitorJwt(payload, SECRET)
    const round = verifyVisitorJwt(token, SECRET)
    expect(round?.conversationId).toBe(payload.conversationId)
    expect(round?.contactId).toBe(payload.contactId)
    expect(round?.inboxId).toBe(payload.inboxId)
  })
})

describe('verifyVisitorJwt', () => {
  it('round-trips a freshly-signed token', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const decoded = verifyVisitorJwt(token, SECRET)
    expect(decoded).not.toBeNull()
    expect(decoded?.conversationId).toBe(FIXED_PAYLOAD.conversationId)
    expect(decoded?.contactId).toBe(FIXED_PAYLOAD.contactId)
    expect(decoded?.inboxId).toBe(FIXED_PAYLOAD.inboxId)
  })

  it('rejects a token with the wrong secret', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    expect(verifyVisitorJwt(token, 'wrong-secret')).toBeNull()
  })

  it('rejects a token with a tampered payload', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [header, , sig] = token.split('.') as [string, string, string]
    const tamperedBody = b64url(
      Buffer.from(
        JSON.stringify({ ...FIXED_PAYLOAD, conversationId: 'EVIL' }),
      ),
    )
    const tampered = `${header}.${tamperedBody}.${sig}`
    expect(verifyVisitorJwt(tampered, SECRET)).toBeNull()
  })

  it('rejects a token with a tampered signature of the same length', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [header, body, sig] = token.split('.') as [string, string, string]
    // flip one char in the sig but keep the same length so the length-
    // check passes and we test the timingSafeEqual branch
    const flipped = sig[0] === 'a' ? 'b' + sig.slice(1) : 'a' + sig.slice(1)
    expect(verifyVisitorJwt(`${header}.${body}.${flipped}`, SECRET)).toBeNull()
  })

  it('rejects a token with too few parts', () => {
    expect(verifyVisitorJwt('only.two', SECRET)).toBeNull()
    expect(verifyVisitorJwt('only-one', SECRET)).toBeNull()
    expect(verifyVisitorJwt('', SECRET)).toBeNull()
  })

  it('rejects a token with too many parts', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    expect(verifyVisitorJwt(token + '.extra', SECRET)).toBeNull()
  })

  it('rejects a token whose signature length differs (guards before timingSafeEqual)', () => {
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET)
    const [header, body] = token.split('.') as [string, string]
    expect(verifyVisitorJwt(`${header}.${body}.short`, SECRET)).toBeNull()
    expect(
      verifyVisitorJwt(`${header}.${body}.this-is-way-too-long-to-match-a-real-sig`, SECRET),
    ).toBeNull()
  })

  it('rejects a token whose body is not valid JSON', () => {
    // Sign a valid header.body where body decodes to non-JSON gibberish.
    const header = b64url(
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    )
    const body = b64url(Buffer.from('not-json-{at-all'))
    const sig = b64url(
      createHmac('sha256', SECRET).update(`${header}.${body}`).digest(),
    )
    expect(verifyVisitorJwt(`${header}.${body}.${sig}`, SECRET)).toBeNull()
  })

  it('rejects an expired token', () => {
    // Sign with a negative ttl so the token is already expired.
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET, -10)
    expect(verifyVisitorJwt(token, SECRET)).toBeNull()
  })

  it('accepts a token whose body has no `exp` field (impl falls through the guard)', () => {
    // Hand-craft a token without `exp` to exercise the `decoded.exp &&` branch.
    const header = b64url(
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    )
    const body = b64url(
      Buffer.from(
        JSON.stringify({
          conversationId: 'c',
          contactId: 'ct',
          inboxId: 'i',
          iat: Math.floor(Date.now() / 1000),
        }),
      ),
    )
    const sig = b64url(
      createHmac('sha256', SECRET).update(`${header}.${body}`).digest(),
    )
    expect(verifyVisitorJwt(`${header}.${body}.${sig}`, SECRET)).not.toBeNull()
  })

  it('accepts a token whose exp is exactly now (>= now passes)', () => {
    // Sign with ttl=1 then verify immediately — the impl uses `< now`, not
    // `<= now`, so a token expiring this very second still verifies.
    const token = signVisitorJwt(FIXED_PAYLOAD, SECRET, 1)
    expect(verifyVisitorJwt(token, SECRET)).not.toBeNull()
  })

  it('handles base64-url body that needs padding to decode', () => {
    // b64urlDecode adds `===` padding for inputs where length%4 != 0.
    // We exercise it indirectly: sign a payload whose body length is not a
    // multiple of 4 once base64-encoded.
    const payload = {
      conversationId: 'a', // tiny so body is short
      contactId: 'b',
      inboxId: 'c',
    }
    const token = signVisitorJwt(payload, SECRET)
    const decoded = verifyVisitorJwt(token, SECRET)
    expect(decoded?.conversationId).toBe('a')
  })
})
