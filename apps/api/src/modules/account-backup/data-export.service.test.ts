import { ForbiddenException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DataExportService, csvCell } from './data-export.service'

const d = (s: string) => new Date(s)

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const c of gen) out += c
  return out
}

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    contact: { findMany: vi.fn() },
    conversation: { findMany: vi.fn() },
    message: { findMany: vi.fn() },
  }
}

const contact = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Ana, da Silva',
  email: 'ana@x.com',
  phoneNumber: '+5511999990000',
  identifier: null,
  customAttributes: { plano: 'ouro' },
  createdAt: d('2026-10-01T10:00:00Z'),
  updatedAt: d('2026-10-02T10:00:00Z'),
  ...extra,
})

const conversation = (id: string) => ({
  id,
  displayId: 7,
  status: 'RESOLVED',
  priority: 'NORMAL',
  inbox: { id: 'in1', name: 'WhatsApp', channelType: 'WHATSAPP' },
  contact: { id: 'ct1', name: 'Ana', email: null, phoneNumber: '+5511' },
  assignee: { id: 'u1', fullName: 'Bruno', email: 'b@x.com' },
  team: { id: 't1', name: 'Financeiro' },
  createdAt: d('2026-10-01T10:00:00Z'),
  resolvedAt: d('2026-10-01T11:00:00Z'),
})

describe('csvCell', () => {
  it('quotes separators, quotes and newlines; serialises dates and objects', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(d('2026-10-01T00:00:00Z'))).toBe('2026-10-01T00:00:00.000Z')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell(42)).toBe('42')
  })

  it('defuses spreadsheet formulas typed by customers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+5511999')).toBe("'+5511999")
    expect(csvCell('@sum')).toBe("'@sum")
  })
})

describe('DataExportService', () => {
  let prisma: ReturnType<typeof makePrisma>
  let svc: DataExportService
  beforeEach(() => {
    prisma = makePrisma()
    svc = new DataExportService(prisma as never)
  })

  it('lets admins and supervisors export, not agents', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ isActive: true, role: 'SUPERVISOR' })
    await expect(svc.assertCanExport('u1', 'acc1')).resolves.toBeUndefined()
    prisma.accountMember.findUnique.mockResolvedValue({ isActive: true, role: 'AGENT' })
    await expect(svc.assertCanExport('u1', 'acc1')).rejects.toBeInstanceOf(ForbiddenException)
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(svc.assertCanExport('u1', 'acc1')).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('contacts CSV: BOM, Portuguese header, one escaped row per contact, period filter', async () => {
    prisma.contact.findMany.mockResolvedValue([contact('c1')])
    const csv = await collect(
      svc.contacts('acc1', 'csv', { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }),
    )
    expect(csv.startsWith('\uFEFFid,nome,email,telefone')).toBe(true)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"Ana, da Silva"')
    expect(lines[1]).toContain("'+5511999990000")
    expect(prisma.contact.findMany.mock.calls[0]![0].where).toEqual({
      accountId: 'acc1',
      createdAt: { gte: d('2026-10-01T00:00:00Z'), lt: d('2026-11-01T00:00:00Z') },
    })
  })

  it('contacts JSON is one valid array across pages', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => contact(`c${i}`))
    prisma.contact.findMany.mockResolvedValueOnce(page1).mockResolvedValueOnce([contact('last')])
    const json = JSON.parse(await collect(svc.contacts('acc1', 'json', {})))
    expect(json).toHaveLength(501)
    expect(json[500]).toMatchObject({ id: 'last', createdAt: '2026-10-01T10:00:00.000Z' })
    expect(prisma.contact.findMany.mock.calls[1]![0]).toMatchObject({ cursor: { id: 'c499' }, skip: 1 })
  })

  it('empty export is still a valid document', async () => {
    prisma.contact.findMany.mockResolvedValue([])
    expect(JSON.parse(await collect(svc.contacts('acc1', 'json', {})))).toEqual([])
  })

  it('conversations CSV: one row per message with the conversation columns, and a row for an empty conversation', async () => {
    prisma.conversation.findMany.mockResolvedValue([conversation('cv1'), conversation('cv2')])
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'm1',
        conversationId: 'cv1',
        senderType: 'CONTACT',
        content: 'Olá',
        contentType: 'TEXT',
        status: 'SENT',
        isPrivate: false,
        createdAt: d('2026-10-01T10:01:00Z'),
        senderUser: null,
        attachments: [],
      },
      {
        id: 'm2',
        conversationId: 'cv1',
        senderType: 'USER',
        content: 'nota',
        contentType: 'TEXT',
        status: 'SENT',
        isPrivate: true,
        createdAt: d('2026-10-01T10:02:00Z'),
        senderUser: { id: 'u1', fullName: 'Bruno' },
        attachments: [{ fileType: 'FILE', fileUrl: 'https://f/x.pdf', fileName: 'x.pdf', mimeType: 'application/pdf' }],
      },
    ])
    const csv = await collect(svc.conversations('acc1', 'csv', {}))
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines).toHaveLength(4) // header + 2 messages + empty cv2
    const header = lines[0]!.split(',')
    expect(header).toHaveLength(21)
    expect(lines.every((l) => l.split(',').length === 21)).toBe(true)
    expect(lines[1]).toContain('cv1,7,RESOLVED,WhatsApp,WHATSAPP')
    expect(lines[1]).toContain('CONTACT,Ana,não,TEXT,Olá,')
    expect(lines[2]).toContain('USER,Bruno,sim,TEXT,nota,https://f/x.pdf')
    expect(lines[3]!.startsWith('cv2,')).toBe(true)
    expect(prisma.message.findMany.mock.calls[0]![0].where).toEqual({ conversationId: { in: ['cv1', 'cv2'] } })
  })

  it('conversations JSON nests the messages under each conversation', async () => {
    prisma.conversation.findMany.mockResolvedValue([conversation('cv1')])
    prisma.message.findMany.mockResolvedValue([])
    const json = JSON.parse(await collect(svc.conversations('acc1', 'json', {})))
    expect(json).toEqual([
      expect.objectContaining({ id: 'cv1', displayId: 7, team: { id: 't1', name: 'Financeiro' }, messages: [] }),
    ])
  })
})

describe('DataExportService.file', () => {
  it('names the attachment and sets the content type per format', () => {
    const svc = new DataExportService(makePrisma() as never)
    const f = svc.file({ accountId: 'acc1', kind: 'conversations', format: 'json' })
    const headers = f.getHeaders()
    expect(headers.type).toBe('application/json; charset=utf-8')
    expect(headers.disposition).toMatch(/^attachment; filename="conversas-\d{4}-\d{2}-\d{2}\.json"$/)
  })
})
