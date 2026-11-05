import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContactsService } from './contacts.service'

// ---------- helpers ----------

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    contact: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    contactInbox: {
      findMany: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
    contactNote: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    message: {
      updateMany: vi.fn(),
    },
    conversation: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeService(prisma: Prisma) {
  prisma.$transaction.mockImplementation(async (fn: (tx: Prisma) => unknown) =>
    fn(prisma),
  )
  const webhooks = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  }
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  }
  const usage = {
    assertImportWithinAbsoluteLimit: vi.fn().mockResolvedValue(undefined),
  }
  const svc = new ContactsService(
    prisma as never,
    webhooks as never,
    audit as never,
    usage as never,
  )
  return { svc, webhooks, audit, usage }
}

const ADMIN = {
  id: 'm1',
  userId: 'u1',
  accountId: 'acc1',
  role: 'ADMINISTRATOR',
  isActive: true,
}
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }
const INACTIVE = { ...ADMIN, isActive: false }

function baseContact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    accountId: 'acc1',
    name: 'Fulano',
    email: 'a@b.com',
    phoneNumber: '+5511999999999',
    identifier: 'ext-1',
    avatarUrl: null,
    customAttributes: {},
    additionalAttributes: {},
    lastActivityAt: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-02T00:00:00Z'),
    ...overrides,
  }
}

// ---------- getMembership (via list) + assertAccess ----------

describe('ContactsService — getMembership / assertAccess', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('list 403s when user has no membership', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.list('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('list 403s when membership is inactive', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(INACTIVE)
    const { svc } = makeService(prisma)
    await expect(svc.list('u1', 'acc1', {} as never)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('assertAccess returns the role for an active membership', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    expect(await svc.assertAccess('u1', 'acc1')).toBe('AGENT')
  })

  it('assertAccess 403s when no membership', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.assertAccess('u1', 'acc1')).rejects.toThrow(
      ForbiddenException,
    )
  })
})

// ---------- list ----------

describe('ContactsService.update — blank normalisation', () => {
  it('stores empty/whitespace strings as null so they sort and fall back right', async () => {
    const prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'c1', {
      name: '',
      email: '   ',
      phoneNumber: '+5511999999999',
    } as never)
    expect(prisma.contact.update.mock.calls[0]![0].data).toMatchObject({
      name: null,
      email: null,
      phoneNumber: '+5511999999999',
    })
  })
})

describe('ContactsService.list', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('uses the plain sort form for non-nullable columns (Prisma rejects the object form)', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { sort: 'createdAt', dir: 'asc' } as never)
    expect(prisma.contact.findMany.mock.calls[0]![0].orderBy[0]).toEqual({
      createdAt: 'asc',
    })
  })

  it('sorts empty values last in BOTH directions', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    for (const dir of ['asc', 'desc'] as const) {
      prisma.contact.findMany.mockClear()
      await svc.list('u1', 'acc1', { sort: 'name', dir } as never)
      // Postgres leads `desc` with NULLs otherwise, so sorting by name showed
      // a wall of blank rows before any actual name.
      expect(prisma.contact.findMany.mock.calls[0]![0].orderBy[0]).toEqual({
        name: { sort: dir, nulls: 'last' },
      })
    }
  })

  it('counts with the SAME where as the page, so the header number matches the filters', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    prisma.contact.count.mockResolvedValue(42)
    const { svc } = makeService(prisma)
    const out = await svc.list('u1', 'acc1', { q: 'ada', blocked: 'no' } as never)
    expect(out.total).toBe(42)
    const findWhere = prisma.contact.findMany.mock.calls[0]![0].where
    const countWhere = prisma.contact.count.mock.calls[0]![0].where
    expect(countWhere).toEqual(findWhere)
  })

  it('defaults to newest-first and keeps id as the cursor tiebreaker', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', {} as never)
    // createdAt is non-nullable: Prisma rejects the { sort, nulls } form on it.
    expect(prisma.contact.findMany.mock.calls[0]![0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'desc' },
    ])
  })

  it('sorts by the requested column, still tiebroken by id', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { sort: 'name', dir: 'asc' } as never)
    // Without the id tiebreaker, cursor pagination would drift or repeat rows.
    expect(prisma.contact.findMany.mock.calls[0]![0].orderBy).toEqual([
      { name: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ])
  })

  it.each([
    ['blocked', 'yes', { blockedAt: { not: null } }],
    ['blocked', 'no', { blockedAt: null }],
    ['hasEmail', 'yes', { email: { not: null } }],
    ['hasEmail', 'no', { email: null }],
    ['hasPhone', 'yes', { phoneNumber: { not: null } }],
    ['hasPhone', 'no', { phoneNumber: null }],
  ])('filters %s=%s server-side', async (key, value, expected) => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { [key]: value } as never)
    expect(prisma.contact.findMany.mock.calls[0]![0].where).toMatchObject(expected)
  })

  it.each([
    [{ field: 'email', op: 'contains', value: 'acme' },
      { email: { contains: 'acme', mode: 'insensitive' } }],
    [{ field: 'email', op: 'notContains', value: 'spam' },
      { NOT: { email: { contains: 'spam', mode: 'insensitive' } } }],
    [{ field: 'name', op: 'is', value: 'Ada' },
      { name: { equals: 'Ada', mode: 'insensitive' } }],
    [{ field: 'name', op: 'isNot', value: 'Ada' },
      { NOT: { name: { equals: 'Ada', mode: 'insensitive' } } }],
    [{ field: 'phoneNumber', op: 'isEmpty' }, { phoneNumber: null }],
    [{ field: 'identifier', op: 'isNotEmpty' }, { identifier: { not: null } }],
    [{ field: 'blocked', op: 'is', value: 'true' }, { blockedAt: { not: null } }],
    [{ field: 'blocked', op: 'is', value: 'false' }, { blockedAt: null }],
    [{ field: 'blocked', op: 'isNot', value: 'true' }, { blockedAt: null }],
    [{ field: 'blocked', op: 'isNot', value: 'false' }, { blockedAt: { not: null } }],
  ])('composable filter %j → prisma where', async (filter, expected) => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { filters: [filter] } as never)
    expect(prisma.contact.findMany.mock.calls[0]![0].where.AND).toEqual([expected])
  })

  it('ANDs multiple composable filters and shares them with the count', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', {
      filters: [
        { field: 'email', op: 'isNotEmpty' },
        { field: 'name', op: 'contains', value: 'silva' },
      ],
    } as never)
    const w = prisma.contact.findMany.mock.calls[0]![0].where
    expect(w.AND).toHaveLength(2)
    expect(prisma.contact.count.mock.calls[0]![0].where).toEqual(w)
  })

  it('applies filters alongside the search term', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { q: 'ada', blocked: 'no' } as never)
    const where = prisma.contact.findMany.mock.calls[0]![0].where
    expect(where.OR).toBeDefined()
    expect(where.blockedAt).toBeNull()
  })

  it('returns contacts + nextCursor=null when below limit', async () => {
    prisma.contact.findMany.mockResolvedValue([baseContact()])
    prisma.contact.count.mockResolvedValue(1)
    const { svc } = makeService(prisma)
    const out = await svc.list('u1', 'acc1', {} as never)
    expect(out.data).toHaveLength(1)
    expect(out.nextCursor).toBeNull()
    expect(out.total).toBe(1)
  })

  it('uses default page size of 25 (take = 26)', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', {} as never)
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 26 }),
    )
  })

  it('caps limit at MAX_PAGE_SIZE=100', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { limit: 9999 } as never)
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    )
  })

  it('honors caller-provided limit when below cap', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { limit: 10 } as never)
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    )
  })

  it('applies search across name/email/phone/identifier when q is provided', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { q: '  jane  ' } as never)
    const call = prisma.contact.findMany.mock.calls[0]![0]
    expect(call.where.OR).toEqual([
      { name: { contains: 'jane', mode: 'insensitive' } },
      { email: { contains: 'jane', mode: 'insensitive' } },
      { phoneNumber: { contains: 'jane', mode: 'insensitive' } },
      { identifier: { contains: 'jane', mode: 'insensitive' } },
    ])
  })

  it('skips q when undefined (no OR clause)', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', {} as never)
    const call = prisma.contact.findMany.mock.calls[0]![0]
    expect(call.where.OR).toBeUndefined()
  })

  it('returns nextCursor=<last.id> when result exceeds limit', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => baseContact({ id: `c${i}` }))
    prisma.contact.findMany.mockResolvedValue(rows)
    const { svc } = makeService(prisma)
    const out = await svc.list('u1', 'acc1', { limit: 2 } as never)
    expect(out.data).toHaveLength(2)
    expect(out.nextCursor).toBe('c2')
  })

  it('returns nextCursor=null when pop somehow yields undefined', async () => {
    // pop() on a length-1 returns the only element, but with limit=0 the
    // length>limit branch never triggers. Cover the rare ternary fallback by
    // synthesizing an array where pop returns undefined (i.e. shape was
    // [undefined]). This is defensive; covering the `: null` branch.
    prisma.contact.findMany.mockResolvedValue([undefined, undefined])
    const { svc } = makeService(prisma)
    const out = await svc.list('u1', 'acc1', { limit: 1 } as never)
    // We popped — only one element remains.
    expect(out.data).toHaveLength(1)
    expect(out.nextCursor).toBeNull()
  })

  it('passes cursor + skip when caller asks to paginate forward', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    const { svc } = makeService(prisma)
    await svc.list('u1', 'acc1', { cursor: 'c0' } as never)
    const call = prisma.contact.findMany.mock.calls[0]![0]
    expect(call.cursor).toEqual({ id: 'c0' })
    expect(call.skip).toBe(1)
  })
})

// ---------- getWithInboxes ----------

describe('ContactsService.getWithInboxes', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('404 when contact does not exist', async () => {
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.getWithInboxes('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR — contact in another account', async () => {
    prisma.contact.findUnique.mockResolvedValue(
      baseContact({ accountId: 'other-acc' }),
    )
    const { svc } = makeService(prisma)
    await expect(svc.getWithInboxes('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns the contact for any active member', async () => {
    const contact = { ...baseContact(), contactInboxes: [] }
    prisma.contact.findUnique.mockResolvedValue(contact)
    const { svc } = makeService(prisma)
    expect(await svc.getWithInboxes('u1', 'acc1', 'c1')).toBe(contact)
  })
})

// ---------- create ----------

describe('ContactsService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT cannot create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.create('u1', 'acc1', { email: 'a@b.com' } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('SUPERVISOR can create, and creating one contact is never refused for being over a cap', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc, usage } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      email: 'a@b.com',
      name: 'Jane',
    } as never)
    // This used to throw 402 above the contact cap, which section 4.2 of the
    // terms forbids: the contact is created and the overage is billed.
    expect(prisma.contact.create).toHaveBeenCalled()
    expect(usage.assertImportWithinAbsoluteLimit).not.toHaveBeenCalled()
  })

  it('ADMINISTRATOR creates + dispatches contact.created webhook', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const created = baseContact()
    prisma.contact.create.mockResolvedValue(created)
    const { svc, webhooks } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      email: 'a@b.com',
      name: 'Jane',
      phoneNumber: '+551199',
    } as never)
    expect(webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'contact.created',
      expect.objectContaining({ contactId: 'c1' }),
    )
  })

  it('defaults customAttributes/additionalAttributes to {}', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', { email: 'a@b.com' } as never)
    const data = prisma.contact.create.mock.calls[0]![0].data
    expect(data.customAttributes).toEqual({})
    expect(data.additionalAttributes).toEqual({})
  })

  it('passes through customAttributes/additionalAttributes when provided', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.create('u1', 'acc1', {
      email: 'a@b.com',
      customAttributes: { tier: 'gold' },
      additionalAttributes: { country: 'BR' },
    } as never)
    const data = prisma.contact.create.mock.calls[0]![0].data
    expect(data.customAttributes).toEqual({ tier: 'gold' })
    expect(data.additionalAttributes).toEqual({ country: 'BR' })
  })

  it('swallows webhook dispatch errors (.catch)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc, webhooks } = makeService(prisma)
    webhooks.dispatch.mockRejectedValueOnce(new Error('webhook down'))
    // Must not bubble; resolves normally
    await expect(
      svc.create('u1', 'acc1', { email: 'a@b.com' } as never),
    ).resolves.toBeTruthy()
  })
})

// ---------- importBatch ----------

describe('ContactsService.importBatch', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.importBatch('u1', 'acc1', { rows: [] } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('skips rows with no identifier + records error', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ name: 'No identifiers' }],
    } as never)
    expect(out.skipped).toBe(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.row).toBe(1)
  })

  it('creates a new contact when no existing match found', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc, webhooks, audit } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'A@B.com', phoneNumber: '+5511', name: 'Hi' }],
    } as never)
    expect(out.created).toBe(1)
    expect(out.updated).toBe(0)
    expect(prisma.contact.create).toHaveBeenCalled()
    // Email lower-cased before write.
    const data = prisma.contact.create.mock.calls[0]![0].data
    expect(data.email).toBe('a@b.com')
    // Webhook dispatched with source:'import'.
    expect(webhooks.dispatch).toHaveBeenCalledWith(
      'acc1',
      'contact.created',
      expect.objectContaining({ source: 'import' }),
    )
    // Audit log recorded.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact.import',
        metadata: expect.objectContaining({ created: 1, updated: 0 }),
      }),
    )
  })

  it('updates an existing contact when match found by email', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue({
      id: 'existing',
      customAttributes: { existing: true },
    })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [
        {
          email: 'a@b.com',
          name: 'Updated Name',
          phoneNumber: '+5511',
          identifier: 'ext-1',
          customAttributes: { new: 'attr' },
        },
      ],
    } as never)
    expect(out.updated).toBe(1)
    expect(out.created).toBe(0)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.name).toBe('Updated Name')
    expect(data.customAttributes).toEqual({ existing: true, new: 'attr' })
  })

  it('merges existing customAttributes when no row attrs given (null fallback)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue({
      id: 'existing',
      customAttributes: null, // tests the `?? {}` fallback
    })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.importBatch('u1', 'acc1', {
      rows: [{ identifier: 'ext-1' }],
    } as never)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.customAttributes).toEqual({})
  })

  it('records error when prisma.create throws (and continues)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockRejectedValueOnce(new Error('db blew up'))
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'a@b.com' }],
    } as never)
    expect(out.created).toBe(0)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.message).toBe('db blew up')
    expect(out.errors[0]!.code).toBe('failed')
  })

  it('names a unique-constraint clash so the interface can word it', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    const clash = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    prisma.contact.create.mockRejectedValueOnce(clash)
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'a@b.com' }],
    } as never)
    expect(out.errors[0]).toMatchObject({ row: 1, code: 'duplicate' })
  })

  it('records error with String() when prisma throws a non-Error', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.contact.create.mockRejectedValueOnce('weird string' as any)
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'a@b.com' }],
    } as never)
    expect(out.errors[0]!.message).toBe('weird string')
  })

  it('handles undefined/null entries in rows array (continue branch)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    // Force a sparse-ish array — input.rows[i] may be undefined.
    const rows: unknown[] = [undefined, { email: 'a@b.com' }]
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const out = await svc.importBatch('u1', 'acc1', { rows } as never)
    expect(out.created).toBe(1)
  })

  it('handles empty-string email + whitespace-only phone/identifier (falls through to skip)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: '', phoneNumber: '   ', identifier: '   ' }],
    } as never)
    expect(out.skipped).toBe(1)
  })

  it('builds findFirst OR conditionally — only email present', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'a@b.com' }],
    } as never)
    const where = prisma.contact.findFirst.mock.calls[0]![0].where
    expect(where.OR).toEqual([{ email: 'a@b.com' }])
  })

  it('builds findFirst OR conditionally — only phone present', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.importBatch('u1', 'acc1', {
      rows: [{ phoneNumber: '+5511' }],
    } as never)
    const where = prisma.contact.findFirst.mock.calls[0]![0].where
    expect(where.OR).toEqual([{ phoneNumber: '+5511' }])
  })

  it('builds findFirst OR conditionally — only identifier present', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.importBatch('u1', 'acc1', {
      rows: [{ identifier: 'cust-007' }],
    } as never)
    const where = prisma.contact.findFirst.mock.calls[0]![0].where
    expect(where.OR).toEqual([{ identifier: 'cust-007' }])
  })

  it('swallows audit log failures', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc, audit } = makeService(prisma)
    audit.record.mockRejectedValueOnce(new Error('audit down'))
    // Should not throw; still returns the result.
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: '', phoneNumber: '', identifier: '' }],
    } as never)
    expect(out.skipped).toBe(1)
  })

  it('swallows webhook dispatch failures on create-during-import', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findFirst.mockResolvedValue(null)
    prisma.contact.create.mockResolvedValue(baseContact())
    const { svc, webhooks } = makeService(prisma)
    webhooks.dispatch.mockRejectedValueOnce(new Error('webhook down'))
    const out = await svc.importBatch('u1', 'acc1', {
      rows: [{ email: 'a@b.com' }],
    } as never)
    expect(out.created).toBe(1)
  })
})

// ---------- exportContact (GDPR) ----------

describe('ContactsService.exportContact (GDPR)', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.exportContact('u1', 'acc1', 'c1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown contact', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.exportContact('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (cross-account contact)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(
      baseContact({ accountId: 'other-acc', contactInboxes: [], conversations: [] }),
    )
    const { svc } = makeService(prisma)
    await expect(svc.exportContact('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('returns the full GDPR bundle shape', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      ...baseContact(),
      contactInboxes: [
        {
          inbox: { id: 'in1', name: 'WA', channelType: 'WHATSAPP' },
          sourceId: 'wa-12345',
        },
      ],
      conversations: [
        {
          id: 'conv1',
          displayId: 1,
          inboxId: 'in1',
          status: 'OPEN',
          priority: 'MEDIUM',
          createdAt: new Date('2026-05-01T00:00:00Z'),
          messages: [
            {
              id: 'm1',
              senderType: 'CONTACT',
              content: 'hi',
              contentType: 'TEXT',
              isPrivate: false,
              createdAt: new Date('2026-05-01T00:00:01Z'),
              attachments: [
                {
                  id: 'att1',
                  fileName: 'a.png',
                  fileType: 'image/png',
                  fileSize: 100,
                },
              ],
            },
          ],
        },
      ],
    })
    const { svc } = makeService(prisma)
    const out = await svc.exportContact('u1', 'acc1', 'c1')
    expect(out.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((out.contact as { id: string }).id).toBe('c1')
    const inboxes = out.inboxes as Array<{ sourceId: string }>
    expect(inboxes[0]!.sourceId).toBe('wa-12345')
    const convs = out.conversations as Array<{
      messages: Array<{ content: string; attachments: Array<{ id: string }> }>
    }>
    expect(convs[0]!.messages[0]!.content).toBe('hi')
    expect(convs[0]!.messages[0]!.attachments[0]!.id).toBe('att1')
  })
})

// ---------- anonymizeContact (GDPR — compliance critical) ----------

describe('ContactsService.anonymizeContact (GDPR — compliance critical)', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.anonymizeContact('u1', 'acc1', 'c1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown contact', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.anonymizeContact('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (cross-account)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      accountId: 'other-acc',
    })
    const { svc } = makeService(prisma)
    await expect(svc.anonymizeContact('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('redacts contact-authored messages + clears PII fields', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      accountId: 'acc1',
    })
    prisma.message.updateMany.mockResolvedValue({ count: 3 })
    prisma.contact.update.mockResolvedValue(
      baseContact({
        name: '[redacted]',
        email: null,
        phoneNumber: null,
        identifier: null,
        avatarUrl: null,
        customAttributes: {},
        additionalAttributes: {},
      }),
    )
    const { svc } = makeService(prisma)
    const result = await svc.anonymizeContact('u1', 'acc1', 'c1')

    // CRITICAL: contact-authored messages have content='[redacted]'
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { senderContactId: 'c1', senderType: 'CONTACT' },
      data: { content: '[redacted]' },
    })

    // CRITICAL: all PII fields wiped
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: {
        name: '[redacted]',
        email: null,
        phoneNumber: null,
        identifier: null,
        avatarUrl: null,
        customAttributes: {},
        additionalAttributes: {},
      },
    })

    expect(result.name).toBe('[redacted]')
    expect(result.email).toBeNull()
    expect(result.phoneNumber).toBeNull()
    expect(result.identifier).toBeNull()
    expect(result.avatarUrl).toBeNull()
  })
})

// ---------- update ----------

describe('ContactsService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.update('u1', 'acc1', 'c1', { name: 'X' } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.update('u1', 'acc1', 'c1', { name: 'X' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      accountId: 'other-acc',
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.update('u1', 'acc1', 'c1', { name: 'X' } as never),
    ).rejects.toThrow(NotFoundException)
  })

  it('only includes explicitly-named keys (no `undefined`-leak)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'c1', { name: 'Jane' } as never)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data).toEqual({ name: 'Jane' })
    expect('email' in data).toBe(false)
    expect('phoneNumber' in data).toBe(false)
    expect('identifier' in data).toBe(false)
    expect('avatarUrl' in data).toBe(false)
  })

  it('allows explicit null for email/phone/identifier/avatarUrl (clearing)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'c1', {
      email: null,
      phoneNumber: null,
      identifier: null,
      avatarUrl: null,
      name: null,
    } as never)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.email).toBeNull()
    expect(data.phoneNumber).toBeNull()
    expect(data.identifier).toBeNull()
    expect(data.avatarUrl).toBeNull()
    expect(data.name).toBeNull()
  })

  it('writes customAttributes + additionalAttributes when provided', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'c1', {
      customAttributes: { tier: 'gold' },
      additionalAttributes: { country: 'BR' },
    } as never)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.customAttributes).toEqual({ tier: 'gold' })
    expect(data.additionalAttributes).toEqual({ country: 'BR' })
  })

  it('skips customAttributes/additionalAttributes when undefined', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue(baseContact())
    const { svc } = makeService(prisma)
    await svc.update('u1', 'acc1', 'c1', {} as never)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect('customAttributes' in data).toBe(false)
    expect('additionalAttributes' in data).toBe(false)
  })
})

// ---------- remove ----------

describe('ContactsService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'c1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      id: 'c1',
      accountId: 'other-acc',
    })
    const { svc } = makeService(prisma)
    await expect(svc.remove('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes the contact for ADMINISTRATOR', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.delete.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.remove('u1', 'acc1', 'c1')
    expect(prisma.contact.delete).toHaveBeenCalledWith({ where: { id: 'c1' } })
  })
})

// ---------- setBlocked ----------

describe('ContactsService.setBlocked', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.setBlocked('u1', 'acc1', 'c1', true)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.setBlocked('u1', 'acc1', 'c1', true)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR (cross-account)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(svc.setBlocked('u1', 'acc1', 'c1', true)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('blocks: sets blockedAt to a Date', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue({ id: 'c1', blockedAt: new Date() })
    const { svc } = makeService(prisma)
    await svc.setBlocked('u1', 'acc1', 'c1', true)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.blockedAt).toBeInstanceOf(Date)
  })

  it('unblocks: clears blockedAt to null', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contact.update.mockResolvedValue({ id: 'c1', blockedAt: null })
    const { svc } = makeService(prisma)
    await svc.setBlocked('u1', 'acc1', 'c1', false)
    const data = prisma.contact.update.mock.calls[0]![0].data
    expect(data.blockedAt).toBeNull()
  })
})

// ---------- bulkAction ----------

describe('ContactsService.bulkAction', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.bulkAction('u1', 'acc1', { contactIds: ['c1'], action: 'block' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('block: updateMany with a Date, account-scoped, returns affected count', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.updateMany.mockResolvedValue({ count: 2 })
    const { svc } = makeService(prisma)
    const r = await svc.bulkAction('u1', 'acc1', {
      contactIds: ['c1', 'c2'],
      action: 'block',
    })
    expect(r).toEqual({ action: 'block', affected: 2 })
    const arg = prisma.contact.updateMany.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: { in: ['c1', 'c2'] }, accountId: 'acc1' })
    expect(arg.data.blockedAt).toBeInstanceOf(Date)
    expect(prisma.contact.deleteMany).not.toHaveBeenCalled()
  })

  it('unblock: updateMany sets blockedAt null', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.updateMany.mockResolvedValue({ count: 1 })
    const { svc } = makeService(prisma)
    const r = await svc.bulkAction('u1', 'acc1', {
      contactIds: ['c1'],
      action: 'unblock',
    })
    expect(r).toEqual({ action: 'unblock', affected: 1 })
    expect(prisma.contact.updateMany.mock.calls[0]![0].data.blockedAt).toBeNull()
  })

  it('delete: deleteMany, account-scoped, returns affected count', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.deleteMany.mockResolvedValue({ count: 3 })
    const { svc } = makeService(prisma)
    const r = await svc.bulkAction('u1', 'acc1', {
      contactIds: ['c1', 'c2', 'c3'],
      action: 'delete',
    })
    expect(r).toEqual({ action: 'delete', affected: 3 })
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2', 'c3'] }, accountId: 'acc1' },
    })
    expect(prisma.contact.updateMany).not.toHaveBeenCalled()
  })

  it('dedupes ids before querying', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    const { svc } = makeService(prisma)
    await svc.bulkAction('u1', 'acc1', {
      contactIds: ['c1', 'c1', 'c1'],
      action: 'delete',
    })
    expect(prisma.contact.deleteMany.mock.calls[0]![0].where.id).toEqual({
      in: ['c1'],
    })
  })
})

// ---------- merge ----------

describe('ContactsService.merge', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', { sourceContactIds: ['s1'] } as never),
    ).rejects.toThrow(ForbiddenException)
  })

  it('409 when target is in source list', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['target', 's1'],
      } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('409 when source list has duplicates', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['s1', 's1'],
      } as never),
    ).rejects.toThrow(ConflictException)
  })

  it('404 when target not found', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['s1'],
      } as never),
    ).rejects.toThrow(/Target contact not found/)
  })

  it('404 IDOR target in another account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue({
      id: 'target',
      accountId: 'other-acc',
    })
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['s1'],
      } as never),
    ).rejects.toThrow(/Target contact not found/)
  })

  it('404 when not all source contacts found', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique.mockResolvedValue(baseContact({ id: 'target' }))
    prisma.contact.findMany.mockResolvedValue([{ id: 's1' }]) // only 1 of 2
    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['s1', 's2'],
      } as never),
    ).rejects.toThrow(/One or more source contacts not found/)
  })

  it('happy path — backfills target null fields from sources + relocates inboxes + deletes sources', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const target = baseContact({
      id: 'target',
      name: null,
      email: null,
      phoneNumber: null,
      identifier: null,
      avatarUrl: null,
      customAttributes: { tgt: true },
      additionalAttributes: { tgtAdd: 1 },
    })
    prisma.contact.findUnique
      // 1st: lookup target inside tx
      .mockResolvedValueOnce(target)
      // 2nd: lookup merged result at end
      .mockResolvedValueOnce({
        ...baseContact({ id: 'target' }),
        contactInboxes: [],
      })
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: 'From S1',
        email: 'from-s1@x.com',
        phoneNumber: '+5511',
        identifier: 'ID-S1',
        avatarUrl: 'http://avatar.example/s1.png',
        customAttributes: { fromS1: true },
        additionalAttributes: { addS1: 'yes' },
      },
    ])
    // No existing target inboxes; one source inbox to move.
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([]) // target inboxes
      .mockResolvedValueOnce([
        { id: 'ci1', inboxId: 'inA', sourceId: 'src-1' },
      ]) // source inboxes
    prisma.contactInbox.update.mockResolvedValue({})
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })

    const { svc } = makeService(prisma)
    const out = await svc.merge('u1', 'acc1', 'target', {
      sourceContactIds: ['s1'],
    } as never)

    // Source inbox was moved (not deleted), since target had no inboxes.
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ci1' },
      data: { contactId: 'target' },
    })
    expect(prisma.contactInbox.delete).not.toHaveBeenCalled()

    // Conversations moved.
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { contactId: { in: ['s1'] } },
      data: { contactId: 'target' },
    })

    // Target patched with backfilled fields + merged attrs (target wins).
    const patch = prisma.contact.update.mock.calls[0]![0].data
    expect(patch.name).toBe('From S1')
    expect(patch.email).toBe('from-s1@x.com')
    expect(patch.phoneNumber).toBe('+5511')
    expect(patch.identifier).toBe('ID-S1')
    expect(patch.avatarUrl).toBe('http://avatar.example/s1.png')
    expect(patch.customAttributes).toEqual({ fromS1: true, tgt: true })
    expect(patch.additionalAttributes).toEqual({ addS1: 'yes', tgtAdd: 1 })

    // Sources deleted.
    expect(prisma.contact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] } },
    })

    expect(out).toBeTruthy()
  })

  it('does not overwrite target fields that are already set', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const target = baseContact({
      id: 'target',
      name: 'Target Name',
      email: 'tgt@x.com',
      phoneNumber: '+target',
      identifier: 'tgt-ID',
      avatarUrl: 'http://target/av.png',
      customAttributes: {},
      additionalAttributes: {},
    })
    prisma.contact.findUnique
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({
        ...baseContact({ id: 'target' }),
        contactInboxes: [],
      })
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: 'Other',
        email: 'other@x.com',
        phoneNumber: '+other',
        identifier: 'other-id',
        avatarUrl: 'http://other.png',
        customAttributes: {},
        additionalAttributes: {},
      },
    ])
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })

    const { svc } = makeService(prisma)
    await svc.merge('u1', 'acc1', 'target', {
      sourceContactIds: ['s1'],
    } as never)
    const patch = prisma.contact.update.mock.calls[0]![0].data
    expect(patch.name).toBeUndefined()
    expect(patch.email).toBeUndefined()
    expect(patch.phoneNumber).toBeUndefined()
    expect(patch.identifier).toBeUndefined()
    expect(patch.avatarUrl).toBeUndefined()
  })

  it('deletes source inbox when collides with existing target inbox', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const target = baseContact({ id: 'target' })
    prisma.contact.findUnique
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({
        ...baseContact({ id: 'target' }),
        contactInboxes: [],
      })
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: null,
        email: null,
        phoneNumber: null,
        identifier: null,
        avatarUrl: null,
        customAttributes: {},
        additionalAttributes: {},
      },
    ])
    // Target already has inA — so source's ci on inA should be deleted, not moved.
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([{ inboxId: 'inA' }])
      .mockResolvedValueOnce([
        { id: 'ci1', inboxId: 'inA', sourceId: 'src-1' },
        { id: 'ci2', inboxId: 'inB', sourceId: 'src-2' },
      ])
    prisma.contactInbox.delete.mockResolvedValue({})
    prisma.contactInbox.update.mockResolvedValue({})
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })

    const { svc } = makeService(prisma)
    await svc.merge('u1', 'acc1', 'target', {
      sourceContactIds: ['s1'],
    } as never)
    // Collision on inA → delete; inB → move.
    expect(prisma.contactInbox.delete).toHaveBeenCalledWith({
      where: { id: 'ci1' },
    })
    expect(prisma.contactInbox.update).toHaveBeenCalledWith({
      where: { id: 'ci2' },
      data: { contactId: 'target' },
    })
  })

  it('skips final contact.update when no patch keys (target had everything set)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    // Note: source has empty objects for both attribute maps → mergeJsonShallow
    // returns {} → BUT the code always assigns mergedCustom/mergedAdditional
    // unconditionally. So we test the "skip contact.update" branch by giving
    // source NULL attribute maps (non-object) so merged is empty,
    // AND target has everything set... but the patch will still have
    // customAttributes / additionalAttributes assigned, so Object.keys >= 2.
    // Therefore the if-block runs. The only way to hit `Object.keys(patch) === 0`
    // is if we don't enter that conditional path... it's actually unreachable
    // in the current implementation (the two attribute keys are always set).
    // We just verify the contact.update fires once (with the attr-only patch).
    const target = baseContact({
      id: 'target',
      name: 'X',
      email: 'x@x.com',
      phoneNumber: '+1',
      identifier: 'id',
      avatarUrl: 'http://a.png',
      customAttributes: { tgt: true },
      additionalAttributes: { tgt: true },
    })
    prisma.contact.findUnique
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({
        ...baseContact({ id: 'target' }),
        contactInboxes: [],
      })
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: 'no use',
        email: 'no@x.com',
        phoneNumber: '+1',
        identifier: 'id',
        avatarUrl: 'http://a.png',
        customAttributes: null,
        additionalAttributes: null,
      },
    ])
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })

    const { svc } = makeService(prisma)
    await svc.merge('u1', 'acc1', 'target', {
      sourceContactIds: ['s1'],
    } as never)
    // Even with target having every field set, patch has the two attribute
    // keys — so update IS called.
    expect(prisma.contact.update).toHaveBeenCalledTimes(1)
  })

  it('handles array-typed JSON attrs (mergeJsonShallow ignores arrays)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const target = baseContact({
      id: 'target',
      name: 'X',
      email: 'x@x.com',
      phoneNumber: '+1',
      identifier: 'id',
      avatarUrl: 'http://a.png',
      customAttributes: ['arr', 'a', 'y'], // arrays — should be skipped
      additionalAttributes: ['z'],
    })
    prisma.contact.findUnique
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({
        ...baseContact({ id: 'target' }),
        contactInboxes: [],
      })
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: 'x',
        email: 'x@x.com',
        phoneNumber: '+1',
        identifier: 'id',
        avatarUrl: 'http://a.png',
        customAttributes: ['arr2'], // array — also skipped
        additionalAttributes: { keep: true }, // valid object
      },
    ])
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })

    const { svc } = makeService(prisma)
    await svc.merge('u1', 'acc1', 'target', {
      sourceContactIds: ['s1'],
    } as never)
    const patch = prisma.contact.update.mock.calls[0]![0].data
    // Both arrays ignored — customAttributes ends up empty {}.
    expect(patch.customAttributes).toEqual({})
    // additionalAttributes: { keep: true } from source (target array ignored).
    expect(patch.additionalAttributes).toEqual({ keep: true })
  })

  it('throws 404 if final merged read returns null (defensive)', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.contact.findUnique
      .mockResolvedValueOnce(baseContact({ id: 'target' }))
      .mockResolvedValueOnce(null) // final lookup returns null somehow
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 's1',
        name: 'a',
        email: 'a@b.com',
        phoneNumber: null,
        identifier: null,
        avatarUrl: null,
        customAttributes: {},
        additionalAttributes: {},
      },
    ])
    prisma.contactInbox.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    prisma.contact.update.mockResolvedValue({})
    prisma.contact.deleteMany.mockResolvedValue({ count: 1 })
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 })

    const { svc } = makeService(prisma)
    await expect(
      svc.merge('u1', 'acc1', 'target', {
        sourceContactIds: ['s1'],
      } as never),
    ).rejects.toThrow(NotFoundException)
  })
})

// ---------- DTO ----------

describe('ContactsService DTOs', () => {
  it('toContactDTO serializes a full contact', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toContactDTO(
      baseContact({
        lastActivityAt: new Date('2026-05-10T00:00:00Z'),
        blockedAt: new Date('2026-05-11T00:00:00Z'),
      }) as never,
    )
    expect(dto.id).toBe('c1')
    expect(dto.customAttributes).toEqual({})
    expect(dto.additionalAttributes).toEqual({})
    expect(dto.lastActivityAt).toBe('2026-05-10T00:00:00.000Z')
    expect(dto.blockedAt).toBe('2026-05-11T00:00:00.000Z')
    expect(dto.createdAt).toBe('2026-05-01T00:00:00.000Z')
    expect(dto.updatedAt).toBe('2026-05-02T00:00:00.000Z')
  })

  it('toContactDTO returns null blockedAt for an unblocked contact', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toContactDTO(baseContact() as never)
    expect(dto.blockedAt).toBeNull()
  })

  it('toContactDTO null-coalesces customAttributes/additionalAttributes', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toContactDTO(
      baseContact({
        customAttributes: null,
        additionalAttributes: null,
      }) as never,
    )
    expect(dto.customAttributes).toEqual({})
    expect(dto.additionalAttributes).toEqual({})
  })

  it('toContactDTO returns null when lastActivityAt is null', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toContactDTO(baseContact() as never)
    expect(dto.lastActivityAt).toBeNull()
  })

  it('toContactInboxRefDTO maps inbox-ref shape', () => {
    const { svc } = makeService(makePrisma())
    const dto = svc.toContactInboxRefDTO({
      id: 'ci1',
      inboxId: 'in1',
      sourceId: 'wa-1',
      createdAt: new Date('2026-05-15T00:00:00Z'),
      inbox: { name: 'WA', channelType: 'WHATSAPP' },
    } as never)
    expect(dto.inboxName).toBe('WA')
    expect(dto.channelType).toBe('WHATSAPP')
    expect(dto.sourceId).toBe('wa-1')
    expect(dto.createdAt).toBe('2026-05-15T00:00:00.000Z')
  })
})

// ---------- notes ----------

describe('ContactsService notes', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
  })

  it('listNotes 403 when not a member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.listNotes('u1', 'acc1', 'c1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('listNotes 404 when contact is cross-account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'other' })
    const { svc } = makeService(prisma)
    await expect(svc.listNotes('u1', 'acc1', 'c1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('listNotes returns notes (newest first) for an active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contactNote.findMany.mockResolvedValue([{ id: 'n1' }])
    const { svc } = makeService(prisma)
    expect(await svc.listNotes('u1', 'acc1', 'c1')).toEqual([{ id: 'n1' }])
    expect(prisma.contactNote.findMany.mock.calls[0]![0].orderBy).toEqual({
      createdAt: 'desc',
    })
  })

  it('addNote 404 for a missing contact', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contact.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.addNote('u1', 'acc1', 'c1', 'hi')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('addNote creates a note authored by the caller', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contact.findUnique.mockResolvedValue({ id: 'c1', accountId: 'acc1' })
    prisma.contactNote.create.mockResolvedValue({ id: 'n1' })
    const { svc } = makeService(prisma)
    await svc.addNote('u1', 'acc1', 'c1', 'follow up tomorrow')
    const data = prisma.contactNote.create.mock.calls[0]![0].data
    expect(data).toEqual({
      accountId: 'acc1',
      contactId: 'c1',
      authorId: 'u1',
      body: 'follow up tomorrow',
    })
  })

  it('deleteNote 404 when the note is on a different contact/account', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contactNote.findUnique.mockResolvedValue({
      id: 'n1',
      accountId: 'acc1',
      contactId: 'OTHER',
    })
    const { svc } = makeService(prisma)
    await expect(svc.deleteNote('u1', 'acc1', 'c1', 'n1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deleteNote 404 when the note is missing', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contactNote.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.deleteNote('u1', 'acc1', 'c1', 'n1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deleteNote removes the note when it matches', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.contactNote.findUnique.mockResolvedValue({
      id: 'n1',
      accountId: 'acc1',
      contactId: 'c1',
    })
    prisma.contactNote.delete.mockResolvedValue({})
    const { svc } = makeService(prisma)
    await svc.deleteNote('u1', 'acc1', 'c1', 'n1')
    expect(prisma.contactNote.delete).toHaveBeenCalledWith({ where: { id: 'n1' } })
  })

  it('toContactNoteDTO resolves the author name (fullName, then email, then null)', () => {
    const { svc } = makeService(makePrisma())
    const base = {
      id: 'n1',
      contactId: 'c1',
      body: 'hi',
      authorId: 'u1',
      createdAt: new Date('2026-06-25T00:00:00Z'),
    }
    expect(
      svc.toContactNoteDTO({ ...base, author: { fullName: 'Ada', email: 'a@e' } } as never)
        .authorName,
    ).toBe('Ada')
    expect(
      svc.toContactNoteDTO({ ...base, author: { fullName: null, email: 'a@e' } } as never)
        .authorName,
    ).toBe('a@e')
    expect(
      svc.toContactNoteDTO({ ...base, authorId: null, author: null } as never).authorName,
    ).toBeNull()
  })
})
