import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal HS256 JWT signer/verifier for visitor sessions.
 * Avoids pulling in jsonwebtoken or @nestjs/jwt for a single use case.
 */
export type VisitorJwtPayload = {
  conversationId: string
  contactId: string
  inboxId: string
  iat: number
  exp: number
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function b64urlDecode(input: string): Buffer {
  const padded = input + '==='.slice(0, (4 - (input.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign(input: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(input).digest())
}

export function signVisitorJwt(
  payload: Omit<VisitorJwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 24 * 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000)
  const full: VisitorJwtPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  }
  const header = b64url(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const body = b64url(Buffer.from(JSON.stringify(full)))
  const data = `${header}.${body}`
  const sig = sign(data, secret)
  return `${data}.${sig}`
}

export function verifyVisitorJwt(
  token: string,
  secret: string,
): VisitorJwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts as [string, string, string]
  const expected = sign(`${header}.${body}`, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null
  try {
    const decoded = JSON.parse(b64urlDecode(body).toString('utf8')) as VisitorJwtPayload
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null
    return decoded
  } catch {
    return null
  }
}
