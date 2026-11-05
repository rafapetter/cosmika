import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

/**
 * How many rows we pull per round trip. Small enough that one page fits in
 * memory comfortably, large enough that a 300k-message account doesn't turn
 * into 300k queries.
 */
const PAGE = 500

export type BackupCounts = {
  contacts: number
  conversations: number
  messages: number
  attachments: number
  tickets: number
  articles: number
}

/**
 * Whole-account export as newline-delimited JSON.
 *
 * NDJSON rather than one JSON document on purpose: the biggest account here
 * has ~370k messages, and a single `JSON.stringify` of that would have to
 * build the entire string in memory before a byte reaches the client. Each
 * line is independently parseable, so the export streams and a consumer can
 * process it incrementally.
 *
 * Attachments are exported as metadata plus their storage key — NOT as
 * embedded bytes. The blobs are ~1.8 GB in R2; inlining them would make the
 * export unusable and duplicate data that already has a durable home.
 */
@Injectable()
export class AccountBackupService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAdmin(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    // A backup is every message every customer ever sent. Administrators only.
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  /** Row counts, so a caller can show progress or sanity-check an export. */
  async counts(accountId: string): Promise<BackupCounts> {
    const [contacts, conversations, messages, attachments, tickets, articles] =
      await Promise.all([
        this.prisma.contact.count({ where: { accountId } }),
        this.prisma.conversation.count({ where: { accountId } }),
        this.prisma.message.count({ where: { accountId } }),
        this.prisma.attachment.count({ where: { accountId } }),
        this.prisma.supportTicket.count({ where: { accountId } }),
        this.prisma.article.count({ where: { accountId } }),
      ])
    return { contacts, conversations, messages, attachments, tickets, articles }
  }

  /**
   * Yields the export one NDJSON line at a time. The first line is a manifest
   * (account, counts, generatedAt) so a consumer can tell a truncated download
   * from a complete one by comparing counts against what it actually read.
   */
  async *stream(accountId: string, generatedAt: string): AsyncGenerator<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, name: true, slug: true, createdAt: true },
    })
    if (!account) throw new NotFoundException()

    // The welcome-flow answers. One row, so it rides along with the manifest
    // rather than through the pager. Without it the export stops being a
    // complete copy of what we hold about the account, which is the whole
    // point of the endpoint under GDPR portability.
    const profile = await this.prisma.accountProfile.findUnique({
      where: { accountId },
    })

    const counts = await this.counts(accountId)
    yield line({
      type: 'manifest',
      version: 1,
      generatedAt,
      account: { ...account, createdAt: account.createdAt.toISOString() },
      counts,
    })

    if (profile) yield line({ type: 'account_profile', data: serialise(profile) })

    yield* this.page('contact', accountId)
    yield* this.page('conversation', accountId)
    yield* this.page('message', accountId)
    yield* this.page('attachment', accountId)
    yield* this.page('supportTicket', accountId)
    yield* this.page('article', accountId)
  }

  /**
   * Cursor-paged read of one table. Ordered by id so the cursor is stable
   * even while rows are being written underneath us — an offset would skip or
   * repeat rows as the table changes mid-export.
   */
  private async *page(
    model: 'contact' | 'conversation' | 'message' | 'attachment' | 'supportTicket' | 'article',
    accountId: string,
  ): AsyncGenerator<string> {
    let cursor: string | undefined
    for (;;) {
      const rows: Array<Record<string, unknown>> = await (
        this.prisma[model] as {
          findMany: (a: unknown) => Promise<Array<Record<string, unknown>>>
        }
      ).findMany({
        where: { accountId },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        // The embedding is a 1536-float vector per article — derived data that
        // regenerates on import, and enormous next to the text it came from.
        ...(model === 'article'
          ? {
              select: {
                id: true, accountId: true, slug: true, title: true,
                content: true, status: true, tags: true,
                createdAt: true, updatedAt: true,
              },
            }
          : {}),
      })
      if (rows.length === 0) return
      for (const row of rows) yield line({ type: model, data: serialise(row) })
      if (rows.length < PAGE) return
      cursor = rows[rows.length - 1]!.id as string
    }
  }
}

const line = (o: unknown): string => `${JSON.stringify(o)}\n`

/** Dates to ISO; everything else passes through. Buffers never appear here. */
function serialise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v
  }
  return out
}
