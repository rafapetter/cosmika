import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChannelSecretsBootCheck } from './channel-secrets.service'
import { SECRETS_KEY_ENV, SecretCryptoError, encryptSecret } from './secret-crypto'

const KEY = randomBytes(32).toString('base64')

const originalKey = process.env[SECRETS_KEY_ENV]
const originalNodeEnv = process.env.NODE_ENV

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function makePrisma(inboxes: Array<{ id: string; channelConfig: unknown }> = []) {
  return { inbox: { findMany: vi.fn().mockResolvedValue(inboxes) } }
}

function makeCheck(prisma: ReturnType<typeof makePrisma>) {
  const check = new ChannelSecretsBootCheck(prisma as never)
  const logs: string[] = []
  ;(check as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void } }).logger =
    {
      log: (m: string) => logs.push(`log: ${m}`),
      warn: (m: string) => logs.push(`warn: ${m}`),
    }
  return { check, logs }
}

beforeEach(() => {
  setEnv(SECRETS_KEY_ENV, KEY)
  setEnv('NODE_ENV', 'test')
})
afterEach(() => {
  setEnv(SECRETS_KEY_ENV, originalKey)
  setEnv('NODE_ENV', originalNodeEnv)
})

describe('ChannelSecretsBootCheck: key present', () => {
  it('boots and never looks at the database', async () => {
    const prisma = makePrisma()
    const { check, logs } = makeCheck(prisma)
    await check.onApplicationBootstrap()
    expect(prisma.inbox.findMany).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('encryption key loaded')
  })

  it('refuses to boot on a key of the wrong length, and does not print it', async () => {
    const bad = randomBytes(20).toString('base64')
    setEnv(SECRETS_KEY_ENV, bad)
    const { check } = makeCheck(makePrisma())
    const err = await check.onApplicationBootstrap().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecretCryptoError)
    expect((err as Error).message).toContain('openssl rand -base64 32')
    expect((err as Error).message).not.toContain(bad)
  })
})

describe('ChannelSecretsBootCheck: no key', () => {
  beforeEach(() => setEnv(SECRETS_KEY_ENV, undefined))

  it('refuses to boot in production, saying how to make a key', async () => {
    setEnv('NODE_ENV', 'production')
    const prisma = makePrisma()
    const { check } = makeCheck(prisma)
    const err = await check.onApplicationBootstrap().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecretCryptoError)
    expect((err as Error).message).toContain(SECRETS_KEY_ENV)
    expect((err as Error).message).toContain('openssl rand -base64 32')
    // It fails before the query: production without a key is wrong whatever
    // the data looks like.
    expect(prisma.inbox.findMany).not.toHaveBeenCalled()
  })

  it('refuses to boot when a channel already holds an encrypted value', async () => {
    // The key has to exist to BUILD the fixture; the check runs without it.
    setEnv(SECRETS_KEY_ENV, KEY)
    const stored = encryptSecret('EAAG-token')
    setEnv(SECRETS_KEY_ENV, undefined)
    const prisma = makePrisma([
      { id: 'inb1', channelConfig: { phoneNumberId: 'p1', accessToken: stored } },
    ])
    const { check } = makeCheck(prisma)
    const err = await check.onApplicationBootstrap().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SecretCryptoError)
    expect((err as Error).message).toContain('1 WhatsApp channel')
    expect((err as Error).message).toContain('--decrypt')
    expect((err as Error).message).not.toContain(stored)
  })

  it('boots with a warning when every channel is still plaintext', async () => {
    const prisma = makePrisma([
      {
        id: 'inb1',
        channelConfig: { phoneNumberId: 'p1', accessToken: 'EAAG-plain' },
      },
    ])
    const { check, logs } = makeCheck(prisma)
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('plaintext')
    expect(prisma.inbox.findMany).toHaveBeenCalledWith({
      where: { channelType: 'WHATSAPP' },
      select: { id: true, channelConfig: true },
    })
  })

  it('boots when there are no WhatsApp channels at all', async () => {
    const { check } = makeCheck(makePrisma())
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
  })

  it.each([[null], [undefined], ['a string'], [[1, 2]]])(
    'treats a channelConfig of %s as empty instead of crashing',
    async (channelConfig) => {
      const { check } = makeCheck(makePrisma([{ id: 'inb1', channelConfig }]))
      await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    },
  )
})
