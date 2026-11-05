import { z } from 'zod'

import { Locale, Plan, Role, AccountStatus } from './account'

export const SignUpInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  accountName: z.string().min(1),
  // Required whenever the server has COSMIKA_SIGNUP_INVITE_CODE set (beta gate).
  inviteCode: z.string().optional(),
})
export type SignUpInput = z.infer<typeof SignUpInput>

export const SignInInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})
export type SignInInput = z.infer<typeof SignInInput>

export const ForgotPasswordInput = z.object({
  email: z.string().email(),
})
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInput>

export const ResetPasswordInput = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})
export type ResetPasswordInput = z.infer<typeof ResetPasswordInput>

export const UpdateMeInput = z.object({
  fullName: z.string().min(1).max(120).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  locale: Locale.optional(),
  // How we reach this person when a channel of theirs goes down. Free text:
  // the flow asks people from three countries and a format check would only
  // reject the ones it had not thought of.
  phone: z.string().max(40).nullable().optional(),
})
export type UpdateMeInput = z.infer<typeof UpdateMeInput>

export const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
})
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>

// Response shapes — used by clients to validate / type API output.

export const SessionDTO = z.object({
  id: z.string(),
  token: z.string(),
  expiresAt: z.string(),
})
export type SessionDTO = z.infer<typeof SessionDTO>

export const UserDTO = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  // Optional on the wire so a session stored before this field existed still
  // parses.
  phone: z.string().nullable().optional(),
  totpEnabled: z.boolean(),
  createdAt: z.string(),
})
export type UserDTO = z.infer<typeof UserDTO>

export const AccountDTO = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  status: AccountStatus,
  plan: Plan,
  defaultLocale: Locale,
  defaultTimezone: z.string(),
  // Whether the admin assistant pauses on critical tool calls. Optional on
  // the wire so a session stored before this field existed still parses;
  // readers treat a missing value as `true`, the cautious default.
  adminAgentRequiresApproval: z.boolean().optional(),
  // Optional on the wire for sessions stored before it existed; missing = off.
  teamScopedVisibility: z.boolean().optional(),
  createdAt: z.string(),
})
export type AccountDTO = z.infer<typeof AccountDTO>

export const AccountMemberDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  userId: z.string(),
  role: Role,
  isActive: z.boolean(),
  user: UserDTO,
})
export type AccountMemberDTO = z.infer<typeof AccountMemberDTO>

export const SignupCheckoutDTO = z.object({
  paymentLinkUrl: z.string(),
  paymentLinkId: z.string(),
  plan: z.string(),
  cycle: z.string(),
  chargedValue: z.number(),
  trialExpiresAt: z.string(),
})
export type SignupCheckoutDTO = z.infer<typeof SignupCheckoutDTO>

export const AuthEnvelope = z.object({
  session: SessionDTO,
  user: UserDTO,
  account: AccountDTO,
  membership: AccountMemberDTO,
  // Returned by sign-up when a billing backend is configured.
  checkout: SignupCheckoutDTO.optional(),
})
export type AuthEnvelope = z.infer<typeof AuthEnvelope>

export const MeResponse = z.object({
  user: UserDTO,
  account: AccountDTO,
  membership: AccountMemberDTO,
})
export type MeResponse = z.infer<typeof MeResponse>

export const AccountWithMembers = AccountDTO.extend({
  members: z.array(AccountMemberDTO),
})
export type AccountWithMembers = z.infer<typeof AccountWithMembers>

/**
 * What the "subscription ended" screen needs: whether the account may be
 * served, and a way to pay when it may not. `checkoutUrl` is null for paying
 * accounts and for accounts with no stored payment link (contact finance).
 */
export const BillingStatusDTO = z.object({
  accessAllowed: z.boolean(),
  paying: z.boolean(),
  trialExpiresAt: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
})
export type BillingStatusDTO = z.infer<typeof BillingStatusDTO>
