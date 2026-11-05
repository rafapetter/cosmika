import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  AccountMember,
  Contact,
  ContactInbox,
  ContactNote,
  Inbox,
  Prisma,
  Role,
  User,
} from '@cosmika/db'
import {
  BulkContactAction,
  BulkContactActionInput,
  ContactImportInput,
  ContactImportResult,
  CreateContactInput,
  ListContactsQuery,
  MergeContactsInput,
  UpdateContactInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { WebhooksService } from '../webhooks/webhooks.service'
import { AuditLogService } from '../audit-log/audit-log.service'
import { UsageService } from '../usage/usage.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

export type ContactWithInboxes = Contact & {
  contactInboxes: Array<ContactInbox & { inbox: Inbox }>
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditLogService,
    private readonly usage: UsageService,
  ) {}

  private async getMembership(
    userId: string,
    accountId: string,
  ): Promise<AccountMember> {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return membership
  }

  private assertMutator(role: Role) {
    if (!MUTATE_ROLES.includes(role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  async assertAccess(userId: string, accountId: string): Promise<Role> {
    const m = await this.getMembership(userId, accountId)
    return m.role
  }

  async list(
    userId: string,
    accountId: string,
    query: ListContactsQuery,
  ): Promise<{ data: Contact[]; nextCursor: string | null; total: number }> {
    await this.getMembership(userId, accountId)
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const q = query.q?.trim()
    const where: Prisma.ContactWhereInput = {
      accountId,
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phoneNumber: { contains: q, mode: 'insensitive' } },
          { identifier: { contains: q, mode: 'insensitive' } },
        ],
      }),
      ...(query.filters?.length && {
        AND: query.filters.map((f) => filterToWhere(f)),
      }),
      ...(query.blocked === 'yes' && { blockedAt: { not: null } }),
      ...(query.blocked === 'no' && { blockedAt: null }),
      ...(query.hasEmail === 'yes' && { email: { not: null } }),
      ...(query.hasEmail === 'no' && { email: null }),
      ...(query.hasPhone === 'yes' && { phoneNumber: { not: null } }),
      ...(query.hasPhone === 'no' && { phoneNumber: null }),
    }
    // `id` stays the final tiebreaker so cursor pagination remains
    // deterministic whichever column the user sorts by.
    const sort = query.sort ?? 'createdAt'
    const dir = query.dir ?? 'desc'
    // Rows with no value sort LAST whichever direction is chosen, otherwise
    // Postgres leads `desc` with a wall of NULLs and sorting by name shows
    // blanks before any real name.
    //
    // The `{ sort, nulls }` form is ONLY valid for NULLABLE columns — Prisma
    // rejects it on a non-nullable one with "Expected SortOrder, provided
    // Object", which 500s the whole list. `createdAt` is non-nullable, and it
    // is the default sort, so getting this wrong breaks the default view.
    const NULLABLE_SORTS = new Set(['name', 'email', 'lastActivityAt'])
    const primaryOrder = NULLABLE_SORTS.has(sort)
      ? { [sort]: { sort: dir, nulls: 'last' } }
      : { [sort]: dir }
    // The count shares `where`, so the header number always matches what the
    // filters would let you page through — Twenty's "All Contacts · N".
    const [contacts, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: [
          primaryOrder,
          { id: dir },
        ] as Prisma.ContactOrderByWithRelationInput[],
        take: limit + 1,
        ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
      }),
      this.prisma.contact.count({ where }),
    ])
    let nextCursor: string | null = null
    if (contacts.length > limit) {
      const next = contacts.pop()
      nextCursor = next ? next.id : null
    }
    return { data: contacts, nextCursor, total }
  }

  async getWithInboxes(
    userId: string,
    accountId: string,
    contactId: string,
  ): Promise<ContactWithInboxes> {
    await this.getMembership(userId, accountId)
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        contactInboxes: {
          include: { inbox: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!contact || contact.accountId !== accountId) {
      throw new NotFoundException()
    }
    return contact
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateContactInput,
  ): Promise<Contact> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    // No plan check: creating one contact is never refused for being over a
    // cap (decision 3). The terms reject exactly one thing over the limit, a
    // bulk import, and that check lives in `importBatch` below.
    const contact = await this.prisma.contact.create({
      data: {
        accountId,
        name: input.name,
        email: input.email,
        phoneNumber: input.phoneNumber,
        identifier: input.identifier,
        avatarUrl: input.avatarUrl,
        customAttributes:
          (input.customAttributes as Prisma.InputJsonValue | undefined) ?? {},
        additionalAttributes:
          (input.additionalAttributes as Prisma.InputJsonValue | undefined) ??
          {},
      },
    })
    void this.webhooks
      .dispatch(accountId, 'contact.created', {
        contactId: contact.id,
        name: contact.name,
        email: contact.email,
        phoneNumber: contact.phoneNumber,
      })
      .catch(() => undefined)
    return contact
  }

  async importBatch(
    userId: string,
    accountId: string,
    input: ContactImportInput,
  ): Promise<ContactImportResult> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    // The one limit the terms tell us to enforce: a batch that would carry
    // the account past its absolute contact limit is rejected whole, counted
    // BEFORE the first row is written. Half-importing a 50.000-row file and
    // then failing leaves the customer with a mess nobody can undo.
    await this.usage.assertImportWithinAbsoluteLimit(accountId, input.rows.length)

    const result: ContactImportResult = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    }

    for (let i = 0; i < input.rows.length; i += 1) {
      const row = input.rows[i]
      if (!row) continue
      const email = row.email && row.email.length > 0 ? row.email.toLowerCase() : null
      const phone = row.phoneNumber?.trim() || null
      const identifier = row.identifier?.trim() || null

      if (!email && !phone && !identifier) {
        result.skipped += 1
        result.errors.push({
          row: i + 1,
          message: 'Need at least one of email, phoneNumber or identifier',
        })
        continue
      }

      try {
        // Find existing by any unique-ish identifier (account-scoped).
        const existing = await this.prisma.contact.findFirst({
          where: {
            accountId,
            OR: [
              ...(email ? [{ email }] : []),
              ...(phone ? [{ phoneNumber: phone }] : []),
              ...(identifier ? [{ identifier }] : []),
            ],
          },
          select: { id: true, customAttributes: true },
        })

        const customAttrs = {
          ...((existing?.customAttributes as Record<string, unknown>) ?? {}),
          ...(row.customAttributes ?? {}),
        }

        if (existing) {
          await this.prisma.contact.update({
            where: { id: existing.id },
            data: {
              ...(row.name && { name: row.name }),
              ...(email && { email }),
              ...(phone && { phoneNumber: phone }),
              ...(identifier && { identifier }),
              customAttributes: customAttrs as Prisma.InputJsonValue,
            },
          })
          result.updated += 1
        } else {
          const created = await this.prisma.contact.create({
            data: {
              accountId,
              name: row.name ?? null,
              email,
              phoneNumber: phone,
              identifier,
              customAttributes: customAttrs as Prisma.InputJsonValue,
            },
          })
          result.created += 1
          void this.webhooks
            .dispatch(accountId, 'contact.created', {
              contactId: created.id,
              name: created.name,
              email: created.email,
              phoneNumber: created.phoneNumber,
              source: 'import',
            })
            .catch(() => undefined)
        }
      } catch (err) {
        // A unique-constraint clash is the one row failure worth naming; the
        // rest travel as `failed` with the English detail kept for logs.
        const prismaCode =
          err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : ''
        result.errors.push({
          row: i + 1,
          code: prismaCode === 'P2002' ? 'duplicate' : 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    void this.audit
      .record({
        accountId,
        actorId: userId,
        action: 'contact.import',
        target: null,
        metadata: {
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors.length,
        },
      })
      .catch(() => undefined)

    return result
  }

  async exportContact(
    userId: string,
    accountId: string,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        contactInboxes: {
          include: {
            inbox: { select: { id: true, name: true, channelType: true } },
          },
        },
        conversations: {
          orderBy: { createdAt: 'asc' },
          include: {
            messages: {
              orderBy: { createdAt: 'asc' },
              include: { attachments: true },
            },
          },
        },
      },
    })
    if (!contact || contact.accountId !== accountId) {
      throw new NotFoundException()
    }
    return {
      exportedAt: new Date().toISOString(),
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        phoneNumber: contact.phoneNumber,
        identifier: contact.identifier,
        customAttributes: contact.customAttributes,
        additionalAttributes: contact.additionalAttributes,
        avatarUrl: contact.avatarUrl,
        createdAt: contact.createdAt.toISOString(),
      },
      inboxes: contact.contactInboxes.map((ci) => ({
        inbox: ci.inbox,
        sourceId: ci.sourceId,
      })),
      conversations: contact.conversations.map((c) => ({
        id: c.id,
        displayId: c.displayId,
        inboxId: c.inboxId,
        status: c.status,
        priority: c.priority,
        createdAt: c.createdAt.toISOString(),
        messages: c.messages.map((m) => ({
          id: m.id,
          senderType: m.senderType,
          content: m.content,
          contentType: m.contentType,
          isPrivate: m.isPrivate,
          createdAt: m.createdAt.toISOString(),
          attachments: m.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            fileType: a.fileType,
            fileSize: a.fileSize,
          })),
        })),
      })),
    }
  }

  async anonymizeContact(
    userId: string,
    accountId: string,
    contactId: string,
  ): Promise<Contact> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    // Replace PII fields. Keep customAttributes/conversations so stats still
    // work; the *contents* of contact-authored messages are also redacted.
    return this.prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: { senderContactId: contactId, senderType: 'CONTACT' },
        data: { content: '[redacted]' },
      })
      return tx.contact.update({
        where: { id: contactId },
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
    })
  }

  async update(
    userId: string,
    accountId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<Contact> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    // '' and null mean the same thing for these fields, but only null sorts
    // and falls back correctly — 329 acct-4 contacts had empty-string names
    // that rendered blank and led every ascending sort. Normalise on write so
    // the distinction can't come back.
    const blankToNull = (v: string | null | undefined) =>
      typeof v === 'string' && v.trim() === '' ? null : v
    const data: Prisma.ContactUpdateInput = {
      ...('name' in input && { name: blankToNull(input.name) }),
      ...('email' in input && { email: blankToNull(input.email) }),
      ...('phoneNumber' in input && { phoneNumber: blankToNull(input.phoneNumber) }),
      ...('identifier' in input && { identifier: blankToNull(input.identifier) }),
      ...('avatarUrl' in input && { avatarUrl: input.avatarUrl }),
      ...(input.customAttributes !== undefined && {
        customAttributes: input.customAttributes as Prisma.InputJsonValue,
      }),
      ...(input.additionalAttributes !== undefined && {
        additionalAttributes:
          input.additionalAttributes as Prisma.InputJsonValue,
      }),
    }
    return this.prisma.contact.update({
      where: { id: contactId },
      data,
    })
  }

  async remove(
    userId: string,
    accountId: string,
    contactId: string,
  ): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    await this.prisma.contact.delete({ where: { id: contactId } })
  }

  // ─── notes ────────────────────────────────────────────────────────

  private async ensureContact(accountId: string, contactId: string) {
    const c = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, accountId: true },
    })
    if (!c || c.accountId !== accountId) throw new NotFoundException()
  }

  async listNotes(
    userId: string,
    accountId: string,
    contactId: string,
  ): Promise<Array<ContactNote & { author: User | null }>> {
    await this.getMembership(userId, accountId)
    await this.ensureContact(accountId, contactId)
    return this.prisma.contactNote.findMany({
      where: { contactId },
      include: { author: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  async addNote(
    userId: string,
    accountId: string,
    contactId: string,
    body: string,
  ): Promise<ContactNote & { author: User | null }> {
    await this.getMembership(userId, accountId)
    await this.ensureContact(accountId, contactId)
    return this.prisma.contactNote.create({
      data: { accountId, contactId, authorId: userId, body },
      include: { author: true },
    })
  }

  async deleteNote(
    userId: string,
    accountId: string,
    contactId: string,
    noteId: string,
  ): Promise<void> {
    await this.getMembership(userId, accountId)
    const note = await this.prisma.contactNote.findUnique({
      where: { id: noteId },
      select: { id: true, accountId: true, contactId: true },
    })
    if (!note || note.accountId !== accountId || note.contactId !== contactId) {
      throw new NotFoundException()
    }
    await this.prisma.contactNote.delete({ where: { id: noteId } })
  }

  toContactNoteDTO(note: ContactNote & { author: User | null }) {
    return {
      id: note.id,
      contactId: note.contactId,
      body: note.body,
      authorId: note.authorId,
      authorName: note.author?.fullName ?? note.author?.email ?? null,
      createdAt: note.createdAt.toISOString(),
    }
  }

  /**
   * Block or unblock a contact. Blocked contacts have their inbound messages
   * dropped on ingest (see widget/whatsapp services).
   */
  async setBlocked(
    userId: string,
    accountId: string,
    contactId: string,
    blocked: boolean,
  ): Promise<Contact> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    return this.prisma.contact.update({
      where: { id: contactId },
      data: { blockedAt: blocked ? new Date() : null },
    })
  }

  /**
   * Apply one action (block / unblock / delete) to many contacts at once.
   * Everything is account-scoped: ids not belonging to `accountId` are simply
   * not matched, so a cross-account id can never be affected. Returns how many
   * rows the action actually touched.
   */
  async bulkAction(
    userId: string,
    accountId: string,
    input: BulkContactActionInput,
  ): Promise<{ action: BulkContactAction; affected: number }> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)

    const ids = [...new Set(input.contactIds)]
    const where: Prisma.ContactWhereInput = { id: { in: ids }, accountId }

    if (input.action === 'delete') {
      const r = await this.prisma.contact.deleteMany({ where })
      return { action: input.action, affected: r.count }
    }
    const r = await this.prisma.contact.updateMany({
      where,
      data: { blockedAt: input.action === 'block' ? new Date() : null },
    })
    return { action: input.action, affected: r.count }
  }

  async merge(
    userId: string,
    accountId: string,
    targetContactId: string,
    input: MergeContactsInput,
  ): Promise<ContactWithInboxes> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)

    if (input.sourceContactIds.includes(targetContactId)) {
      throw new ConflictException(errBody('merge_target_in_sources', 'Source list cannot include the target'))
    }
    if (new Set(input.sourceContactIds).size !== input.sourceContactIds.length) {
      throw new ConflictException(errBody('merge_duplicate_sources', 'Source list contains duplicates'))
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.contact.findUnique({
        where: { id: targetContactId },
      })
      if (!target || target.accountId !== accountId) {
        throw new NotFoundException('Target contact not found')
      }

      const sources = await tx.contact.findMany({
        where: { id: { in: input.sourceContactIds }, accountId },
      })
      if (sources.length !== input.sourceContactIds.length) {
        throw new NotFoundException('One or more source contacts not found')
      }

      // Backfill target's nullable fields from the first source that has them.
      const patch: Prisma.ContactUpdateInput = {}
      const candidates = [...sources]
      if (!target.name) {
        const src = candidates.find((s) => s.name)
        if (src?.name) patch.name = src.name
      }
      if (!target.email) {
        const src = candidates.find((s) => s.email)
        if (src?.email) patch.email = src.email
      }
      if (!target.phoneNumber) {
        const src = candidates.find((s) => s.phoneNumber)
        if (src?.phoneNumber) patch.phoneNumber = src.phoneNumber
      }
      if (!target.identifier) {
        const src = candidates.find((s) => s.identifier)
        if (src?.identifier) patch.identifier = src.identifier
      }
      if (!target.avatarUrl) {
        const src = candidates.find((s) => s.avatarUrl)
        if (src?.avatarUrl) patch.avatarUrl = src.avatarUrl
      }

      // Move ContactInbox rows. ContactInbox has @@unique([contactId, inboxId])
      // and @@unique([inboxId, sourceId]) — handle collisions by deleting the
      // duplicate source row instead of moving.
      const targetInboxes = await tx.contactInbox.findMany({
        where: { contactId: targetContactId },
        select: { inboxId: true },
      })
      const targetInboxIds = new Set(targetInboxes.map((ci) => ci.inboxId))

      const sourceInboxes = await tx.contactInbox.findMany({
        where: { contactId: { in: input.sourceContactIds } },
      })
      for (const ci of sourceInboxes) {
        if (targetInboxIds.has(ci.inboxId)) {
          await tx.contactInbox.delete({ where: { id: ci.id } })
        } else {
          await tx.contactInbox.update({
            where: { id: ci.id },
            data: { contactId: targetContactId },
          })
          targetInboxIds.add(ci.inboxId)
        }
      }

      // Future-proof: move conversations even though they aren't created yet
      // by this module. Once Module 4 lands, this still does the right thing.
      await tx.conversation.updateMany({
        where: { contactId: { in: input.sourceContactIds } },
        data: { contactId: targetContactId },
      })

      // Merge customAttributes / additionalAttributes (target wins on conflict).
      const mergedCustom = this.mergeJsonShallow(
        sources.map((s) => s.customAttributes as Prisma.JsonValue),
        target.customAttributes as Prisma.JsonValue,
      )
      const mergedAdditional = this.mergeJsonShallow(
        sources.map((s) => s.additionalAttributes as Prisma.JsonValue),
        target.additionalAttributes as Prisma.JsonValue,
      )
      patch.customAttributes = mergedCustom as Prisma.InputJsonValue
      patch.additionalAttributes = mergedAdditional as Prisma.InputJsonValue

      if (Object.keys(patch).length > 0) {
        await tx.contact.update({
          where: { id: targetContactId },
          data: patch,
        })
      }

      await tx.contact.deleteMany({
        where: { id: { in: input.sourceContactIds } },
      })

      const merged = await tx.contact.findUnique({
        where: { id: targetContactId },
        include: {
          contactInboxes: {
            include: { inbox: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      if (!merged) throw new NotFoundException()
      return merged
    })
  }

  private mergeJsonShallow(
    sources: Prisma.JsonValue[],
    target: Prisma.JsonValue,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const src of sources) {
      if (src && typeof src === 'object' && !Array.isArray(src)) {
        Object.assign(result, src as Record<string, unknown>)
      }
    }
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      Object.assign(result, target as Record<string, unknown>)
    }
    return result
  }

  toContactDTO(contact: Contact) {
    return {
      id: contact.id,
      accountId: contact.accountId,
      name: contact.name,
      email: contact.email,
      phoneNumber: contact.phoneNumber,
      identifier: contact.identifier,
      avatarUrl: contact.avatarUrl,
      customAttributes: (contact.customAttributes ?? {}) as Record<
        string,
        unknown
      >,
      additionalAttributes: (contact.additionalAttributes ?? {}) as Record<
        string,
        unknown
      >,
      lastActivityAt: contact.lastActivityAt?.toISOString() ?? null,
      blockedAt: contact.blockedAt?.toISOString() ?? null,
      createdAt: contact.createdAt.toISOString(),
      updatedAt: contact.updatedAt.toISOString(),
    }
  }

  toContactInboxRefDTO(ci: ContactInbox & { inbox: Inbox }) {
    return {
      id: ci.id,
      inboxId: ci.inboxId,
      inboxName: ci.inbox.name,
      channelType: ci.inbox.channelType,
      sourceId: ci.sourceId,
      createdAt: ci.createdAt.toISOString(),
    }
  }
}


/**
 * One composable filter → one Prisma where clause. Filters are ANDed by the
 * caller. `blocked` maps to blockedAt presence; text operators are
 * case-insensitive; isEmpty matches null only because update() normalises
 * ''/whitespace to null on write.
 */
export function filterToWhere(
  f: import('@cosmika/shared').ContactFilter,
): Prisma.ContactWhereInput {
  if (f.field === 'blocked') {
    const wantBlocked = (f.value === 'true') === (f.op === 'is')
    return wantBlocked ? { blockedAt: { not: null } } : { blockedAt: null }
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
