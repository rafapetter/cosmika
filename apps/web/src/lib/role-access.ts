/**
 * What an operator (AGENT) may open (pilot item 12). Agents work the
 * queue; settings, user management and every configuration area belong to
 * supervisors and administrators. The API already refuses the writes; this
 * keeps the doors out of an agent's sight and turns a typed URL into a
 * "no access" screen instead of a page that errors on every call.
 *
 * Their own account pages stay: profile, password/2FA and working hours are
 * the agent's, not the workspace's.
 */
export type Role = 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT'

/** Personal pages under /settings an agent keeps ("Minha conta"). */
export const AGENT_SETTINGS = ['/settings/profile', '/settings/security', '/settings/availability'] as const

/** Areas closed to agents. Canned responses stay open on their own route. */
const AGENT_BLOCKED = [
  '/settings',
  '/inboxes',
  '/agent-bots',
  '/flows',
  '/teams',
  '/automation',
  '/broadcasts',
  '/labels',
  '/reports',
  '/assistant',
] as const

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

export function canAccessPath(role: Role | string | undefined | null, pathname: string): boolean {
  if (role !== 'AGENT') return true
  if (AGENT_SETTINGS.some((p) => under(pathname, p))) return true
  return !AGENT_BLOCKED.some((p) => under(pathname, p))
}
