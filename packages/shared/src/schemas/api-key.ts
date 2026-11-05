import { z } from 'zod'

export const ApiKeyDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  prefix: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type ApiKeyDTO = z.infer<typeof ApiKeyDTO>

/** Returned ONCE on create. Never visible again — the secret isn't stored. */
export const ApiKeyWithSecret = ApiKeyDTO.extend({
  secret: z.string(),
})
export type ApiKeyWithSecret = z.infer<typeof ApiKeyWithSecret>

export const CreateApiKeyInput = z.object({
  name: z.string().min(1).max(120),
})
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInput>
