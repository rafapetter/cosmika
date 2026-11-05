import { z } from 'zod'

export const ContactImportRow = z.object({
  name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  phoneNumber: z.string().optional(),
  identifier: z.string().optional(),
  customAttributes: z.record(z.unknown()).optional(),
})
export type ContactImportRow = z.infer<typeof ContactImportRow>

export const ContactImportInput = z.object({
  rows: z.array(ContactImportRow).min(1).max(2000),
  inboxId: z.string().optional(),
})
export type ContactImportInput = z.infer<typeof ContactImportInput>

export const ContactImportResult = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.array(
    z.object({
      row: z.number(),
      /** Stable reason the interface can translate; `message` stays for logs. */
      code: z.enum(['duplicate', 'failed']).optional(),
      message: z.string(),
    }),
  ),
})
export type ContactImportResult = z.infer<typeof ContactImportResult>
