import { z } from 'zod'

export const AuditLogActor = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
})
export type AuditLogActor = z.infer<typeof AuditLogActor>

export const AuditLogDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  actor: AuditLogActor.nullable(),
  action: z.string(),
  target: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
})
export type AuditLogDTO = z.infer<typeof AuditLogDTO>

export const ListAuditLogsQuery = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    action: z.string().optional(),
    /** Only rows written by this user (the member who did the action). */
    actorId: z.string().min(1).optional(),
    /** Inclusive lower bound on `createdAt`, ISO 8601. */
    from: z.string().datetime({ offset: true }).optional(),
    /** Exclusive upper bound on `createdAt`, ISO 8601. */
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  })
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuery>

export const AuditLogPage = z.object({
  items: z.array(AuditLogDTO),
  nextCursor: z.string().nullable(),
})
export type AuditLogPage = z.infer<typeof AuditLogPage>
