import { describe, expect, it, vi } from 'vitest'
import { ForbiddenException, NotFoundException } from '@nestjs/common'

import { AccountBackupService } from './account-backup.service'

function makePrisma() {
  const table = () => ({ findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) })
  return {
    accountMember: { findUnique: vi.fn() },
    account: { findUnique: vi.fn() },
    contact: table(),
    conversation: table(),
    message: table(),
    attachment: table(),
    supportTicket: table(),
    article: table(),
    accountProfile: { findUnique: vi.fn().mockResolvedValue(null) },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const svc = (p: Prisma) => new AccountBackupService(p as never)

const ACCOUNT = {
  id: 'acc1', name: 'CosmoBots', slug: 'cosmo',
  createdAt: new Date('2026-01-01T00:00:00Z'),
}

async function collect(gen: AsyncGenerator<string>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const l of gen) out.push(JSON.parse(l))
  return out
}

describe('AccountBackupService.assertAdmin', () => {
  it('allows an active administrator', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue({ role: 'ADMINISTRATOR', isActive: true })
    await expect(svc(p).assertAdmin('u1', 'acc1')).resolves.toBeUndefined()
  })

  it('refuses supervisors and agents — a backup is every customer message', async () => {
    const p = makePrisma()
    for (const role of ['SUPERVISOR', 'AGENT']) {
      p.accountMember.findUnique.mockResolvedValue({ role, isActive: true })
      await expect(svc(p).assertAdmin('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    }
  })

  it('refuses a non-member and a deactivated admin', async () => {
    const p = makePrisma()
    p.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc(p).assertAdmin('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    p.accountMember.findUnique.mockResolvedValue({ role: 'ADMINISTRATOR', isActive: false })
    await expect(svc(p).assertAdmin('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })
})

describe('AccountBackupService.stream', () => {
  it('includes the welcome-flow profile, or the export is not a full copy', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.accountProfile.findUnique.mockResolvedValue({
      id: 'p1',
      accountId: 'acc1',
      businessIndustry: 'healthcare',
      channelsToday: ['whatsapp'],
      startedAt: new Date('2026-09-18T10:00:00Z'),
    })
    const lines = await collect(svc(p).stream('acc1', '2026-09-18T00:00:00.000Z'))
    expect(lines[1]).toEqual({
      type: 'account_profile',
      data: {
        id: 'p1',
        accountId: 'acc1',
        businessIndustry: 'healthcare',
        channelsToday: ['whatsapp'],
        startedAt: '2026-09-18T10:00:00.000Z',
      },
    })
  })

  it('emits no profile line for an account that never started the flow', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    const lines = await collect(svc(p).stream('acc1', '2026-09-18T00:00:00.000Z'))
    expect(lines.some((l) => (l as { type: string }).type === 'account_profile')).toBe(
      false,
    )
  })

  it('leads with a manifest carrying counts, so a truncated file is detectable', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.message.count.mockResolvedValue(370_000)
    const lines = await collect(svc(p).stream('acc1', '2026-08-07T00:00:00.000Z'))
    expect(lines[0]).toMatchObject({
      type: 'manifest',
      version: 1,
      generatedAt: '2026-08-07T00:00:00.000Z',
      account: { id: 'acc1', createdAt: '2026-01-01T00:00:00.000Z' },
      counts: { messages: 370_000 },
    })
  })

  it('404s for an account that does not exist', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(null)
    await expect(collect(svc(p).stream('nope', 'now'))).rejects.toThrow(NotFoundException)
  })

  it('emits one line per row, tagged by type', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.contact.findMany.mockResolvedValue([{ id: 'ct1', name: 'Ana' }])
    p.message.findMany.mockResolvedValue([{ id: 'm1', content: 'oi' }])
    const lines = await collect(svc(p).stream('acc1', 'now'))
    expect(lines).toContainEqual({ type: 'contact', data: { id: 'ct1', name: 'Ana' } })
    expect(lines).toContainEqual({ type: 'message', data: { id: 'm1', content: 'oi' } })
  })

  it('serialises dates as ISO so the export is portable', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.message.findMany.mockResolvedValue([
      { id: 'm1', createdAt: new Date('2026-08-06T10:00:00Z') },
    ])
    const lines = await collect(svc(p).stream('acc1', 'now'))
    expect(lines).toContainEqual({
      type: 'message',
      data: { id: 'm1', createdAt: '2026-08-06T10:00:00.000Z' },
    })
  })

  it('pages with a stable id cursor rather than an offset', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    const first = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` }))
    p.message.findMany
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([{ id: 'm500' }])
    await collect(svc(p).stream('acc1', 'now'))
    const second = p.message.findMany.mock.calls[1][0]
    // Cursor + skip:1, never `skip: n` — rows written mid-export would
    // otherwise be skipped or duplicated.
    expect(second.cursor).toEqual({ id: 'm499' })
    expect(second.skip).toBe(1)
    expect(second.orderBy).toEqual({ id: 'asc' })
  })

  it('stops paging as soon as a short page comes back', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.message.findMany.mockResolvedValueOnce([{ id: 'm1' }])
    await collect(svc(p).stream('acc1', 'now'))
    expect(p.message.findMany).toHaveBeenCalledTimes(1)
  })

  it('never exports article embeddings', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    p.article.findMany.mockResolvedValue([{ id: 'a1', title: 't' }])
    await collect(svc(p).stream('acc1', 'now'))
    const sel = p.article.findMany.mock.calls[0][0].select
    // 1536 floats per article, derived and regenerable — excluded on purpose.
    expect(sel.embedding).toBeUndefined()
    expect(sel.content).toBe(true)
  })

  it('scopes every table to the account', async () => {
    const p = makePrisma()
    p.account.findUnique.mockResolvedValue(ACCOUNT)
    await collect(svc(p).stream('acc1', 'now'))
    for (const t of [p.contact, p.conversation, p.message, p.attachment, p.supportTicket, p.article]) {
      expect(t.findMany.mock.calls[0][0].where).toEqual({ accountId: 'acc1' })
    }
  })
})
