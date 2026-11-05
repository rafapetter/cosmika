import { z } from 'zod'

export const AccountStatus = z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED'])
export type AccountStatus = z.infer<typeof AccountStatus>

export const Plan = z.enum([
  'EXPLORER',
  'JETPACK',
  'ROCKET',
  'SPACESHIP',
  'ENTERPRISE',
  'PARTNER',
  'MASTER',
])
export type Plan = z.infer<typeof Plan>

export const Role = z.enum(['ADMINISTRATOR', 'SUPERVISOR', 'AGENT', 'BOT'])
export type Role = z.infer<typeof Role>

export const Locale = z.enum(['pt-BR', 'es', 'en'])
export type Locale = z.infer<typeof Locale>

/**
 * Timezones offered as suggestions wherever the account timezone is edited.
 * The full IANA list is far too long for a Select, and operators want one of
 * a handful. Free text is still accepted, which is why the field below is
 * validated rather than constrained to this list.
 */
export const TIMEZONE_PRESETS = [
  'America/Sao_Paulo',
  'America/New_York',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Bogota',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'UTC',
] as const

/**
 * A timezone the runtime can actually resolve. Working hours, SLA windows and
 * report boundaries all read this field, so an unresolvable string quietly
 * shifts every one of them. The admin assistant already checked this way; the
 * HTTP path did not, and anything at all used to be accepted.
 */
export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const UpdateAccountInput = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().nullable().optional(),
  defaultLocale: Locale.optional(),
  defaultTimezone: z.string().refine(isValidTimezone, {
    message: 'Unknown timezone',
  }).optional(),
  brandSettings: z.record(z.unknown()).optional(),
  aiSettings: z.record(z.unknown()).optional(),
  // Hard ceiling on AI spend for the calendar month, across every bot on the
  // account. 0 means no ceiling.
  monthlyAiBudgetUsd: z.number().min(0).max(100000).optional(),
  // Whether the admin assistant stops for confirmation before a critical
  // change. Only an administrator can flip this, and only from Settings —
  // the assistant has no tool for it.
  adminAgentRequiresApproval: z.boolean().optional(),
  // Agents see only their teams' conversations (queues isolated by team).
  teamScopedVisibility: z.boolean().optional(),
})
export type UpdateAccountInput = z.infer<typeof UpdateAccountInput>

export const InviteMemberInput = z.object({
  email: z.string().email(),
  role: Role,
  fullName: z.string().optional(),
})
export type InviteMemberInput = z.infer<typeof InviteMemberInput>

export const ChangeMemberRoleInput = z.object({
  role: Role,
})
export type ChangeMemberRoleInput = z.infer<typeof ChangeMemberRoleInput>
