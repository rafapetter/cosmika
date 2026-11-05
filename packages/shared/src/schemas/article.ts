import { z } from 'zod'

export const ArticleStatus = z.enum(['DRAFT', 'PUBLISHED'])
export type ArticleStatus = z.infer<typeof ArticleStatus>

export const ArticleDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  slug: z.string(),
  title: z.string(),
  content: z.string(),
  status: ArticleStatus,
  tags: z.array(z.string()),
  hasEmbedding: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ArticleDTO = z.infer<typeof ArticleDTO>

// Compact form used by the AI tool result and by the contact-facing widget
// surface (when we expose KB search publicly in future).
export const ArticleHitDTO = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  score: z.number().nullable(),
})
export type ArticleHitDTO = z.infer<typeof ArticleHitDTO>

export const CreateArticleInput = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, hyphens'),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  status: ArticleStatus.optional(),
  tags: z.array(z.string()).optional(),
})
export type CreateArticleInput = z.infer<typeof CreateArticleInput>

export const UpdateArticleInput = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  status: ArticleStatus.optional(),
  tags: z.array(z.string()).optional(),
})
export type UpdateArticleInput = z.infer<typeof UpdateArticleInput>

export const SearchArticlesQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).optional(),
})
export type SearchArticlesQuery = z.infer<typeof SearchArticlesQuery>

export const ListArticlesQuery = z.object({
  status: ArticleStatus.optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type ListArticlesQuery = z.infer<typeof ListArticlesQuery>
