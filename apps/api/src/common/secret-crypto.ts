import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Encryption at rest for channel credentials.
 *
 * Provider secrets (a WhatsApp access token, app secret and webhook verify
 * token) used to sit in `Inbox.channelConfig` in the clear, which means a
 * database dump, a replica, a backup file or a stray `SELECT` hands the
 * reader a live token. This module wraps each individual VALUE, not the whole
 * JSON column, so:
 *
 *   - the non-secret keys of the config stay queryable (the webhook
 *     cross-delivery guard and the duplicate-number check both filter on
 *     `channelConfig->>'phoneNumberId'`);
 *   - the readable keys still tell an operator which channel a row is,
 *     without handing over the credentials;
 *   - a value can be rotated to a new key one field at a time.
 *
 * Stored format (single line, no separator collisions since base64 has no
 * colon):
 *
 *   v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 *
 * `v1` is the format version, not the key version: it says "AES-256-GCM, 12
 * byte IV, 16 byte tag, key from COSMIKA_SECRETS_KEY". A future `v2` (a new
 * cipher, or a key id embedded in the value) can be read alongside v1 because
 * the reader dispatches on the prefix, which is what makes an online rotation
 * possible instead of a stop-the-world migration.
 *
 * AES-256-GCM (not CBC) because the tag makes tampering with a stored value a
 * decryption failure rather than a silently mangled token: a truncated or
 * flipped ciphertext cannot turn into a different valid-looking secret. The
 * IV is fresh random per value per write, so writing the same token twice
 * produces different ciphertext and nobody can tell two channels share a
 * token by comparing rows.
 *
 * Reads are TOLERANT: a value that is not in this format is returned as it
 * is. That is what lets already-live accounts keep working the moment this
 * code ships, before the migration script has run, and it is why the write
 * path re-wraps whatever it finds (see `encryptSecretsIn`).
 */

/** Environment variable holding the 32-byte key, base64-encoded. */
export const SECRETS_KEY_ENV = 'COSMIKA_SECRETS_KEY'

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
/** v1 / iv / tag / ciphertext. */
const PART_COUNT = 4

/**
 * Anything wrong with the key or with a stored value. The message NEVER
 * carries the plaintext, the ciphertext or the key: this error is allowed to
 * reach a log, Sentry or a 500 body.
 */
export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretCryptoError'
  }
}

let cached: { raw: string; key: Buffer } | null = null

function rawKey(): string | null {
  const raw = process.env[SECRETS_KEY_ENV]
  if (raw === undefined) return null
  // A .env line copy-pasted with a trailing space or newline is still a key.
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/** Whether a usable key is present in the environment. Does not validate it. */
export function secretsKeyConfigured(): boolean {
  return rawKey() !== null
}

/**
 * The decoded key. Memoised against the raw environment string so a rotated
 * or test-injected value is picked up without a restart.
 */
export function loadSecretsKey(): Buffer {
  const raw = rawKey()
  if (raw === null) {
    throw new SecretCryptoError(`${SECRETS_KEY_ENV} is not set`)
  }
  if (cached && cached.raw === raw) return cached.key
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    // Length only. Never echo the value, not even a prefix.
    throw new SecretCryptoError(
      `${SECRETS_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${key.length}); generate one with: openssl rand -base64 32`,
    )
  }
  cached = { raw, key }
  return key
}

/**
 * Whether a value is already in the stored format. Structural, so a plain
 * token is never mistaken for one: it must have exactly four colon-separated
 * parts and start with the version tag.
 */
export function isEncryptedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  return parts.length === PART_COUNT && parts[0] === VERSION
}

/** Wrap a plaintext value. Requires a key; already-wrapped input passes through. */
export function encryptSecret(plaintext: string): string {
  if (isEncryptedSecret(plaintext)) return plaintext
  const key = loadSecretsKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Wrap a value when a key is configured, otherwise leave it as it is.
 *
 * This is the write path used by the application. Without a key the channel
 * keeps behaving exactly as it did before this feature existed (plaintext in,
 * plaintext out) instead of refusing to save, so a deployment that has not
 * been given a key yet is degraded, not broken. The boot check refuses to
 * start when that combination would instead mean "we cannot read what is
 * already stored" (see common/channel-secrets.service.ts).
 */
export function maybeEncryptSecret(plaintext: string): string {
  if (!secretsKeyConfigured()) return plaintext
  return encryptSecret(plaintext)
}

/**
 * Unwrap a stored value. A value that is not in the stored format is returned
 * unchanged, which is how channels that predate encryption keep working.
 */
export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) return value
  const [, ivPart, tagPart, ciphertextPart] = value.split(':')
  const key = loadSecretsKey()
  const iv = Buffer.from(ivPart!, 'base64')
  const tag = Buffer.from(tagPart!, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretCryptoError('stored secret is malformed')
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart!, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // Wrong key, or the row was tampered with. The underlying OpenSSL error
    // text is useless to an operator and we must not risk it carrying data,
    // so it is dropped.
    throw new SecretCryptoError(
      `stored secret could not be decrypted; check ${SECRETS_KEY_ENV}`,
    )
  }
}

// ─── Whole-config helpers ────────────────────────────────────────────
//
// Every caller works on a channelConfig object and a list of secret field
// names, so the per-field loop lives here once instead of in each module.

/** A copy of `config` with each named field unwrapped, ready to use. */
export function decryptSecretsIn<T extends Record<string, unknown>>(
  config: T,
  fields: readonly string[],
): T {
  const out: Record<string, unknown> = { ...config }
  for (const field of fields) {
    const value = out[field]
    if (typeof value === 'string') out[field] = decryptSecret(value)
  }
  return out as T
}

/**
 * A copy of `config` with each named field wrapped for storage.
 *
 * Applied on every save, not only when a secret changed, so a channel that
 * still holds plaintext is rewritten encrypted the first time anyone saves
 * it. Values that are already wrapped are left byte-for-byte alone, so
 * saving twice does not re-encrypt and does not look like a change.
 */
export function encryptSecretsIn<T extends Record<string, unknown>>(
  config: T,
  fields: readonly string[],
): T {
  const out: Record<string, unknown> = { ...config }
  for (const field of fields) {
    const value = out[field]
    if (typeof value === 'string' && value !== '') {
      out[field] = maybeEncryptSecret(value)
    }
  }
  return out as T
}

/** Whether any of the named fields is already stored encrypted. */
export function hasEncryptedSecret(
  config: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => isEncryptedSecret(config[field]))
}
