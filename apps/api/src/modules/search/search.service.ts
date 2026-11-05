import { ForbiddenException, Injectable } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'
import { conversationAccessWhere } from '../conversations/conversation-access'

export type SearchHit =
  | {
      kind: 'contact'
      id: string
      title: string
      subtitle: string | null
    }
  | {
      kind: 'conversation'
      id: string
      title: string
      subtitle: string | null
    }
  | {
      kind: 'article'
      id: string
      title: string
      subtitle: string | null
    }

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  /**
   * Tri-source search: contacts (name/email/phone) + conversations (recent
   * messages) + published articles (title/content). Cap each source at 5
   * hits so the popover stays small.
   */
  async global(
    userId: string,
    accountId: string,
    q: string,
  ): Promise<SearchHit[]> {
    const trimmed = q.trim()
    if (trimmed.length < 2) return []
    const member = await this.assertMember(userId, accountId)
    const like = { contains: trimmed, mode: 'insensitive' as const }
    // Conversations follow the same visibility as the inbox list: an agent
    // must not find, by searching, a conversation they cannot open.
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { teamScopedVisibility: true },
    })
    const visible = conversationAccessWhere(member, account?.teamScopedVisibility === true)

    const [contacts, articles, conversations] = await Promise.all([
      this.prisma.contact.findMany({
        where: {
          accountId,
          OR: [
            { name: like },
            { email: like },
            { phoneNumber: like },
            { identifier: like },
          ],
        },
        take: 5,
        select: { id: true, name: true, email: true, phoneNumber: true },
      }),
      this.prisma.article.findMany({
        where: {
          accountId,
          status: 'PUBLISHED',
          OR: [{ title: like }, { content: like }],
        },
        take: 5,
        select: { id: true, slug: true, title: true, content: true },
      }),
      this.prisma.conversation.findMany({
        where: {
          ...visible,
          messages: { some: { content: like } },
        },
        take: 5,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          displayId: true,
          status: true,
          contact: { select: { name: true, email: true, phoneNumber: true } },
          messages: {
            where: { content: like },
            select: { content: true },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    ])

    const out: SearchHit[] = []
    for (const c of contacts) {
      out.push({
        kind: 'contact',
        id: c.id,
        title: c.name ?? c.email ?? c.phoneNumber ?? '—',
        subtitle: c.email ?? c.phoneNumber ?? null,
      })
    }
    for (const c of conversations) {
      const name = c.contact?.name ?? c.contact?.email ?? c.contact?.phoneNumber
      const firstMessage = c.messages[0]
      const snippet =
        firstMessage && firstMessage.content
          ? firstMessage.content.slice(0, 120)
          : null
      out.push({
        kind: 'conversation',
        id: c.id,
        title: `#${c.displayId} · ${name ?? 'no contact'}`,
        subtitle: snippet,
      })
    }
    for (const a of articles) {
      out.push({
        kind: 'article',
        id: a.id,
        title: a.title,
        subtitle: a.content.slice(0, 120),
      })
    }
    return out
  }
}
