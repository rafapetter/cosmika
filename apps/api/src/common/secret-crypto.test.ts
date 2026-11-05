import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SECRETS_KEY_ENV,
  SecretCryptoError,
  decryptSecret,
  decryptSecretsIn,
  encryptSecret,
  encryptSecretsIn,
  hasEncryptedSecret,
  isEncryptedSecret,
  loadSecretsKey,
  maybeEncryptSecret,
  secretsKeyConfigured,
} from './secret-crypto'

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')
const SECRET_FIELDS = ['accessToken', 'appSecret', 'webhookVerifyToken'] as const

const originalKey = process.env[SECRETS_KEY_ENV]

function withKey(key: string | undefined) {
  if (key === undefined) delete process.env[SECRETS_KEY_ENV]
  else process.env[SECRETS_KEY_ENV] = key
}

beforeEach(() => withKey(KEY_A))
afterEach(() => withKey(originalKey))

describe('loadSecretsKey', () => {
  it('decodes a 32-byte base64 key', () => {
    expect(loadSecretsKey()).toHaveLength(32)
  })

  it('accepts the 44-character value that `openssl rand -base64 32` produces', () => {
    expect(KEY_A).toHaveLength(44)
    withKey(KEY_A)
    expect(loadSecretsKey().toString('base64')).toBe(KEY_A)
  })

  it('ignores surrounding whitespace, which a copy-pasted .env line carries', () => {
    withKey(`  ${KEY_A}\n`)
    expect(loadSecretsKey()).toHaveLength(32)
  })

  it('refuses a missing key, naming the variable', () => {
    withKey(undefined)
    const err = (() => {
      try {
        loadSecretsKey()
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(SecretCryptoError)
    expect((err as Error).message).toContain(SECRETS_KEY_ENV)
  })

  it('treats an empty or whitespace-only value as missing', () => {
    withKey('   ')
    expect(secretsKeyConfigured()).toBe(false)
    expect(() => loadSecretsKey()).toThrow(SecretCryptoError)
  })

  it('refuses a key of the wrong length and says how to make one, without echoing it', () => {
    const tooShort = randomBytes(16).toString('base64')
    withKey(tooShort)
    const err = (() => {
      try {
        loadSecretsKey()
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(SecretCryptoError)
    const message = (err as Error).message
    expect(message).toContain('32 bytes')
    expect(message).toContain('got 16')
    expect(message).toContain('openssl rand -base64 32')
    expect(message).not.toContain(tooShort)
  })

  it('picks up a rotated key without a restart', () => {
    const first = loadSecretsKey()
    withKey(KEY_B)
    expect(loadSecretsKey().equals(first)).toBe(false)
  })

  it('returns the memoised buffer while the environment value is unchanged', () => {
    expect(loadSecretsKey()).toBe(loadSecretsKey())
  })
})

describe('secretsKeyConfigured', () => {
  it('is true with a key and false without one', () => {
    expect(secretsKeyConfigured()).toBe(true)
    withKey(undefined)
    expect(secretsKeyConfigured()).toBe(false)
  })
})

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value', () => {
    const value = 'EAAG-a-meta-access-token'
    expect(decryptSecret(encryptSecret(value))).toBe(value)
  })

  it('stores v1:<iv>:<tag>:<ciphertext> and never the plaintext', () => {
    const stored = encryptSecret('EAAG-a-meta-access-token')
    const parts = stored.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(Buffer.from(parts[1]!, 'base64')).toHaveLength(12)
    expect(Buffer.from(parts[2]!, 'base64')).toHaveLength(16)
    expect(stored).not.toContain('EAAG-a-meta-access-token')
  })

  it('produces different ciphertext for the same value, so equal rows are not detectable', () => {
    const a = encryptSecret('same-token')
    const b = encryptSecret('same-token')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('same-token')
    expect(decryptSecret(b)).toBe('same-token')
  })

  it('round-trips non-ASCII and an empty string', () => {
    for (const value of ['token-ção-ü-😀', '']) {
      expect(decryptSecret(encryptSecret(value))).toBe(value)
    }
  })

  it('leaves an already-wrapped value alone, so a second pass is a no-op', () => {
    const once = encryptSecret('token')
    expect(encryptSecret(once)).toBe(once)
  })

  it('needs a key to wrap a value', () => {
    withKey(undefined)
    expect(() => encryptSecret('token')).toThrow(SecretCryptoError)
  })

  it('reads a plaintext value unchanged, so channels that predate encryption keep working', () => {
    expect(decryptSecret('EAAG-plain-legacy-token')).toBe(
      'EAAG-plain-legacy-token',
    )
  })

  it('reads plaintext without a key at all', () => {
    withKey(undefined)
    expect(decryptSecret('EAAG-plain-legacy-token')).toBe(
      'EAAG-plain-legacy-token',
    )
  })

  it('refuses a wrapped value when no key is configured', () => {
    const stored = encryptSecret('token')
    withKey(undefined)
    expect(() => decryptSecret(stored)).toThrow(SecretCryptoError)
  })

  it('refuses a wrapped value under the wrong key, without echoing the value', () => {
    const stored = encryptSecret('token')
    withKey(KEY_B)
    const err = (() => {
      try {
        decryptSecret(stored)
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(SecretCryptoError)
    expect((err as Error).message).toContain(SECRETS_KEY_ENV)
    expect((err as Error).message).not.toContain(stored)
  })

  it('refuses a tampered ciphertext: the auth tag makes it a failure, not a different token', () => {
    const parts = encryptSecret('token').split(':')
    const flipped = Buffer.from(parts[3]!, 'base64')
    flipped[0] ^= 0xff
    parts[3] = flipped.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow(SecretCryptoError)
  })

  it('refuses a value whose IV or tag is the wrong size', () => {
    const parts = encryptSecret('token').split(':')
    const shortIv = [parts[0], randomBytes(8).toString('base64'), parts[2], parts[3]]
    expect(() => decryptSecret(shortIv.join(':'))).toThrow(/malformed/)
    const shortTag = [parts[0], parts[1], randomBytes(4).toString('base64'), parts[3]]
    expect(() => decryptSecret(shortTag.join(':'))).toThrow(/malformed/)
  })
})

describe('isEncryptedSecret', () => {
  it('recognises the stored format', () => {
    expect(isEncryptedSecret(encryptSecret('token'))).toBe(true)
  })

  it.each([
    ['a plain token', 'EAAGabc123'],
    ['a value with the prefix but too few parts', 'v1:abc:def'],
    ['a value with the prefix but too many parts', 'v1:a:b:c:d'],
    ['a future version', 'v2:a:b:c'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isEncryptedSecret(value)).toBe(false)
  })

  it.each([[undefined], [null], [42], [{}]])('rejects the non-string %s', (value) => {
    expect(isEncryptedSecret(value)).toBe(false)
  })
})

describe('maybeEncryptSecret', () => {
  it('wraps when a key is configured', () => {
    expect(isEncryptedSecret(maybeEncryptSecret('token'))).toBe(true)
  })

  it('returns the value untouched when no key is configured', () => {
    withKey(undefined)
    expect(maybeEncryptSecret('token')).toBe('token')
  })
})

describe('encryptSecretsIn / decryptSecretsIn', () => {
  const config = {
    phoneNumberId: 'phone-1',
    businessAccountId: 'waba-1',
    accessToken: 'ACCESS',
    appSecret: 'APPSECRET',
    webhookVerifyToken: 'VERIFY',
  }

  it('wraps only the named fields and leaves the queryable ones readable', () => {
    const stored = encryptSecretsIn(config, SECRET_FIELDS)
    expect(stored.phoneNumberId).toBe('phone-1')
    expect(stored.businessAccountId).toBe('waba-1')
    for (const field of SECRET_FIELDS) {
      expect(isEncryptedSecret(stored[field])).toBe(true)
    }
  })

  it('round-trips the whole config', () => {
    expect(decryptSecretsIn(encryptSecretsIn(config, SECRET_FIELDS), SECRET_FIELDS)).toEqual(
      config,
    )
  })

  it('does not mutate its input', () => {
    const input = { ...config }
    encryptSecretsIn(input, SECRET_FIELDS)
    expect(input).toEqual(config)
  })

  it('returns already-wrapped values byte-for-byte, so saving twice is not a change', () => {
    const once = encryptSecretsIn(config, SECRET_FIELDS)
    expect(encryptSecretsIn(once, SECRET_FIELDS)).toEqual(once)
  })

  it('skips fields that are absent, empty or not strings', () => {
    const sparse = { accessToken: '', appSecret: undefined, webhookVerifyToken: 7 }
    expect(encryptSecretsIn(sparse as never, SECRET_FIELDS)).toEqual(sparse)
    expect(decryptSecretsIn(sparse as never, SECRET_FIELDS)).toEqual(sparse)
  })

  it('reads a config that is half migrated', () => {
    const half = {
      ...config,
      accessToken: encryptSecret('ACCESS'),
    }
    expect(decryptSecretsIn(half, SECRET_FIELDS)).toEqual(config)
  })
})

describe('hasEncryptedSecret', () => {
  it('is true when any named field is wrapped', () => {
    expect(
      hasEncryptedSecret({ accessToken: encryptSecret('t') }, SECRET_FIELDS),
    ).toBe(true)
  })

  it('is false for an all-plaintext or empty config', () => {
    expect(hasEncryptedSecret({ accessToken: 'plain' }, SECRET_FIELDS)).toBe(false)
    expect(hasEncryptedSecret({}, SECRET_FIELDS)).toBe(false)
  })
})
