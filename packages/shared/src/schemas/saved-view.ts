import { z } from 'zod'

import { ContactFilter, CONTACT_SORT_FIELDS } from './contact'
import { ConversationStatus } from './conversation'
import { TicketFilter, TICKET_SORT_FIELDS } from './support-ticket'

export const SavedViewEntity = z.enum(['CONVERSATIONS', 'CONTACTS', 'TICKETS'])
export type SavedViewEntity = z.infer<typeof SavedViewEntity>

/**
 * Filter shape stored inside a saved view. A subset of ListConversationsQuery
 * — kept here separately so views can grow their own semantics later
 * (e.g. `assigneeId: 'me'` resolved at query time, label filters).
 */
export const SavedViewFilters = z.object({
  status: ConversationStatus.optional(),
  inboxId: z.string().optional(),
  assigneeId: z.string().optional(),
  labelId: z.string().optional(),
  q: z.string().trim().min(1).max(200).optional(),
})
export type SavedViewFilters = z.infer<typeof SavedViewFilters>

/**
 * Payload stored by a CONTACTS view: the whole grid state — composable
 * filters, sort, and hidden columns — so switching tabs restores exactly
 * what the user saved.
 */
export const ContactViewConfig = z.object({
  filters: z.array(ContactFilter).max(5),
  sort: z.enum(CONTACT_SORT_FIELDS),
  dir: z.enum(['asc', 'desc']),
  hiddenColumns: z.array(z.string().max(40)).max(10),
})
export type ContactViewConfig = z.infer<typeof ContactViewConfig>

/** Same grid-state snapshot as ContactViewConfig, for the tickets grid. */
export const TicketViewConfig = z.object({
  filters: z.array(TicketFilter).max(5),
  sort: z.enum(TICKET_SORT_FIELDS),
  dir: z.enum(['asc', 'desc']),
  hiddenColumns: z.array(z.string().max(40)).max(10),
})
export type TicketViewConfig = z.infer<typeof TicketViewConfig>

const VIEW_PAYLOAD_SCHEMAS: Record<SavedViewEntity, z.ZodTypeAny> = {
  CONVERSATIONS: SavedViewFilters,
  CONTACTS: ContactViewConfig,
  TICKETS: TicketViewConfig,
}

/** Validate the filters payload against the entity it claims to be for. */
export function payloadIssues(
  entity: SavedViewEntity | undefined,
  filters: unknown,
): string | null {
  const schema = VIEW_PAYLOAD_SCHEMAS[entity ?? 'CONVERSATIONS']
  const r = schema.safeParse(filters)
  return r.success ? null : r.error.issues.map((i) => i.message).join('; ')
}

export const CreateSavedViewInput = z
  .object({
    name: z.string().min(1).max(60),
    icon: z.string().min(1).max(40).optional().nullable(),
    // Absent = CONVERSATIONS, so every pre-existing caller keeps working.
    entity: SavedViewEntity.optional(),
    filters: z.unknown(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .superRefine((v, ctx) => {
    const issue = payloadIssues(v.entity, v.filters)
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: issue })
    }
  })
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewInput>

// Update deliberately does NOT accept `entity`: a view cannot change what
// list it belongs to, and validating a filters-only patch needs the stored
// entity, which the service knows and the schema does not.
export const UpdateSavedViewInput = z.object({
  name: z.string().min(1).max(60).optional(),
  icon: z.string().min(1).max(40).nullable().optional(),
  filters: z.unknown().optional(),
  position: z.number().int().min(0).max(999).optional(),
})
export type UpdateSavedViewInput = z.infer<typeof UpdateSavedViewInput>

export const SavedViewDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  userId: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  entity: SavedViewEntity,
  filters: z.unknown(),
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedViewDTO = z.infer<typeof SavedViewDTO>
