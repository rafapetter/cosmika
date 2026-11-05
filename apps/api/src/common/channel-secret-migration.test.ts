import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  formatSecretMigrationSummary,
  migrateChannelSecrets,
} from './channel-secret-migration'
import {
  SECRETS_KEY_ENV,
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from './secret-crypto'

const KEY = randomBytes(32).toString('base64')
const OTHER_KEY = randomBytes(32).toString('base64')

const originalKey = process.env[SECRETS_KEY_ENV]

function setKey(value: string | undefined) {
  if (value === undefined) delete process.env[SECRETS_KEY_ENV]
  else process.env[SECRETS_KEY_ENV] = value
}

const PLAINTEXT = {
  phoneNumberId: 'phone-1',
  businessAccountId: 'waba-1',
  accessToken: 'EAAG-access-token',
  appSecret: 'meta-app-secret',
  webhookVerifyToken: 'verify-me',
}

type Row = { id: string; name: string; channelConfig: unknown }

function makePrisma(rows: Row[]) {
  const store = new Map(rows.map((r) => [r.id, r]))
  return {
    rows: store,
    inbox: {
      findMany: vi.fn(async (args: unknown) => {
        const where = (args as { where: { id?: string } }).where
        return [...store.values()].filter((r) => !where.id || r.id === where.id)
      }),
      update: vi.fn(async (args: unknown) => {
        const { where, data } = args as {
          where: { id: string }
          data: { channelConfig: unknown }
        }
        const row = store.get(where.id)!
        row.channelConfig = data.channelConfig
        return row
      }),
    },
  }
}

beforeEach(() => setKey(KEY))
afterEach(() => setKey(originalKey))

describe('migrateChannelSecrets: forward', () => {
  it('encrypts every plaintext secret and leaves the queryable fields readable', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.valuesChanged).toBe(3)
    expect(summary.inboxesChanged).toBe(1)
    const saved = prisma.rows.get('inb1')!.channelConfig as Record<string, string>
    expect(saved.phoneNumberId).toBe('phone-1')
    expect(saved.businessAccountId).toBe('waba-1')
    for (const field of ['accessToken', 'appSecret', 'webhookVerifyToken']) {
      expect(isEncryptedSecret(saved[field])).toBe(true)
    }
    expect(decryptSecret(saved.accessToken!)).toBe('EAAG-access-token')
  })

  it('is idempotent: a second run changes nothing and rewrites no row', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    await migrateChannelSecrets(prisma, { mode: 'encrypt', dryRun: false })
    const afterFirst = prisma.rows.get('inb1')!.channelConfig
    prisma.inbox.update.mockClear()

    const second = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(second.valuesChanged).toBe(0)
    expect(second.valuesAlreadyDone).toBe(3)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(prisma.rows.get('inb1')!.channelConfig).toBe(afterFirst)
  })

  it('does not disturb a channel that is already encrypted while converting one that is not', async () => {
    const done = {
      ...PLAINTEXT,
      accessToken: encryptSecret('EAAG-access-token'),
      appSecret: encryptSecret('meta-app-secret'),
      webhookVerifyToken: encryptSecret('verify-me'),
    }
    const prisma = makePrisma([
      { id: 'done', name: 'Already done', channelConfig: { ...done } },
      { id: 'todo', name: 'Still plain', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.inboxesScanned).toBe(2)
    expect(summary.inboxesChanged).toBe(1)
    expect(summary.changes.map((c) => c.inboxId)).toEqual(['todo'])
    expect(prisma.rows.get('done')!.channelConfig).toEqual(done)
  })

  it('converts a half-migrated channel, counting the field already done', async () => {
    const prisma = makePrisma([
      {
        id: 'inb1',
        name: 'Half',
        channelConfig: { ...PLAINTEXT, accessToken: encryptSecret('EAAG-access-token') },
      },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.changes[0]!.fields).toEqual(['appSecret', 'webhookVerifyToken'])
    expect(summary.changes[0]!.alreadyDone).toBe(1)
  })

  it('skips fields that are absent or empty', async () => {
    const prisma = makePrisma([
      {
        id: 'inb1',
        name: 'Inbound only',
        channelConfig: { phoneNumberId: 'p', appSecret: 'secret', webhookVerifyToken: '' },
      },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.changes[0]!.fields).toEqual(['appSecret'])
    const saved = prisma.rows.get('inb1')!.channelConfig as Record<string, unknown>
    expect(saved.webhookVerifyToken).toBe('')
  })

  it.each([[null], ['not an object'], [[1]]])(
    'leaves a channelConfig of %s alone',
    async (channelConfig) => {
      const prisma = makePrisma([{ id: 'inb1', name: 'Odd', channelConfig }])
      const summary = await migrateChannelSecrets(prisma, {
        mode: 'encrypt',
        dryRun: false,
      })
      expect(summary.valuesChanged).toBe(0)
      expect(prisma.inbox.update).not.toHaveBeenCalled()
    },
  )
})

describe('migrateChannelSecrets: dry run', () => {
  it('reports what it would convert, per channel, and writes nothing', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
      { id: 'inb2', name: 'Sales', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: true,
    })
    expect(prisma.inbox.update).not.toHaveBeenCalled()
    expect(summary.inboxesChanged).toBe(2)
    expect(summary.valuesChanged).toBe(6)
    expect(summary.changes).toEqual([
      {
        inboxId: 'inb1',
        name: 'Support',
        fields: ['accessToken', 'appSecret', 'webhookVerifyToken'],
        alreadyDone: 0,
      },
      {
        inboxId: 'inb2',
        name: 'Sales',
        fields: ['accessToken', 'appSecret', 'webhookVerifyToken'],
        alreadyDone: 0,
      },
    ])
    expect(prisma.rows.get('inb1')!.channelConfig).toEqual(PLAINTEXT)
  })
})

describe('migrateChannelSecrets: reverse (rollback)', () => {
  it('puts the values back in plaintext, so the previous release can read them', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    await migrateChannelSecrets(prisma, { mode: 'encrypt', dryRun: false })
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'decrypt',
      dryRun: false,
    })
    expect(summary.valuesChanged).toBe(3)
    expect(prisma.rows.get('inb1')!.channelConfig).toEqual(PLAINTEXT)
  })

  it('is idempotent in reverse too', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'decrypt',
      dryRun: false,
    })
    expect(summary.valuesChanged).toBe(0)
    expect(summary.valuesAlreadyDone).toBe(3)
    expect(prisma.inbox.update).not.toHaveBeenCalled()
  })

  it('has a dry run of its own', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    await migrateChannelSecrets(prisma, { mode: 'encrypt', dryRun: false })
    const encrypted = prisma.rows.get('inb1')!.channelConfig
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'decrypt',
      dryRun: true,
    })
    expect(summary.valuesChanged).toBe(3)
    expect(prisma.rows.get('inb1')!.channelConfig).toBe(encrypted)
  })

  it('round-trips forward then back to exactly the original bytes', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT, extraKey: 'kept' } },
    ])
    await migrateChannelSecrets(prisma, { mode: 'encrypt', dryRun: false })
    await migrateChannelSecrets(prisma, { mode: 'decrypt', dryRun: false })
    expect(prisma.rows.get('inb1')!.channelConfig).toEqual({
      ...PLAINTEXT,
      extraKey: 'kept',
    })
  })
})

describe('migrateChannelSecrets: failures', () => {
  it('refuses to start without a key, before touching a row', async () => {
    setKey(undefined)
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    await expect(
      migrateChannelSecrets(prisma, { mode: 'encrypt', dryRun: false }),
    ).rejects.toThrow(SecretCryptoError)
    expect(prisma.inbox.findMany).not.toHaveBeenCalled()
  })

  it('records the channel it cannot read and keeps going with the rest', async () => {
    const foreign = encryptSecret('EAAG-under-another-key')
    setKey(OTHER_KEY)
    const prisma = makePrisma([
      { id: 'bad', name: 'Wrong key', channelConfig: { ...PLAINTEXT, accessToken: foreign } },
      { id: 'good', name: 'Fine', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'decrypt',
      dryRun: false,
    })
    expect(summary.failures).toEqual([
      {
        inboxId: 'bad',
        name: 'Wrong key',
        reason: expect.stringContaining(SECRETS_KEY_ENV),
      },
    ])
    expect(summary.failures[0]!.reason).not.toContain(foreign)
    // The good channel was still processed; the run did not abort.
    expect(summary.inboxesScanned).toBe(2)
    expect(prisma.inbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bad' } }),
    )
  })

  it('reports a malformed stored value as a failure, not a crash', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Broken', channelConfig: { ...PLAINTEXT, accessToken: 'v1:a:b:c' } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'decrypt',
      dryRun: false,
    })
    expect(summary.failures[0]!.reason).toContain('malformed')
  })

  it('records a write failure without echoing the query arguments', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    prisma.inbox.update.mockRejectedValue(
      Object.assign(new Error('accessToken: "EAAG-access-token"'), {
        name: 'PrismaClientKnownRequestError',
      }),
    )
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.inboxesChanged).toBe(0)
    expect(summary.valuesChanged).toBe(0)
    expect(summary.changes).toEqual([])
    expect(summary.failures[0]!.reason).toBe(
      'write failed (PrismaClientKnownRequestError)',
    )
    expect(JSON.stringify(summary)).not.toContain('EAAG-access-token')
  })

  it('labels a thrown non-Error generically', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    prisma.inbox.update.mockRejectedValue('boom')
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    expect(summary.failures[0]!.reason).toBe('write failed (unknown error)')
  })
})

describe('migrateChannelSecrets: one channel', () => {
  it('restricts the run to the given inbox', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'One', channelConfig: { ...PLAINTEXT } },
      { id: 'inb2', name: 'Two', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
      inboxId: 'inb2',
    })
    expect(summary.inboxesScanned).toBe(1)
    expect(prisma.rows.get('inb1')!.channelConfig).toEqual(PLAINTEXT)
  })
})

describe('formatSecretMigrationSummary', () => {
  it('names the channels and the fields, never a value', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: false,
    })
    const text = formatSecretMigrationSummary(summary)
    expect(text).toContain('converted 3 value(s) on "Support" (inb1)')
    expect(text).toContain('accessToken, appSecret, webhookVerifyToken')
    expect(text).toContain('channels changed: 1')
    expect(text).toContain('values converted: 3')
    for (const value of Object.values(PLAINTEXT)) {
      if (value.startsWith('phone') || value.startsWith('waba')) continue
      expect(text).not.toContain(value)
    }
  })

  it('says a dry run wrote nothing', async () => {
    const prisma = makePrisma([
      { id: 'inb1', name: 'Support', channelConfig: { ...PLAINTEXT } },
    ])
    const summary = await migrateChannelSecrets(prisma, {
      mode: 'encrypt',
      dryRun: true,
    })
    const text = formatSecretMigrationSummary(summary)
    expect(text).toContain('dry run, nothing was written')
    expect(text).toContain('would convert 3 value(s)')
    expect(text).toContain('channels to change: 1')
  })

  it('lists failures and the reverse mode label', async () => {
    const text = formatSecretMigrationSummary({
      mode: 'decrypt',
      dryRun: false,
      inboxesScanned: 1,
      inboxesChanged: 0,
      valuesChanged: 0,
      valuesAlreadyDone: 0,
      changes: [],
      failures: [{ inboxId: 'inb1', name: 'Broken', reason: 'stored secret is malformed' }],
    })
    expect(text).toContain('mode: decrypt')
    expect(text).toContain('FAILED "Broken" (inb1): stored secret is malformed')
    expect(text).toContain('failures: 1')
  })
})
