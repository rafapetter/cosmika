import { z } from 'zod'

export const TicketStatus = z.enum(['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'])
export type TicketStatus = z.infer<typeof TicketStatus>

export const TicketPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export type TicketPriority = z.infer<typeof TicketPriority>

export const SupportTicketEventDTO = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
export type SupportTicketEventDTO = z.infer<typeof SupportTicketEventDTO>

export const SupportTicketDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  /** Human-facing number, shown as `#42`. */
  number: z.number().int(),
  subject: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  priority: TicketPriority,
  status: TicketStatus,
  /** Where it was raised. Null once the conversation is gone. */
  conversationId: z.string().nullable(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SupportTicketDTO = z.infer<typeof SupportTicketDTO>

export const SupportTicketDetailDTO = SupportTicketDTO.extend({
  events: z.array(SupportTicketEventDTO),
})
export type SupportTicketDetailDTO = z.infer<typeof SupportTicketDetailDTO>

/** Sortable columns. All non-nullable, so plain orderBy forms only. */
export const TICKET_SORT_FIELDS = [
  'createdAt',
  'number',
  'subject',
  'priority',
  'status',
] as const
export type TicketSortField = (typeof TICKET_SORT_FIELDS)[number]

export const TICKET_FILTER_FIELDS = [
  'subject',
  'category',
  'status',
  'priority',
] as const
export type TicketFilterField = (typeof TICKET_FILTER_FIELDS)[number]

export const TICKET_FILTER_OPS = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'isEmpty',
  'isNotEmpty',
] as const
export type TicketFilterOp = (typeof TICKET_FILTER_OPS)[number]

export const TicketFilter = z
  .object({
    field: z.enum(TICKET_FILTER_FIELDS),
    op: z.enum(TICKET_FILTER_OPS),
    value: z.string().trim().max(200).optional(),
  })
  .superRefine((f, ctx) => {
    const needsValue = !['isEmpty', 'isNotEmpty'].includes(f.op)
    if (needsValue && (!f.value || f.value.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `operator ${f.op} requires a value`,
      })
    }
    if (f.field === 'status' || f.field === 'priority') {
      // Enum columns: equality only, and the value must be a member — a typo
      // would otherwise become a Prisma error (500) instead of a 400.
      if (!['is', 'isNot'].includes(f.op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${f.field} supports only is / isNot`,
        })
      } else {
        const ok =
          f.field === 'status'
            ? TicketStatus.safeParse(f.value).success
            : TicketPriority.safeParse(f.value).success
        if (!ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid ${f.field} value`,
          })
        }
      }
    }
    // Subject is never null, so presence checks on it are meaningless.
    if (f.field === 'subject' && ['isEmpty', 'isNotEmpty'].includes(f.op)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject supports only text operators',
      })
    }
  })
export type TicketFilter = z.infer<typeof TicketFilter>

export const ListTicketsQuery = z.object({
  status: TicketStatus.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(TICKET_SORT_FIELDS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  // Composable filters arrive as URL-encoded JSON. Parsed AND validated in
  // the pipe so a malformed payload is a 400, never a 500 in the service.
  filters: z
    .string()
    .max(2000)
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'filters must be JSON' })
        return z.NEVER
      }
    })
    .pipe(z.array(TicketFilter).min(1).max(5))
    .optional(),
})
export type ListTicketsQuery = z.infer<typeof ListTicketsQuery>

export const UpdateTicketInput = z.object({
  status: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  // Category is free text set by flows; letting a human correct it in the
  // grid costs nothing. Empty string clears it.
  category: z.string().trim().max(120).nullable().optional(),
})
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>
