import { z } from 'zod'

const baseContactFields = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  phoneNumber: z
    .string()
    .min(4)
    .max(32)
    .regex(/^[+0-9() -]+$/, 'invalid phone number')
    .optional(),
  identifier: z.string().min(1).max(120).optional(),
  customAttributes: z.record(z.unknown()).optional(),
  additionalAttributes: z.record(z.unknown()).optional(),
  avatarUrl: z.string().url().optional(),
})

const hasAnyIdentifier = (data: {
  email?: string
  phoneNumber?: string
  identifier?: string
}) => Boolean(data.email || data.phoneNumber || data.identifier)

export const CreateContactInput = baseContactFields.refine(hasAnyIdentifier, {
  message: 'At least one of email, phoneNumber, or identifier is required',
  path: ['email'],
})
export type CreateContactInput = z.infer<typeof CreateContactInput>

export const UpdateContactInput = baseContactFields.extend({
  name: baseContactFields.shape.name.nullable(),
  email: baseContactFields.shape.email.nullable(),
  phoneNumber: baseContactFields.shape.phoneNumber.nullable(),
  identifier: baseContactFields.shape.identifier.nullable(),
  avatarUrl: baseContactFields.shape.avatarUrl.nullable(),
})
export type UpdateContactInput = z.infer<typeof UpdateContactInput>

export const MergeContactsInput = z.object({
  sourceContactIds: z.array(z.string().min(1)).min(1).max(5),
})
export type MergeContactsInput = z.infer<typeof MergeContactsInput>

export const SetContactBlockedInput = z.object({
  blocked: z.boolean(),
})
export type SetContactBlockedInput = z.infer<typeof SetContactBlockedInput>

export const BulkContactAction = z.enum(['block', 'unblock', 'delete'])
export type BulkContactAction = z.infer<typeof BulkContactAction>

export const BulkContactActionInput = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(500),
  action: BulkContactAction,
})
export type BulkContactActionInput = z.infer<typeof BulkContactActionInput>

export const BulkContactActionResult = z.object({
  action: BulkContactAction,
  affected: z.number().int().nonnegative(),
})
export type BulkContactActionResult = z.infer<typeof BulkContactActionResult>

export const CreateContactNoteInput = z.object({
  body: z.string().trim().min(1).max(5000),
})
export type CreateContactNoteInput = z.infer<typeof CreateContactNoteInput>

export const ContactNoteDTO = z.object({
  id: z.string(),
  contactId: z.string(),
  body: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
})
export type ContactNoteDTO = z.infer<typeof ContactNoteDTO>

/** Sortable columns. Kept to indexed/deterministic fields on purpose. */
export const CONTACT_SORT_FIELDS = [
  'createdAt',
  'name',
  'email',
  'lastActivityAt',
] as const
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number]

/** One composable filter: field + operator (+ value where the op needs one). */
export const CONTACT_FILTER_FIELDS = [
  'name',
  'email',
  'phoneNumber',
  'identifier',
  'blocked',
] as const
export type ContactFilterField = (typeof CONTACT_FILTER_FIELDS)[number]

export const CONTACT_FILTER_OPS = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'isEmpty',
  'isNotEmpty',
] as const
export type ContactFilterOp = (typeof CONTACT_FILTER_OPS)[number]

export const ContactFilter = z
  .object({
    field: z.enum(CONTACT_FILTER_FIELDS),
    op: z.enum(CONTACT_FILTER_OPS),
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
    if (f.field === 'blocked') {
      // Blocked is a state, not text: only equality against true/false.
      if (!['is', 'isNot'].includes(f.op)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'blocked supports only is / isNot',
        })
      } else if (f.value !== 'true' && f.value !== 'false') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'blocked value must be true or false',
        })
      }
    }
  })
export type ContactFilter = z.infer<typeof ContactFilter>

export const ListContactsQuery = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Sorting and filtering are SERVER-side by necessity: the list is
  // cursor-paginated, so sorting the loaded page in the browser would only
  // order the rows already fetched and silently lie about the rest.
  sort: z.enum(CONTACT_SORT_FIELDS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  blocked: z.enum(['yes', 'no']).optional(),
  hasEmail: z.enum(['yes', 'no']).optional(),
  hasPhone: z.enum(['yes', 'no']).optional(),
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
    .pipe(z.array(ContactFilter).min(1).max(5))
    .optional(),
})
export type ListContactsQuery = z.infer<typeof ListContactsQuery>

export const ContactDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  identifier: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  customAttributes: z.record(z.unknown()),
  additionalAttributes: z.record(z.unknown()),
  lastActivityAt: z.string().nullable(),
  blockedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ContactDTO = z.infer<typeof ContactDTO>

export const ContactInboxRefDTO = z.object({
  id: z.string(),
  inboxId: z.string(),
  inboxName: z.string(),
  channelType: z.string(),
  sourceId: z.string().nullable(),
  createdAt: z.string(),
})
export type ContactInboxRefDTO = z.infer<typeof ContactInboxRefDTO>

export const ContactWithInboxesDTO = ContactDTO.extend({
  contactInboxes: z.array(ContactInboxRefDTO),
})
export type ContactWithInboxesDTO = z.infer<typeof ContactWithInboxesDTO>

export const ContactsPage = z.object({
  data: z.array(ContactDTO),
  nextCursor: z.string().nullable(),
  /** Total rows matching the current search + filters (across all pages). */
  total: z.number().int(),
})
export type ContactsPage = z.infer<typeof ContactsPage>
