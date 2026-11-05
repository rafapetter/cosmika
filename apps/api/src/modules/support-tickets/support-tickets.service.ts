import { ForbiddenException, Injectable, Logger } from '@nestjs/common'
import type { Priority, Prisma, Role, SupportTicket } from '@cosmika/db'
import type { ListTicketsQuery, TicketFilter } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

/**
 * One composable filter → Prisma where fragment. Enum fields (status,
 * priority) arrive schema-validated as exact members, so equality is safe;
 * text fields match case-insensitively like the contacts grid.
 */
export function ticketFilterToWhere(f: TicketFilter): Prisma.SupportTicketWhereInput {
  if (f.field === 'status' || f.field === 'priority') {
    const eq = { [f.field]: f.value } as Prisma.SupportTicketWhereInput
    return f.op === 'is' ? eq : { NOT: eq }
  }
  const field = f.field
  switch (f.op) {
    case 'contains':
      return { [field]: { contains: f.value, mode: 'insensitive' } }
    case 'notContains':
      return { NOT: { [field]: { contains: f.value, mode: 'insensitive' } } }
    case 'is':
      return { [field]: { equals: f.value, mode: 'insensitive' } }
    case 'isNot':
      return { NOT: { [field]: { equals: f.value, mode: 'insensitive' } } }
    case 'isEmpty':
      return { [field]: null }
    case 'isNotEmpty':
      return { [field]: { not: null } }
  }
}

/** Longest ticket subject we keep — the flow interpolates free text into it. */
const SUBJECT_MAX = 200
const BODY_MAX = 8000

/**
 * Free-text priority coming out of a flow variable ("alta", "urgent", "2"…)
 * mapped onto the Priority enum. Anything unrecognised stays NORMAL rather
 * than failing the ticket — a mis-typed priority shouldn't lose the report.
 */
const PRIORITY_WORDS: Record<string, Priority> = {
  low: 'LOW',
  baixa: 'LOW',
  baixo: 'LOW',
  normal: 'NORMAL',
  medium: 'NORMAL',
  media: 'NORMAL',
  média: 'NORMAL',
  high: 'HIGH',
  alta: 'HIGH',
  alto: 'HIGH',
  urgent: 'URGENT',
  urgente: 'URGENT',
  critica: 'URGENT',
  crítica: 'URGENT',
}

export function parsePriority(raw: unknown): Priority {
  if (typeof raw !== 'string') return 'NORMAL'
  return PRIORITY_WORDS[raw.trim().toLowerCase()] ?? 'NORMAL'
}

/** Who may move a ticket's status. Read access is any active member. */
const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

const trim = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

/**
 * Support tickets raised from a flow's Ticket blocks. Deliberately internal:
 * no external provider, so a migrated flow's "abrir chamado" step produces a
 * durable record in Cosmika instead of silently doing nothing.
 */
@Injectable()
export class SupportTicketsService {
  private readonly logger = new Logger(SupportTicketsService.name)

  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    accountId: string
    conversationId: string | null
    contactId: string | null
    subject: unknown
    description: unknown
    category: unknown
    priority: unknown
  }): Promise<SupportTicket> {
    // A ticket with no subject is useless to whoever picks it up; fall back to
    // the description, and only then to a generic label.
    const description = trim(input.description, BODY_MAX)
    const subject =
      trim(input.subject, SUBJECT_MAX) ||
      description.slice(0, SUBJECT_MAX) ||
      'Chamado sem assunto'
    const category = trim(input.category, 120)
    return this.prisma.supportTicket.create({
      data: {
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: input.contactId,
        subject,
        description,
        category: category || null,
        priority: parsePriority(input.priority),
      },
    })
  }

  /**
   * Append an update to the conversation's most recent open ticket. Returns
   * null when the conversation has no ticket to update — the caller turns
   * that into a flow variable the author can branch on.
   */
  async appendUpdate(
    accountId: string,
    conversationId: string | null,
    body: unknown,
  ): Promise<SupportTicket | null> {
    const text = trim(body, BODY_MAX)
    if (!conversationId || !text) return null
    const ticket = await this.prisma.supportTicket.findFirst({
      where: {
        accountId,
        conversationId,
        status: { in: ['OPEN', 'PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (!ticket) return null
    await this.prisma.supportTicketEvent.create({
      data: { ticketId: ticket.id, body: text },
    })
    return this.prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'PENDING' },
    })
  }

  async assertMember(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
  }

  async assertMutator(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (!MUTATE_ROLES.includes(m.role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  toDTO(t: SupportTicket & { contact?: { name: string | null } | null }) {
    return {
      id: t.id,
      accountId: t.accountId,
      number: t.number,
      subject: t.subject,
      description: t.description,
      category: t.category,
      priority: t.priority,
      status: t.status,
      conversationId: t.conversationId,
      contactId: t.contactId,
      contactName: t.contact?.name ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }
  }

  /** One page of an account's tickets, newest first. */
  async listForAccount(
    accountId: string,
    filter: ListTicketsQuery = {},
  ): Promise<Array<SupportTicket & { contact: { name: string | null } | null }>> {
    const sort = filter.sort ?? 'createdAt'
    const dir = filter.dir ?? 'desc'
    return this.prisma.supportTicket.findMany({
      where: {
        accountId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.q
          ? {
              OR: [
                { subject: { contains: filter.q, mode: 'insensitive' as const } },
                { description: { contains: filter.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(filter.filters?.length
          ? { AND: filter.filters.map((f) => ticketFilterToWhere(f)) }
          : {}),
      },
      include: { contact: { select: { name: true } } },
      // Every sortable column is non-nullable, so the plain form is always
      // right here — no `{ sort, nulls }` object (which 500s on non-nullable
      // columns, the exact trap the contacts grid hit).
      orderBy: { [sort]: dir },
      take: 200,
    })
  }

  /** One ticket with its update trail. Account-scoped: a wrong id is a miss. */
  async getForAccount(
    accountId: string,
    ticketId: string,
  ): Promise<
    | (SupportTicket & {
        contact: { name: string | null } | null
        events: Array<{ id: string; body: string; createdAt: Date }>
      })
    | null
  > {
    return this.prisma.supportTicket.findFirst({
      where: { id: ticketId, accountId },
      include: {
        contact: { select: { name: true } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    })
  }

  /**
   * Change status or priority. Scoped to the account so a ticket id from
   * elsewhere can't be moved, and returns null on a miss so the caller 404s
   * rather than reporting a phantom success.
   */
  async updateForAccount(
    accountId: string,
    ticketId: string,
    patch: { status?: string; priority?: string; category?: string | null },
  ): Promise<SupportTicket | null> {
    const existing = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, accountId },
      select: { id: true },
    })
    if (!existing) return null
    return this.prisma.supportTicket.update({
      where: { id: existing.id },
      data: {
        ...(patch.status ? { status: patch.status as SupportTicket['status'] } : {}),
        ...(patch.priority
          ? { priority: patch.priority as SupportTicket['priority'] }
          : {}),
        // `category` distinguishes absent (untouched) from null/'' (clear).
        ...(patch.category !== undefined
          ? { category: patch.category?.trim() ? patch.category.trim() : null }
          : {}),
      },
    })
  }

  /**
   * Tickets raised in this conversation, or every ticket for the contact when
   * `scope` is 'contact' — the two query types the migrated blocks use.
   */
  async list(
    accountId: string,
    scope: { conversationId: string | null; contactId: string | null; byContact: boolean },
  ): Promise<SupportTicket[]> {
    const where = scope.byContact
      ? scope.contactId
        ? { accountId, contactId: scope.contactId }
        : null
      : scope.conversationId
        ? { accountId, conversationId: scope.conversationId }
        : null
    if (!where) return []
    return this.prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
  }
}
