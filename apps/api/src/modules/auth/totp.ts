import { createHmac, randomBytes } from 'node:crypto'

/**
 * Tiny TOTP implementation (RFC 6238, SHA-1, 30s step, 6 digits). Self-
 * contained — no external library — because we only need verify + secret
 * generation and the spec is short.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Encode arbitrary bytes as Base32 (RFC 4648, no padding). Exposed (not just
 * inlined into generateTotpSecret) so the leftover-bits tail can be unit-
 * tested directly with input lengths that exercise it — 20 bytes (the secret
 * size) divides evenly into 5-bit groups, so without a dedicated test the
 * tail branch is unreachable.
 */
export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

/** Generate a 20-byte secret encoded as Base32 (RFC 4648). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** RFC 6238 HOTP/TOTP code for the given time step. */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', secret).update(buf).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!
  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * Verify a 6-digit code against a Base32-encoded secret. Allows ±1 step (90s
 * window total) for clock skew.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: number = Date.now(),
): boolean {
  if (!/^[0-9]{6}$/.test(code)) return false
  const key = base32Decode(secret)
  if (key.length === 0) return false
  const step = Math.floor(now / 1000 / 30)
  for (const drift of [-1, 0, 1]) {
    if (hotp(key, step + drift) === code) return true
  }
  return false
}

export function otpauthUrl(opts: {
  secret: string
  issuer: string
  account: string
}): string {
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  })
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * Generate N recovery codes (10 chars, alphanum). Caller is responsible for
 * hashing them before storage; this helper just produces the plaintexts.
 *
 * We over-generate bytes and keep trying base64url until we have at least
 * 10 alphanumeric chars after stripping `-`/`_`. This avoids the
 * short-code bug from naive `randomBytes(8).toString('base64url').replace(...)
 * .slice(0, 10)`: that produces 9 chars whenever the base64url happens to
 * contain a `-` or `_`, which is ~5% of codes.
 */
export function generateRecoveryCodes(n = 10): string[] {
  const out: string[] = []
  for (let i = 0; i < n; i += 1) {
    let raw = ''
    while (raw.length < 10) {
      raw += randomBytes(12).toString('base64url').replace(/[-_]/g, '')
    }
    raw = raw.slice(0, 10).toUpperCase()
    out.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`)
  }
  return out
}
