import { z } from 'zod'

export const FileType = z.enum([
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'FILE',
  'LOCATION',
  'FALLBACK',
])
export type FileType = z.infer<typeof FileType>

export const AttachmentDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  messageId: z.string().nullable(),
  fileType: FileType,
  fileUrl: z.string(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  createdAt: z.string(),
})
export type AttachmentDTO = z.infer<typeof AttachmentDTO>
