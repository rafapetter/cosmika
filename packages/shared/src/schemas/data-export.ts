import { z } from 'zod'

export const DataExportKind = z.enum(['contacts', 'conversations'])
export type DataExportKind = z.infer<typeof DataExportKind>

export const DataExportFormat = z.enum(['csv', 'json'])
export type DataExportFormat = z.infer<typeof DataExportFormat>

/** Contacts by creation date; conversations (with their messages) by start date. */
export const DataExportQuery = z
  .object({
    format: DataExportFormat.default('csv'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  })
export type DataExportQuery = z.infer<typeof DataExportQuery>
