import { z } from 'zod'

export const CreateTeamInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
})
export type CreateTeamInput = z.infer<typeof CreateTeamInput>

export const UpdateTeamInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
})
export type UpdateTeamInput = z.infer<typeof UpdateTeamInput>

export const AddTeamMemberInput = z.object({
  userId: z.string().min(1),
})
export type AddTeamMemberInput = z.infer<typeof AddTeamMemberInput>

export const TeamMemberDTO = z.object({
  id: z.string(),
  userId: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    fullName: z.string().nullable(),
  }),
  createdAt: z.string(),
})
export type TeamMemberDTO = z.infer<typeof TeamMemberDTO>

export const TeamDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type TeamDTO = z.infer<typeof TeamDTO>

export const TeamWithMembersDTO = TeamDTO.extend({
  members: z.array(TeamMemberDTO),
})
export type TeamWithMembersDTO = z.infer<typeof TeamWithMembersDTO>
