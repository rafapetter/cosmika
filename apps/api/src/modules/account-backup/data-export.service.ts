import { Readable } from 'node:stream'

import { ForbiddenException, Injectable, StreamableFile } from '@nestjs/common'
import type { Prisma } from '@cosmika/db'
import type { DataExportFormat } from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { PrismaService } from '../../prisma/prisma.service'

const PAGE = 500

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' } as const

type Period = { from?: string; to?: string }

function createdIn(p: Period): { createdAt?: Prisma.DateTimeFilter } {
  if (!p.from && !p.to) return {}
  return {
    createdAt: {
      ...(p.from ? { gte: new Date(p.from) } : {}),
      ...(p.to ? { lt: new Date(p.to) } : {}),
    },
  }
}

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas: a cell
 * starting with = + - @ (or a tab/CR) is evaluated by Excel/Sheets, and these
 * cells hold text customers typed.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const csvRow = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`
/** Excel opens UTF-8 CSV as Latin-1 without a BOM: accents break. */
const BOM = '\uFEFF'

const CONTACT_COLUMNS = [
  'id',
  'nome',
  'email',
  'telefone',
  'identificador',
  'atributos',
  'criado_em',
  'atualizado_em',
] as const

const MESSAGE_COLUMNS = [
  'conversa_id',
  'conversa_numero',
  'conversa_status',
  'canal',
  'tipo_canal',
  'contato_id',
  'contato_nome',
  'contato_telefone',
  'contato_email',
  'responsavel',
  'time',
  'conversa_criada_em',
  'conversa_encerrada_em',
  'mensagem_id',
  'mensagem_criada_em',
  'remetente_tipo',
  'remetente_nome',
  'nota_interna',
  'tipo_conteudo',
  'conteudo',
  'anexos',
] as const

const conversationInclude = {
  inbox: { select: { id: true, name: true, channelType: true } },
  contact: { select: { id: true, name: true, email: true, phoneNumber: true } },
  assignee: { select: { id: true, fullName: true, email: true } },
  team: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude

const messageSelect = {
  id: true,
  conversationId: true,
  senderType: true,
  content: true,
  contentType: true,
  status: true,
  isPrivate: true,
  createdAt: true,
  senderUser: { select: { id: true, fullName: true } },
  attachments: { select: { fileType: true, fileUrl: true, fileName: true, mimeType: true } },
} satisfies Prisma.MessageSelect

/**
 * Interface-driven export (PoC item 15): contacts, and conversations with
 * their messages, as CSV or JSON. Streams in pages like the account backup,
 * so a large account never sits in memory; unlike the backup it is shaped
 * for people (Portuguese CSV headers, names instead of ids).
 */
@Injectable()
export class DataExportService {
  constructor(private readonly prisma: PrismaService) {}

  async assertCanExport(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR' && m.role !== 'SUPERVISOR') {
      throw new ForbiddenException(errBody('supervisor_required', 'Supervisor or admin required'))
    }
  }

  /** The whole export as a streamed attachment, named for the person saving it. */
  file(t: {
    accountId: string
    kind: 'contacts' | 'conversations'
    format: DataExportFormat
    from?: string
    to?: string
  }): StreamableFile {
    const period = { from: t.from, to: t.to }
    const chunks =
      t.kind === 'contacts'
        ? this.contacts(t.accountId, t.format, period)
        : this.conversations(t.accountId, t.format, period)
    const day = new Date().toISOString().slice(0, 10)
    const name = t.kind === 'contacts' ? 'contatos' : 'conversas'
    return new StreamableFile(Readable.from(chunks), {
      type: CONTENT_TYPES[t.format],
      disposition: `attachment; filename="${name}-${day}.${t.format}"`,
    })
  }

  async *contacts(accountId: string, format: DataExportFormat, period: Period): AsyncGenerator<string> {
    let first = true
    yield format === 'csv' ? BOM + csvRow([...CONTACT_COLUMNS]) : '[\n'
    let cursor: string | undefined
    for (;;) {
      const rows = await this.prisma.contact.findMany({
        where: { accountId, ...createdIn(period) },
        select: {
          id: true,
          name: true,
          email: true,
          phoneNumber: true,
          identifier: true,
          customAttributes: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      for (const c of rows) {
        if (format === 'csv') {
          yield csvRow([c.id, c.name, c.email, c.phoneNumber, c.identifier, c.customAttributes, c.createdAt, c.updatedAt])
        } else {
          yield `${first ? '' : ',\n'}${JSON.stringify({
            ...c,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })}`
          first = false
        }
      }
      if (rows.length < PAGE) break
      cursor = rows[rows.length - 1]!.id
    }
    if (format === 'json') yield '\n]\n'
  }

  async *conversations(
    accountId: string,
    format: DataExportFormat,
    period: Period,
  ): AsyncGenerator<string> {
    let first = true
    yield format === 'csv' ? BOM + csvRow([...MESSAGE_COLUMNS]) : '[\n'
    let cursor: string | undefined
    for (;;) {
      // Fewer conversations per page than contacts: each drags its messages.
      const convs = await this.prisma.conversation.findMany({
        where: { accountId, ...createdIn(period) },
        include: conversationInclude,
        orderBy: { id: 'asc' },
        take: PAGE / 5,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      if (convs.length === 0) break
      const messages = await this.prisma.message.findMany({
        where: { conversationId: { in: convs.map((c) => c.id) } },
        select: messageSelect,
        orderBy: [{ conversationId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      })
      const byConv = new Map<string, typeof messages>()
      for (const m of messages) {
        const list = byConv.get(m.conversationId) ?? []
        list.push(m)
        byConv.set(m.conversationId, list)
      }
      for (const c of convs) {
        const msgs = byConv.get(c.id) ?? []
        const senderName = (m: (typeof msgs)[number]) =>
          m.senderType === 'USER'
            ? (m.senderUser?.fullName ?? null)
            : m.senderType === 'CONTACT'
              ? c.contact.name
              : null
        if (format === 'csv') {
          const base = [
            c.id,
            c.displayId,
            c.status,
            c.inbox.name,
            c.inbox.channelType,
            c.contact.id,
            c.contact.name,
            c.contact.phoneNumber,
            c.contact.email,
            c.assignee?.fullName ?? c.assignee?.email ?? null,
            c.team?.name ?? null,
            c.createdAt,
            c.resolvedAt,
          ]
          // A conversation with no messages still gets its row.
          if (msgs.length === 0) yield csvRow([...base, ...Array(8).fill(null)])
          for (const m of msgs) {
            yield csvRow([
              ...base,
              m.id,
              m.createdAt,
              m.senderType,
              senderName(m),
              m.isPrivate ? 'sim' : 'não',
              m.contentType,
              m.content,
              m.attachments.map((a) => a.fileUrl).join(' '),
            ])
          }
        } else {
          yield `${first ? '' : ',\n'}${JSON.stringify({
            id: c.id,
            displayId: c.displayId,
            status: c.status,
            priority: c.priority,
            inbox: c.inbox,
            contact: c.contact,
            assignee: c.assignee,
            team: c.team,
            createdAt: c.createdAt.toISOString(),
            resolvedAt: c.resolvedAt?.toISOString() ?? null,
            messages: msgs.map((m) => ({
              id: m.id,
              createdAt: m.createdAt.toISOString(),
              senderType: m.senderType,
              senderName: senderName(m),
              isPrivate: m.isPrivate,
              contentType: m.contentType,
              content: m.content,
              status: m.status,
              attachments: m.attachments,
            })),
          })}`
          first = false
        }
      }
      if (convs.length < PAGE / 5) break
      cursor = convs[convs.length - 1]!.id
    }
    if (format === 'json') yield '\n]\n'
  }
}
