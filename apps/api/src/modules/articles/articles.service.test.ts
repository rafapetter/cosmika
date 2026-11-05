import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArticlesService } from './articles.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    article: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return { get: vi.fn((k: string) => overrides[k]) } as unknown as ConfigService
}

function makeService(p: Prisma, config = makeConfig()) {
  return new ArticlesService(p as never, config)
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }

afterEach(() => { vi.restoreAllMocks() })

// ---------- list / get ----------

describe('ArticlesService.list', () => {
  it('403 non-member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(p).list('u1', 'acc1', {} as never)).rejects.toThrow(ForbiddenException)
  })

  it('returns articles for any active member', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findMany.mockResolvedValue([])
    await makeService(p).list('u1', 'acc1', {} as never)
    expect(p.article.findMany).toHaveBeenCalled()
  })

  it('filters by status when provided', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findMany.mockResolvedValue([])
    await makeService(p).list('u1', 'acc1', { status: 'PUBLISHED' } as never)
    const arg = p.article.findMany.mock.calls[0]![0]
    expect(arg.where.status).toBe('PUBLISHED')
  })

  it('applies title/content ILIKE filter when q provided', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findMany.mockResolvedValue([])
    await makeService(p).list('u1', 'acc1', { q: 'refund' } as never)
    const arg = p.article.findMany.mock.calls[0]![0]
    expect(arg.where.OR).toEqual([
      { title: { contains: 'refund', mode: 'insensitive' } },
      { content: { contains: 'refund', mode: 'insensitive' } },
    ])
  })

  it('defaults limit to 50, caps at 100', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findMany.mockResolvedValue([])
    await makeService(p).list('u1', 'acc1', {} as never)
    expect(p.article.findMany.mock.calls[0]![0].take).toBe(50)
    await makeService(p).list('u1', 'acc1', { limit: 999 } as never)
    expect(p.article.findMany.mock.calls[1]![0].take).toBe(100)
  })
})

describe('ArticlesService.get', () => {
  it('404 unknown', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findUnique.mockResolvedValue(null)
    await expect(makeService(p).get('u1', 'acc1', 'a1')).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'other' })
    await expect(makeService(p).get('u1', 'acc1', 'a1')).rejects.toThrow(NotFoundException)
  })

  it('returns article when authorised', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1' })
    expect(await makeService(p).get('u1', 'acc1', 'a1')).toEqual({ id: 'a1', accountId: 'acc1' })
  })
})

// ---------- create ----------

describe('ArticlesService.create', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 for AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(p).create('u1', 'acc1', { slug: 's', title: 't', content: 'c' } as never),
    ).rejects.toThrow('Insufficient role')
  })

  it('SUPERVISOR OK', async () => {
    p.accountMember.findUnique.mockResolvedValue(SUPER)
    p.article.findUnique.mockResolvedValue(null)
    p.article.create.mockResolvedValue({ id: 'a1' })
    await makeService(p).create('u1', 'acc1', { slug: 's', title: 't', content: 'c' } as never)
    expect(p.article.create).toHaveBeenCalled()
  })

  it('409 when slug already exists for the account', async () => {
    p.article.findUnique.mockResolvedValue({ id: 'existing' })
    await expect(
      makeService(p).create('u1', 'acc1', { slug: 'refunds', title: 't', content: 'c' } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('creates with defaults (status=DRAFT, tags=[])', async () => {
    p.article.findUnique.mockResolvedValue(null)
    p.article.create.mockResolvedValue({ id: 'a1', title: 't', content: 'c' })
    await makeService(p).create('u1', 'acc1', {
      slug: 'refunds', title: 'Refunds', content: 'Body',
    } as never)
    const arg = p.article.create.mock.calls[0]![0]
    expect(arg.data.status).toBe('DRAFT')
    expect(arg.data.tags).toEqual([])
    expect(arg.data.authorId).toBe('u1')
  })

  it('respects supplied status + tags', async () => {
    p.article.findUnique.mockResolvedValue(null)
    p.article.create.mockResolvedValue({ id: 'a1', title: 't', content: 'c' })
    await makeService(p).create('u1', 'acc1', {
      slug: 's', title: 't', content: 'c',
      status: 'PUBLISHED', tags: ['policy', 'gdpr'],
    } as never)
    const arg = p.article.create.mock.calls[0]![0]
    expect(arg.data.status).toBe('PUBLISHED')
    expect(arg.data.tags).toEqual(['policy', 'gdpr'])
  })

  it('schedules embedding refresh (fire-and-forget, swallows errors)', async () => {
    p.article.findUnique.mockResolvedValueOnce(null) // for slug dupe check
      .mockResolvedValueOnce({ id: 'a1', title: 't', content: 'c' }) // for refreshEmbedding lookup
    p.article.create.mockResolvedValue({ id: 'a1' })
    p.$executeRawUnsafe.mockRejectedValue(new Error('vector ext missing'))
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    await makeService(p, config).create('u1', 'acc1', {
      slug: 's', title: 't', content: 'c',
    } as never)
    // No throw — error swallowed
    await new Promise((r) => setImmediate(r))
  })

  it('logs error when refreshEmbedding throws (create path)', async () => {
    // First findUnique resolves (slug dupe check returns null = no dupe)
    // Second findUnique (inside refreshEmbedding) rejects → drives the .catch on create()
    p.article.findUnique.mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('DB blew up'))
    p.article.create.mockResolvedValue({ id: 'a1' })
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    const svc = makeService(p, config)
    const logErr = vi.spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => {})
    await svc.create('u1', 'acc1', { slug: 's', title: 't', content: 'c' } as never)
    // Wait for the fire-and-forget promise chain to settle
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(logErr).toHaveBeenCalledWith(expect.stringContaining('embedding refresh failed'))
  })
})

// ---------- update ----------

describe('ArticlesService.update', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(p).update('u1', 'acc1', 'a1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    p.article.findUnique.mockResolvedValue(null)
    await expect(makeService(p).update('u1', 'acc1', 'a1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'other' })
    await expect(makeService(p).update('u1', 'acc1', 'a1', {} as never)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('applies partial fields', async () => {
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    await makeService(p).update('u1', 'acc1', 'a1', { title: 'New' } as never)
    const arg = p.article.update.mock.calls[0]![0]
    expect(arg.data).toEqual({ title: 'New' })
  })

  it('triggers embedding refresh when title or content changes', async () => {
    p.article.findUnique.mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
      .mockResolvedValueOnce({ id: 'a1', title: 'New', content: 'old' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    await makeService(p, config).update('u1', 'acc1', 'a1', { title: 'New' } as never)
    await new Promise((r) => setImmediate(r))
    // refreshEmbedding starts; with STUB=1, embed returns null → no $executeRawUnsafe
  })

  it('does NOT trigger embedding refresh when only tags/status change', async () => {
    p.article.findUnique.mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    await makeService(p).update('u1', 'acc1', 'a1', { status: 'PUBLISHED' } as never)
    await new Promise((r) => setImmediate(r))
    expect(p.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('applies tags + status updates', async () => {
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    await makeService(p).update('u1', 'acc1', 'a1', {
      status: 'PUBLISHED', tags: ['v2'],
    } as never)
    const arg = p.article.update.mock.calls[0]![0]
    expect(arg.data.status).toBe('PUBLISHED')
    expect(arg.data.tags).toEqual(['v2'])
  })

  it('sends empty data when nothing supplied', async () => {
    p.article.findUnique.mockResolvedValue({ id: 'a1', accountId: 'acc1' })
    p.article.update.mockResolvedValue({})
    await makeService(p).update('u1', 'acc1', 'a1', {} as never)
    expect(p.article.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: {} })
  })

  it('refresh embedding error is swallowed (logged not thrown)', async () => {
    p.article.findUnique.mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
      .mockResolvedValueOnce({ id: 'a1', title: 'Bah', content: 'C' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    p.$executeRawUnsafe.mockRejectedValue(new Error('boom'))
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    await expect(
      makeService(p, config).update('u1', 'acc1', 'a1', { content: 'New' } as never),
    ).resolves.toBeDefined()
    await new Promise((r) => setImmediate(r))
  })

  it('logs error when refreshEmbedding throws (update path)', async () => {
    // First findUnique resolves the update guard, second rejects in refreshEmbedding
    p.article.findUnique.mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
      .mockRejectedValueOnce(new Error('DB blew up'))
    p.article.update.mockResolvedValue({ id: 'a1' })
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    const svc = makeService(p, config)
    const logErr = vi.spyOn((svc as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => {})
    await svc.update('u1', 'acc1', 'a1', { content: 'New' } as never)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(logErr).toHaveBeenCalledWith(expect.stringContaining('embedding refresh failed'))
  })
})

// ---------- remove ----------

describe('ArticlesService.remove', () => {
  let p: Prisma
  beforeEach(() => {
    p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    p.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(p).remove('u1', 'acc1', 'a1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    p.article.findUnique.mockResolvedValue(null)
    await expect(makeService(p).remove('u1', 'acc1', 'a1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    p.article.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(makeService(p).remove('u1', 'acc1', 'a1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes when authorised', async () => {
    p.article.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(p).remove('u1', 'acc1', 'a1')
    expect(p.article.delete).toHaveBeenCalledWith({ where: { id: 'a1' } })
  })
})

// ---------- search ----------

describe('ArticlesService.search', () => {
  it('returns [] for empty query', async () => {
    const p = makePrisma()
    expect(await makeService(p).search('acc1', '   ', 5)).toEqual([])
  })

  it('truncates query to 1000 chars', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    await makeService(p).search('acc1', 'x'.repeat(2000), 5)
    // Falls back to ILIKE (no embedding)
    const arg = p.article.findMany.mock.calls[0]![0]
    expect((arg.where.OR[0].title.contains as string).length).toBe(1000)
  })

  it('falls back to ILIKE when embedding unavailable (STUB=1)', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([
      { id: 'a1', slug: 's', title: 't', content: 'c'.repeat(500), updatedAt: new Date() },
    ])
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    const out = await makeService(p, config).search('acc1', 'query', 5)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: 'a1', slug: 's', title: 't', excerpt: 'c'.repeat(280), score: null,
    })
  })

  it('only searches PUBLISHED articles in fallback path', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    const config = makeConfig({ COSMIKA_AI_STUB: '1' })
    await makeService(p, config).search('acc1', 'q', 5)
    const arg = p.article.findMany.mock.calls[0]![0]
    expect(arg.where.status).toBe('PUBLISHED')
  })

  it('routes embeddings through OPENAI_BASE_URL when set (trailing slash tolerated)', async () => {
    const p = makePrisma()
    // Empty vector hit falls through to the ILIKE path, which needs findMany.
    p.$queryRawUnsafe.mockResolvedValue([])
    p.article.findMany.mockResolvedValue([])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://gw.example/openai/v1/' })
    await makeService(p, config).search('acc1', 'refund policy', 5)
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://gw.example/openai/v1/embeddings')
  })

  it('falls back to ILIKE when OPENAI_API_KEY missing', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    // STUB=0 but no key → embed returns null → fallback
    await makeService(p, makeConfig()).search('acc1', 'q', 5)
    expect(p.article.findMany).toHaveBeenCalled()
  })

  it('uses pgvector path when embedding succeeds and returns rows', async () => {
    const p = makePrisma()
    p.$queryRawUnsafe.mockResolvedValue([
      { id: 'a1', slug: 's', title: 't', content: 'c'.repeat(500), distance: 0.1 },
      { id: 'a2', slug: 's2', title: 't2', content: 'c2', distance: null },
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    const out = await makeService(p, config).search('acc1', 'refund policy', 5)
    expect(fetchSpy).toHaveBeenCalled()
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.openai.com/v1/embeddings')
    expect(out[0]).toEqual({
      id: 'a1', slug: 's', title: 't', excerpt: 'c'.repeat(280), score: 0.9,
    })
    expect(out[1]).toEqual({
      id: 'a2', slug: 's2', title: 't2', excerpt: 'c2', score: null,
    })
  })

  it('scopes both search paths to an agent base (knowledge tags)', async () => {
    const p = makePrisma()
    p.$queryRawUnsafe.mockResolvedValue([])
    p.article.findMany.mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }),
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    await makeService(p, config).search('acc1', 'anuidade', 5, ['financeiro'])
    const [sql, , , , tags] = p.$queryRawUnsafe.mock.calls[0]!
    expect(sql).toContain('tags && $4::text[]')
    expect(tags).toEqual(['financeiro'])
    expect(p.article.findMany.mock.calls[0]![0].where.tags).toEqual({ hasSome: ['financeiro'] })
  })

  it('falls through to ILIKE when pgvector returns zero rows', async () => {
    const p = makePrisma()
    p.$queryRawUnsafe.mockResolvedValue([]) // no vector hits
    p.article.findMany.mockResolvedValue([
      { id: 'a1', slug: 's', title: 't', content: 'c', updatedAt: new Date() },
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }),
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    const out = await makeService(p, config).search('acc1', 'q', 5)
    expect(out).toHaveLength(1)
    expect(out[0]?.score).toBeNull()
  })

  it('falls back to ILIKE when OpenAI returns non-2xx', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 503,
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    await makeService(p, config).search('acc1', 'q', 5)
    expect(p.article.findMany).toHaveBeenCalled()
  })

  it('falls back to ILIKE when OpenAI throws (network error / timeout)', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('AbortError'))
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    await makeService(p, config).search('acc1', 'q', 5)
    expect(p.article.findMany).toHaveBeenCalled()
  })

  it('falls back to ILIKE when OpenAI response has no embedding', async () => {
    const p = makePrisma()
    p.article.findMany.mockResolvedValue([])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ data: [] }), // empty
    } as Response)
    const config = makeConfig({ OPENAI_API_KEY: 'sk-test' })
    await makeService(p, config).search('acc1', 'q', 5)
    expect(p.article.findMany).toHaveBeenCalled()
  })
})

// ---------- refreshEmbedding (via update path) ----------

describe('ArticlesService refreshEmbedding edge cases', () => {
  it('no-op if article disappears between trigger and refresh', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    // First findUnique for the update guard
    p.article.findUnique
      .mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
      .mockResolvedValueOnce(null) // article gone by refresh time
    p.article.update.mockResolvedValue({ id: 'a1' })
    await makeService(p, makeConfig({ COSMIKA_AI_STUB: '1' }))
      .update('u1', 'acc1', 'a1', { title: 'X' } as never)
    await new Promise((r) => setImmediate(r))
    // No raw exec since article disappeared
    expect(p.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('writes embedding when fetch succeeds', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(ADMIN)
    p.article.findUnique
      .mockResolvedValueOnce({ id: 'a1', accountId: 'acc1' })
      .mockResolvedValueOnce({ id: 'a1', title: 'T', content: 'C' })
    p.article.update.mockResolvedValue({ id: 'a1' })
    p.$executeRawUnsafe.mockResolvedValue(1)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    } as Response)
    await makeService(p, makeConfig({ OPENAI_API_KEY: 'sk-test' }))
      .update('u1', 'acc1', 'a1', { content: 'New' } as never)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(p.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "Article"'),
      '[1,2,3]',
      'a1',
    )
  })
})

// ---------- toDTO ----------

describe('ArticlesService.toDTO', () => {
  const svc = new ArticlesService(makePrisma() as never, makeConfig())

  it('maps every field with hasEmbedding=true when present', () => {
    expect(
      svc.toDTO({
        id: 'a1',
        accountId: 'acc1',
        slug: 's',
        title: 't',
        content: 'c',
        status: 'PUBLISHED',
        tags: ['x'],
        embedding: [0.1, 0.2],
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'a1',
      accountId: 'acc1',
      slug: 's',
      title: 't',
      content: 'c',
      status: 'PUBLISHED',
      tags: ['x'],
      hasEmbedding: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('hasEmbedding=false when embedding null', () => {
    const dto = svc.toDTO({
      id: 'a1', accountId: 'acc1', slug: 's', title: 't', content: 'c',
      status: 'DRAFT', tags: [],
      embedding: null,
      createdAt: new Date(), updatedAt: new Date(),
    } as never)
    expect(dto.hasEmbedding).toBe(false)
  })

  it('hasEmbedding=false when embedding undefined', () => {
    const dto = svc.toDTO({
      id: 'a1', accountId: 'acc1', slug: 's', title: 't', content: 'c',
      status: 'DRAFT', tags: [],
      createdAt: new Date(), updatedAt: new Date(),
    } as never)
    expect(dto.hasEmbedding).toBe(false)
  })
})

// ---------- readPublished ----------

describe('ArticlesService.readPublished', () => {
  it('returns the whole body when it fits, matching id or slug', async () => {
    const p = makePrisma()
    p.article.findFirst.mockResolvedValue({
      id: 'a1', slug: 'regra-24h', title: 'Regra 24 horas', content: 'corpo curto',
    })
    const out = await makeService(p).readPublished('acc1', 'regra-24h')
    expect(out).toEqual({
      id: 'a1', slug: 'regra-24h', title: 'Regra 24 horas',
      content: 'corpo curto', truncated: false,
    })
    expect(p.article.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: 'acc1',
        status: 'PUBLISHED',
        OR: [{ id: 'regra-24h' }, { slug: 'regra-24h' }],
      },
    })
  })

  it('truncates an oversized body and says so', async () => {
    const p = makePrisma()
    const content = 'x'.repeat(12_500)
    p.article.findFirst.mockResolvedValue({ id: 'a1', slug: 's', title: 't', content })
    const out = await makeService(p).readPublished('acc1', 'a1')
    expect(out!.truncated).toBe(true)
    expect(out!.content).toHaveLength(12_000)
  })

  it('returns null when nothing published matches', async () => {
    const p = makePrisma()
    p.article.findFirst.mockResolvedValue(null)
    expect(await makeService(p).readPublished('acc1', 'ghost')).toBeNull()
  })

  it('reads only inside an agent base when given its tags', async () => {
    const p = makePrisma()
    p.article.findFirst.mockResolvedValue(null)
    await makeService(p).readPublished('acc1', 'a1', ['cadastro'])
    expect(p.article.findFirst.mock.calls[0]![0].where.tags).toEqual({ hasSome: ['cadastro'] })
  })
})
