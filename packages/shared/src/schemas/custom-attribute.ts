import { z } from 'zod'

export const CustomAttributeTarget = z.enum(['CONTACT', 'CONVERSATION'])
export type CustomAttributeTarget = z.infer<typeof CustomAttributeTarget>

export const CustomAttributeType = z.enum([
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
])
export type CustomAttributeType = z.infer<typeof CustomAttributeType>

export const CustomAttributeOption = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
})
export type CustomAttributeOption = z.infer<typeof CustomAttributeOption>

export const CustomAttributeDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  target: CustomAttributeTarget,
  key: z.string(),
  label: z.string(),
  type: CustomAttributeType,
  options: z.array(CustomAttributeOption).nullable(),
  position: z.number(),
  createdAt: z.string(),
})
export type CustomAttributeDTO = z.infer<typeof CustomAttributeDTO>

export const CreateCustomAttributeInput = z.object({
  target: CustomAttributeTarget,
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case lowercase'),
  label: z.string().min(1).max(120),
  type: CustomAttributeType,
  options: z.array(CustomAttributeOption).optional(),
  position: z.number().int().optional(),
})
export type CreateCustomAttributeInput = z.infer<
  typeof CreateCustomAttributeInput
>

export const UpdateCustomAttributeInput = z.object({
  label: z.string().min(1).max(120).optional(),
  type: CustomAttributeType.optional(),
  options: z.array(CustomAttributeOption).nullable().optional(),
  position: z.number().int().optional(),
})
export type UpdateCustomAttributeInput = z.infer<
  typeof UpdateCustomAttributeInput
>
