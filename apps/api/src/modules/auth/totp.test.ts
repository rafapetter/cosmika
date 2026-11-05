import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from './totp'

// ---------- helpers ----------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

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

/** Generate a valid TOTP code for the given secret at the given time. */
function codeForSecretAtTime(secret: string, atMs: number): string {
  const key = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', key).update(buf).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!
  return String(truncated % 1_000_000).padStart(6, '0')
}

// ---------- base32Encode ----------

describe('base32Encode', () => {
  it('encodes a 20-byte buffer to exactly 32 chars (no leftover bits)', () => {
    const result = base32Encode(Buffer.alloc(20, 0))
    expect(result).toHaveLength(32)
    expect(result).toBe('A'.repeat(32))
  })

  it('encodes a 5-byte buffer to exactly 8 chars (clean 40-bit group)', () => {
    // 5 bytes = 40 bits = 8 base32 chars, no remainder.
    expect(base32Encode(Buffer.from([0, 0, 0, 0, 0]))).toBe('AAAAAAAA')
  })

  it('encodes a 1-byte buffer with leftover bits (exercises the tail branch)', () => {
    // 1 byte = 8 bits = 1 full 5-bit group + 3 leftover bits, so the
    // `if (bits > 0)` tail must run.
    expect(base32Encode(Buffer.from([0]))).toBe('AA') // 0b00000 + leftover 0b000
    expect(base32Encode(Buffer.from([0xff]))).toBe('74') // top 5 bits = 0b11111 = '7', leftover 0b11100 = '4' (using shift fix-up)
  })

  it('encodes a 2-byte buffer (4 chars: 16 bits → 3 full + 1 leftover)', () => {
    // 2 bytes = 16 bits = 3 full 5-bit groups + 1 leftover bit
    expect(base32Encode(Buffer.from([0, 0]))).toBe('AAAA')
  })

  it('round-trips a known RFC 4648 test vector ("foobar")', () => {
    // RFC 4648 § 10: base32("foobar") = "MZXW6YTBOI======". Without
    // padding our impl emits "MZXW6YTBOI".
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('emits an empty string for an empty buffer', () => {
    expect(base32Encode(Buffer.alloc(0))).toBe('')
  })
})

// ---------- generateTotpSecret ----------

describe('generateTotpSecret', () => {
  it('returns a 32-char Base32 string', () => {
    const s = generateTotpSecret()
    // 20 bytes = 160 bits → 32 Base32 chars (no padding needed)
    expect(s).toHaveLength(32)
    expect(s).toMatch(/^[A-Z2-7]+$/)
  })

  it('returns a different value on each call (statistically certain)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i += 1) seen.add(generateTotpSecret())
    expect(seen.size).toBe(20)
  })
})

// ---------- verifyTotp ----------

describe('verifyTotp', () => {
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' // "Hello!" repeated, valid Base32
  const FIXED_TIME = 1_700_000_000_000 // arbitrary anchor

  it('accepts a valid code at the current step', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME)
    expect(verifyTotp(SECRET, code, FIXED_TIME)).toBe(true)
  })

  it('accepts a code from the previous 30s step (−1 drift)', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME - 30_000)
    expect(verifyTotp(SECRET, code, FIXED_TIME)).toBe(true)
  })

  it('accepts a code from the next 30s step (+1 drift)', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME + 30_000)
    expect(verifyTotp(SECRET, code, FIXED_TIME)).toBe(true)
  })

  it('rejects a code from 60s ago (−2 drift, outside window)', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME - 60_000)
    expect(verifyTotp(SECRET, code, FIXED_TIME)).toBe(false)
  })

  it('rejects a code from 60s ahead (+2 drift, outside window)', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME + 60_000)
    expect(verifyTotp(SECRET, code, FIXED_TIME)).toBe(false)
  })

  it('rejects a malformed code (too short)', () => {
    expect(verifyTotp(SECRET, '12345', FIXED_TIME)).toBe(false)
  })

  it('rejects a malformed code (too long)', () => {
    expect(verifyTotp(SECRET, '1234567', FIXED_TIME)).toBe(false)
  })

  it('rejects a code with non-digit characters', () => {
    expect(verifyTotp(SECRET, '12345A', FIXED_TIME)).toBe(false)
  })

  it('rejects an empty code', () => {
    expect(verifyTotp(SECRET, '', FIXED_TIME)).toBe(false)
  })

  it('rejects when the secret decodes to zero bytes (only padding/whitespace)', () => {
    expect(verifyTotp('====', '123456', FIXED_TIME)).toBe(false)
    expect(verifyTotp('   ', '123456', FIXED_TIME)).toBe(false)
  })

  it('uses Date.now() when called without an explicit time', () => {
    const code = codeForSecretAtTime(SECRET, Date.now())
    expect(verifyTotp(SECRET, code)).toBe(true)
  })

  it('rejects a totally wrong code', () => {
    expect(verifyTotp(SECRET, '000000', FIXED_TIME)).toBe(false)
  })

  it('handles a Base32 string with lowercase letters (case-insensitive decode)', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME)
    expect(verifyTotp(SECRET.toLowerCase(), code, FIXED_TIME)).toBe(true)
  })

  it('handles a Base32 string with whitespace (Google Authenticator-style)', () => {
    const padded = SECRET.match(/.{1,4}/g)!.join(' ')
    const code = codeForSecretAtTime(SECRET, FIXED_TIME)
    expect(verifyTotp(padded, code, FIXED_TIME)).toBe(true)
  })

  it('ignores invalid Base32 characters in the secret rather than throwing', () => {
    // base32Decode skips chars not in the alphabet (`!` and `?` here)
    const code = codeForSecretAtTime(SECRET, FIXED_TIME)
    expect(verifyTotp('!' + SECRET + '?', code, FIXED_TIME)).toBe(true)
  })

  it('handles a Base32 string with trailing padding', () => {
    const code = codeForSecretAtTime(SECRET, FIXED_TIME)
    expect(verifyTotp(SECRET + '====', code, FIXED_TIME)).toBe(true)
  })
})

// ---------- otpauthUrl ----------

describe('otpauthUrl', () => {
  it('builds a valid otpauth:// URL with all required params', () => {
    const url = otpauthUrl({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'Cosmika',
      account: 'marina@example.com',
    })
    expect(url).toBe(
      'otpauth://totp/Cosmika:marina%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Cosmika&algorithm=SHA1&digits=6&period=30',
    )
  })

  it('percent-encodes issuer + account in the label', () => {
    const url = otpauthUrl({
      secret: 'ABC',
      issuer: 'My Co',
      account: 'a/b@c',
    })
    expect(url).toContain('My%20Co:a%2Fb%40c')
  })

  it('handles unicode in the account name', () => {
    const url = otpauthUrl({
      secret: 'ABC',
      issuer: 'X',
      account: 'usuário@ração.com',
    })
    expect(url).toContain('usu%C3%A1rio')
    expect(url).toContain('ra%C3%A7%C3%A3o')
  })
})

// ---------- generateRecoveryCodes ----------

describe('generateRecoveryCodes', () => {
  it('generates 10 codes by default', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
  })

  it('generates N codes when requested', () => {
    expect(generateRecoveryCodes(1)).toHaveLength(1)
    expect(generateRecoveryCodes(5)).toHaveLength(5)
    expect(generateRecoveryCodes(25)).toHaveLength(25)
  })

  it('generates 0 codes when n=0', () => {
    expect(generateRecoveryCodes(0)).toEqual([])
  })

  it('formats every code as XXXXX-XXXXX (uppercase alphanum)', () => {
    for (const code of generateRecoveryCodes(50)) {
      expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/)
    }
  })

  it('generates unique codes within a batch (statistically certain)', () => {
    const codes = generateRecoveryCodes(50)
    expect(new Set(codes).size).toBe(50)
  })
})
