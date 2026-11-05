import { createHash } from 'node:crypto'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiKeysService } from './api-keys.service'

/**
 * Mock PrismaService that records every call + lets each test stub the
 * specific methods it cares about. Constructed fresh per test.
 */
function makePrisma() {
  return {
    accountMember: {
      findUnique: vi.fn(),
    },
    apiKey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  }
}

type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma): ApiKeysService {
  return new ApiKeysService(prisma as never)
}

// ---------- assertAdmin (via list/create/revoke) ----------

describe('ApiKeysService — admin guard', () => {
  let prisma: Prisma
  let svc: ApiKeysService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
  })

  it('list() rejects when membership is missing', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('list() rejects when membership is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'ADMINISTRATOR',
      isActive: false,
    })
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('list() rejects when role is AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'AGENT',
      isActive: true,
    })
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(
      'Administrator role required',
    )
  })

  it('list() rejects when role is SUPERVISOR', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'SUPERVISOR',
      isActive: true,
    })
    await expect(svc.list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('list() returns rows for an active admin', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'ADMINISTRATOR',
      isActive: true,
    })
    const rows = [{ id: 'k1' }, { id: 'k2' }]
    prisma.apiKey.findMany.mockResolvedValue(rows)
    const result = await svc.list('u1', 'acc1')
    expect(result).toBe(rows)
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { createdAt: 'desc' },
    })
  })
})

// ---------- create ----------

describe('ApiKeysService.create', () => {
  let prisma: Prisma
  let svc: ApiKeysService

  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'ADMINISTRATOR',
      isActive: true,
    })
    svc = makeService(prisma)
  })

  it('creates an API key and returns the plaintext token', async () => {
    let captured: { prefix: string; secretHash: string; name: string; accountId: string } | null = null
    prisma.apiKey.create.mockImplementation(async ({ data }) => {
      captured = data
      return { ...data, id: 'k1', createdAt: new Date() }
    })

    const result = await svc.create('u1', 'acc1', 'Production key')

    expect(result.token).toMatch(/^cosmika_[0-9a-f]{8}_[A-Za-z0-9_-]+$/)
    expect(captured!.name).toBe('Production key')
    expect(captured!.accountId).toBe('acc1')
    expect(captured!.prefix).toMatch(/^[0-9a-f]{8}$/)
    // The stored hash must be sha256(token), not the token itself.
    const expectedHash = createHash('sha256').update(result.token).digest('hex')
    expect(captured!.secretHash).toBe(expectedHash)
    expect(captured!.secretHash).toHaveLength(64) // sha256 hex
  })

  it('generates a different token + prefix on each call (statistically certain)', async () => {
    prisma.apiKey.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: 'k',
      createdAt: new Date(),
    }))

    const tokens = new Set<string>()
    const prefixes = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      const r = await svc.create('u1', 'acc1', 'k' + i)
      tokens.add(r.token)
      prefixes.add(r.row.prefix)
    }
    expect(tokens.size).toBe(20)
    expect(prefixes.size).toBe(20)
  })
})

// ---------- revoke ----------

describe('ApiKeysService.revoke', () => {
  let prisma: Prisma
  let svc: ApiKeysService

  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue({
      role: 'ADMINISTRATOR',
      isActive: true,
    })
    svc = makeService(prisma)
  })

  it('404s when the key does not exist', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null)
    await expect(svc.revoke('u1', 'acc1', 'missing')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404s when the key belongs to a different account (IDOR guard)', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'other-acc',
      revokedAt: null,
    })
    await expect(svc.revoke('u1', 'acc1', 'k1')).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
  })

  it('sets revokedAt when the key is valid + owned by the account', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'acc1',
      revokedAt: null,
    })
    prisma.apiKey.update.mockResolvedValue({})
    await svc.revoke('u1', 'acc1', 'k1')
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { revokedAt: expect.any(Date) },
    })
  })
})

// ---------- resolveToken ----------

describe('ApiKeysService.resolveToken', () => {
  let prisma: Prisma
  let svc: ApiKeysService

  beforeEach(() => {
    prisma = makePrisma()
    svc = makeService(prisma)
  })

  it('returns null for a malformed token (no prefix)', async () => {
    expect(await svc.resolveToken('not_a_cosmika_token')).toBeNull()
    expect(await svc.resolveToken('cosmika_xyz')).toBeNull()
    expect(await svc.resolveToken('')).toBeNull()
  })

  it('returns null for a token with a non-hex prefix', async () => {
    // prefix must match /[0-9a-f]{8}/ — uppercase letters fail
    expect(
      await svc.resolveToken('cosmika_ABCDEF12_somesecretpartdoesntmatter'),
    ).toBeNull()
  })

  it('returns null when the prefix is unknown in the DB', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null)
    expect(await svc.resolveToken('cosmika_deadbeef_xyz')).toBeNull()
  })

  it('returns null when the key has been revoked', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'acc1',
      secretHash: createHash('sha256').update('cosmika_deadbeef_secret').digest('hex'),
      revokedAt: new Date('2026-01-01T00:00:00Z'),
    })
    expect(await svc.resolveToken('cosmika_deadbeef_secret')).toBeNull()
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
  })

  it('returns null when the hash does not match (forged secret)', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'acc1',
      secretHash: createHash('sha256').update('cosmika_deadbeef_REAL').digest('hex'),
      revokedAt: null,
    })
    expect(await svc.resolveToken('cosmika_deadbeef_FAKE')).toBeNull()
  })

  it('returns the accountId and fires lastUsedAt update for a valid token', async () => {
    const token = 'cosmika_deadbeef_validsecret'
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'acc-target',
      secretHash: createHash('sha256').update(token).digest('hex'),
      revokedAt: null,
    })
    prisma.apiKey.update.mockResolvedValue({})

    const result = await svc.resolveToken(token)
    expect(result).toEqual({ accountId: 'acc-target' })

    // lastUsedAt update is fire-and-forget — wait a microtask to let it fire.
    await new Promise((r) => setImmediate(r))
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it('swallows lastUsedAt update errors without affecting the return', async () => {
    const token = 'cosmika_deadbeef_validsecret'
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'k1',
      accountId: 'acc-target',
      secretHash: createHash('sha256').update(token).digest('hex'),
      revokedAt: null,
    })
    prisma.apiKey.update.mockRejectedValue(new Error('DB transient'))

    // Should still resolve to the account — the throw is swallowed.
    const result = await svc.resolveToken(token)
    expect(result).toEqual({ accountId: 'acc-target' })
    await new Promise((r) => setImmediate(r)) // let the rejected promise settle
  })
})

// ---------- toDTO ----------

describe('ApiKeysService.toDTO', () => {
  const svc = new ApiKeysService(makePrisma() as never)

  it('maps a row with non-null revokedAt + lastUsedAt to ISO strings', () => {
    const row = {
      id: 'k1',
      accountId: 'acc1',
      name: 'Test',
      prefix: 'abcd1234',
      secretHash: 'unused',
      revokedAt: new Date('2026-01-01T00:00:00Z'),
      lastUsedAt: new Date('2026-02-01T12:34:56Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
    }
    expect(svc.toDTO(row as never)).toEqual({
      id: 'k1',
      accountId: 'acc1',
      name: 'Test',
      prefix: 'abcd1234',
      revokedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-02-01T12:34:56.000Z',
      createdAt: '2025-12-01T00:00:00.000Z',
    })
  })

  it('emits null for revokedAt + lastUsedAt when they are null', () => {
    const row = {
      id: 'k1',
      accountId: 'acc1',
      name: 'Active',
      prefix: 'abcd1234',
      secretHash: 'unused',
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date('2025-12-01T00:00:00Z'),
    }
    const dto = svc.toDTO(row as never)
    expect(dto.revokedAt).toBeNull()
    expect(dto.lastUsedAt).toBeNull()
    expect(dto.createdAt).toBe('2025-12-01T00:00:00.000Z')
  })

  it('never leaks the secretHash', () => {
    const row = {
      id: 'k1',
      accountId: 'acc1',
      name: 'Test',
      prefix: 'abcd1234',
      secretHash: 'SECRET_THAT_MUST_NOT_LEAK',
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    }
    const dto = svc.toDTO(row as never)
    expect(Object.values(dto)).not.toContain('SECRET_THAT_MUST_NOT_LEAK')
    expect(dto).not.toHaveProperty('secretHash')
  })
})
