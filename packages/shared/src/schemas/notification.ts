import { z } from 'zod'

export const NotificationType = z.enum([
  'MENTION',
  'ASSIGNMENT',
  'ASSIGNMENT_FALLBACK',
  'SLA_BREACH',
])
export type NotificationType = z.infer<typeof NotificationType>

export const NotificationDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  userId: z.string(),
  type: NotificationType,
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  mentionedByUserId: z.string().nullable(),
  mentionedBy: z
    .object({
      id: z.string(),
      email: z.string(),
      fullName: z.string().nullable(),
    })
    .nullable(),
  /** Sparse preview to render in the bell dropdown. */
  conversation: z
    .object({
      id: z.string(),
      displayId: z.number().int(),
      contactName: z.string().nullable(),
    })
    .nullable(),
  /** Message preview text (first 160 chars). */
  messagePreview: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})
export type NotificationDTO = z.infer<typeof NotificationDTO>

export const ListNotificationsQuery = z.object({
  onlyUnread: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>

export const NotificationCounts = z.object({
  unread: z.number().int(),
})
export type NotificationCounts = z.infer<typeof NotificationCounts>

export const NotificationPreferenceDTO = z.object({
  mentionsEnabled: z.boolean(),
  assignmentsEnabled: z.boolean(),
})
export type NotificationPreferenceDTO = z.infer<typeof NotificationPreferenceDTO>

export const UpdateNotificationPreferenceInput = z.object({
  mentionsEnabled: z.boolean().optional(),
  assignmentsEnabled: z.boolean().optional(),
})
export type UpdateNotificationPreferenceInput = z.infer<
  typeof UpdateNotificationPreferenceInput
>
