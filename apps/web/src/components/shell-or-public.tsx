'use client'

import { usePathname } from 'next/navigation'

import { AppShell } from './app-shell'

/**
 * Wrap children in AppShell for authenticated routes; render bare on public
 * routes (sign-in / sign-up). Lets us keep a single root layout and avoid a
 * separate route group.
 */
const PUBLIC_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/csat',
  // Password recovery must be reachable WITHOUT a session — wrapping these
  // in AppShell bounced unauthenticated visitors straight back to /sign-in
  // (found live 2026-08-04 on the first real reset attempt).
  '/forgot-password',
  '/reset-password',
  // Shown when billing locks the account. The shell's own calls would all
  // answer 402 and bounce straight back here.
  '/subscription',
  // The welcome flow. The visitor IS signed in here, but the flow is four
  // questions and the shell would surround them with menus for screens that
  // nothing has been set up in yet.
  '/welcome',
]

export function ShellOrPublic({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? ''
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  if (isPublic) return <>{children}</>
  return <AppShell>{children}</AppShell>
}
