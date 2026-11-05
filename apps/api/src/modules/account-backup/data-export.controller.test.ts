import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { DataExportController, DataExportDownloadController } from './data-export.controller'
import { ExportTicketsService } from './export-tickets.service'

const auth = { user: { id: 'u1' } } as never

function setup() {
  const svc = { assertCanExport: vi.fn().mockResolvedValue(undefined), file: vi.fn().mockReturnValue('FILE') }
  const tickets = { issue: vi.fn().mockResolvedValue('tkt'), redeem: vi.fn() }
  const audit = { record: vi.fn().mockResolvedValue({}) }
  return {
    svc,
    tickets,
    audit,
    ctl: new DataExportController(svc as never, tickets as never, audit as never),
    dl: new DataExportDownloadController(svc as never, tickets as never),
  }
}

describe('DataExportController', () => {
  it('issues a one-time link after checking the role and auditing', async () => {
    const s = setup()
    const out = await s.ctl.ticket(auth, 'acc1', 'conversations', { format: 'json', from: '2026-10-01T00:00:00Z' })
    expect(out).toEqual({ url: '/exports/download/tkt' })
    expect(s.svc.assertCanExport).toHaveBeenCalledWith('u1', 'acc1')
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'data.export',
        metadata: { kind: 'conversations', format: 'json', from: '2026-10-01T00:00:00Z', to: null },
      }),
    )
    expect(s.tickets.issue).toHaveBeenCalledWith({
      accountId: 'acc1',
      userId: 'u1',
      kind: 'conversations',
      format: 'json',
      from: '2026-10-01T00:00:00Z',
      to: undefined,
    })
  })

  it('refuses before auditing or issuing when the role check fails', async () => {
    const s = setup()
    s.svc.assertCanExport.mockRejectedValue(new Error('forbidden'))
    await expect(s.ctl.ticket(auth, 'acc1', 'contacts', { format: 'csv' })).rejects.toThrow('forbidden')
    expect(s.audit.record).not.toHaveBeenCalled()
    expect(s.tickets.issue).not.toHaveBeenCalled()
  })

  it('streams directly for bearer clients', async () => {
    const s = setup()
    expect(await s.ctl.download(auth, 'acc1', 'contacts', { format: 'csv' })).toBe('FILE')
  })

  it('redeems a ticket, re-checks the role, and 404s a used or unknown one', async () => {
    const s = setup()
    const t = { accountId: 'acc1', userId: 'u1', kind: 'contacts', format: 'csv' }
    s.tickets.redeem.mockResolvedValueOnce(t).mockResolvedValueOnce(null)
    expect(await s.dl.download('tkt')).toBe('FILE')
    expect(s.svc.assertCanExport).toHaveBeenCalledWith('u1', 'acc1')
    expect(s.svc.file).toHaveBeenCalledWith(t)
    await expect(s.dl.download('tkt')).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('ExportTicketsService', () => {
  function withFakeRedis() {
    const store = new Map<string, string>()
    const redis = {
      set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
      getdel: vi.fn(async (k: string) => {
        const v = store.get(k) ?? null
        store.delete(k)
        return v
      }),
    }
    const svc = new ExportTicketsService({ get: () => undefined } as never)
    ;(svc as unknown as { redis: unknown }).redis = redis
    return { svc, redis }
  }

  it('stores the ticket with a short expiry and hands it out exactly once', async () => {
    const { svc, redis } = withFakeRedis()
    const ticket = { accountId: 'a', userId: 'u', kind: 'contacts' as const, format: 'csv' as const }
    const id = await svc.issue(ticket)
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(redis.set).toHaveBeenCalledWith(`export-ticket:${id}`, JSON.stringify(ticket), 'EX', 120)
    expect(await svc.redeem(id)).toEqual(ticket)
    expect(await svc.redeem(id)).toBeNull()
  })

  it('rejects malformed ids without touching Redis', async () => {
    const { svc, redis } = withFakeRedis()
    expect(await svc.redeem('../../etc')).toBeNull()
    expect(redis.getdel).not.toHaveBeenCalled()
  })
})
