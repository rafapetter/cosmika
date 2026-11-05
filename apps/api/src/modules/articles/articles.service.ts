import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Article, Prisma } from '@cosmika/db'
import {
  ArticleHitDTO,
  CreateArticleInput,
  ListArticlesQuery,
  UpdateArticleInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIM = 1536
// text-embedding-3-small rejects inputs over 8191 tokens. Long articles are
// real (the seeded help-centre set tops 22k chars), and the API returns 400
// for the whole request — so cap the embedded text. The stored content is
// untouched; only the vector is built from the leading slice.
const EMBEDDING_INPUT_MAX_CHARS = 8000
// Ceiling on a single article handed to the AI in one tool result. Generous
// enough for every help-centre page bar the longest, small enough that a
// couple of reads can't blow the model's context.
const ARTICLE_READ_MAX_CHARS = 12000

@Injectable()
export class ArticlesService {
  private readonly logger = new Logger(ArticlesService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  private async assertMutator(userId: string, accountId: string) {
    const m = await this.assertMember(userId, accountId)
    if (m.role !== 'ADMINISTRATOR' && m.role !== 'SUPERVISOR') {
      throw new ForbiddenException(errBody('insufficient_role', 'Insufficient role'))
    }
  }

  async list(
    userId: string,
    accountId: string,
    query: ListArticlesQuery,
  ): Promise<Article[]> {
    await this.assertMember(userId, accountId)
    return this.prisma.article.findMany({
      where: {
        accountId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { content: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(query.limit ?? 50, 100),
    })
  }

  async get(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<Article> {
    await this.assertMember(userId, accountId)
    const article = await this.prisma.article.findUnique({ where: { id } })
    if (!article || article.accountId !== accountId) throw new NotFoundException()
    return article
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateArticleInput,
  ): Promise<Article> {
    await this.assertMutator(userId, accountId)
    const dupe = await this.prisma.article.findUnique({
      where: { accountId_slug: { accountId, slug: input.slug } },
    })
    if (dupe) throw new ConflictException(errBody('slug_taken', `Slug "${input.slug}" already exists`))

    const created = await this.prisma.article.create({
      data: {
        accountId,
        authorId: userId,
        slug: input.slug,
        title: input.title,
        content: input.content,
        status: input.status ?? 'DRAFT',
        tags: input.tags ?? [],
      },
    })
    void this.refreshEmbedding(created.id).catch((err) => {
      this.logger.error(`embedding refresh failed: ${String(err)}`)
    })
    return created
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateArticleInput,
  ): Promise<Article> {
    await this.assertMutator(userId, accountId)
    const existing = await this.prisma.article.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    const data: Prisma.ArticleUpdateInput = {}
    if (input.title !== undefined) data.title = input.title
    if (input.content !== undefined) data.content = input.content
    if (input.status !== undefined) data.status = input.status
    if (input.tags !== undefined) data.tags = input.tags
    const updated = await this.prisma.article.update({ where: { id }, data })
    if (input.title !== undefined || input.content !== undefined) {
      void this.refreshEmbedding(updated.id).catch((err) => {
        this.logger.error(`embedding refresh failed: ${String(err)}`)
      })
    }
    return updated
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertMutator(userId, accountId)
    const existing = await this.prisma.article.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    await this.prisma.article.delete({ where: { id } })
  }

  /**
   * Full body of one published article, by id or slug. Backs the AI's
   * read-after-search step: `search` returns 280-char excerpts, which rank
   * well but can't answer anything procedural, so the model picks a hit and
   * reads it. Scoped to the account and to PUBLISHED, same as search.
   */
  async readPublished(
    accountId: string,
    ref: string,
    // An agent's own base (AgentBot.knowledgeTags). Empty = every article.
    tags: string[] = [],
  ): Promise<{ id: string; slug: string; title: string; content: string; truncated: boolean } | null> {
    const row = await this.prisma.article.findFirst({
      where: {
        accountId,
        status: 'PUBLISHED',
        OR: [{ id: ref }, { slug: ref }],
        ...tagFilter(tags),
      },
    })
    if (!row) return null
    const truncated = row.content.length > ARTICLE_READ_MAX_CHARS
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      content: truncated ? row.content.slice(0, ARTICLE_READ_MAX_CHARS) : row.content,
      truncated,
    }
  }

  /**
   * Hybrid search: vector similarity when embedding is available, otherwise
   * trigram-ish ILIKE fallback. Results limited to PUBLISHED articles. Always
   * scoped to one account. Returns compact hits suitable for the AI tool.
   */
  async search(
    accountId: string,
    q: string,
    limit = 5,
    // An agent's own base (AgentBot.knowledgeTags): only articles carrying
    // at least one of these tags. Empty = the whole account base.
    tags: string[] = [],
  ): Promise<ArticleHitDTO[]> {
    const trimmed = q.trim().slice(0, 1000)
    if (!trimmed) return []
    const embedding = await this.embed(trimmed)
    if (embedding) {
      const literal = `[${embedding.join(',')}]`
      // pgvector cosine distance — lower is closer; convert to similarity.
      const rows = await this.prisma.$queryRawUnsafe<
        Array<{ id: string; slug: string; title: string; content: string; distance: number }>
      >(
        `SELECT id, slug, title, content,
                (embedding <=> $1::vector) AS distance
         FROM "Article"
         WHERE "accountId" = $2 AND status = 'PUBLISHED' AND embedding IS NOT NULL
           AND (cardinality($4::text[]) = 0 OR tags && $4::text[])
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        literal,
        accountId,
        limit,
        tags,
      )
      if (rows.length > 0) {
        return rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          title: r.title,
          excerpt: r.content.slice(0, 280),
          score: r.distance !== null ? 1 - Number(r.distance) : null,
        }))
      }
    }
    // Fallback: text-only ILIKE.
    const rows = await this.prisma.article.findMany({
      where: {
        accountId,
        status: 'PUBLISHED',
        OR: [
          { title: { contains: trimmed, mode: 'insensitive' } },
          { content: { contains: trimmed, mode: 'insensitive' } },
        ],
        ...tagFilter(tags),
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    })
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      excerpt: r.content.slice(0, 280),
      score: null,
    }))
  }

  /**
   * Best-effort embedding generation. No-op when COSMIKA_AI_STUB is set so
   * the e2e suite can run without an OpenAI key.
   */
  private async embed(text: string): Promise<number[] | null> {
    if (this.config.get<string>('COSMIKA_AI_STUB') === '1') return null
    const key = this.config.get<string>('OPENAI_API_KEY')
    if (!key) return null
    // OPENAI_BASE_URL lets a gateway front the call (metering + budget live
    // there). Defaults to OpenAI itself; a trailing slash is tolerated.
    const base = (
      this.config.get<string>('OPENAI_BASE_URL')?.trim() || 'https://api.openai.com/v1'
    ).replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: text.slice(0, EMBEDDING_INPUT_MAX_CHARS),
          dimensions: EMBEDDING_DIM,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        this.logger.warn(`embedding API ${res.status}`)
        return null
      }
      const json = (await res.json()) as {
        data: Array<{ embedding: number[] }>
      }
      return json.data[0]?.embedding ?? null
    } catch (err) {
      this.logger.warn(`embedding fetch failed: ${String(err)}`)
      return null
    }
  }

  private async refreshEmbedding(articleId: string): Promise<void> {
    const a = await this.prisma.article.findUnique({ where: { id: articleId } })
    if (!a) return
    const vec = await this.embed(`${a.title}\n\n${a.content}`)
    if (!vec) return
    const literal = `[${vec.join(',')}]`
    await this.prisma.$executeRawUnsafe(
      `UPDATE "Article" SET embedding = $1::vector WHERE id = $2`,
      literal,
      articleId,
    )
  }

  toDTO(a: Article & { embedding?: unknown }) {
    return {
      id: a.id,
      accountId: a.accountId,
      slug: a.slug,
      title: a.title,
      content: a.content,
      status: a.status,
      tags: a.tags,
      hasEmbedding: a.embedding !== null && a.embedding !== undefined,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    }
  }
}

/** Prisma filter for an agent's base: any of the tags, or no filter at all. */
function tagFilter(tags: string[]): { tags?: { hasSome: string[] } } {
  return tags.length > 0 ? { tags: { hasSome: tags } } : {}
}
