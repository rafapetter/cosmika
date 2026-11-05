import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const usePathnameMock = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}))

// Stable reference: in production this is React state and keeps its identity
// between renders.
let stored: unknown = { membership: { role: 'ADMINISTRATOR' } }
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => ({ session: stored }),
}))

import { SettingsNav } from './settings-nav'

beforeEach(() => {
  usePathnameMock.mockReset()
  stored = { membership: { role: 'ADMINISTRATOR' } }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsNav', () => {
  it('renders all 13 settings items, each via an i18n key', () => {
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    for (const label of [
      'settings.nav.profile', 'settings.nav.security', 'settings.nav.account',
      'settings.nav.members', 'settings.nav.billing',
      'settings.nav.customAttributes', 'settings.nav.availability',
      'settings.nav.sla', 'settings.nav.webhooks', 'settings.nav.apiKeys',
      'settings.nav.contactsImport', 'settings.nav.dataExport', 'settings.nav.auditLog',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('marks the link whose href is a prefix of the pathname as active', () => {
    usePathnameMock.mockReturnValue('/settings/api-keys')
    render(<SettingsNav />)
    const active = screen.getByText('settings.nav.apiKeys').closest('a')
    expect(active?.className).toMatch(/bg-subtle/)
  })

  it('handles null pathname', () => {
    usePathnameMock.mockReturnValue(null)
    render(<SettingsNav />)
    expect(screen.getByText('settings.nav.profile')).toBeInTheDocument()
  })

  it('renders each item as an anchor with the correct href', () => {
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(
      screen.getByText('settings.nav.profile').closest('a')?.getAttribute('href'),
    ).toBe('/settings/profile')
    expect(
      screen.getByText('settings.nav.auditLog').closest('a')?.getAttribute('href'),
    ).toBe('/settings/audit-log')
  })
})

describe('SettingsNav — role-gated entries (F7)', () => {
  it('hides admin-only pages from a supervisor but keeps import + audit log', () => {
    stored = { membership: { role: 'SUPERVISOR' } }
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(screen.queryByText('settings.nav.webhooks')).toBeNull()
    expect(screen.queryByText('settings.nav.apiKeys')).toBeNull()
    expect(screen.getByText('settings.nav.contactsImport')).toBeInTheDocument()
    expect(screen.getByText('settings.nav.auditLog')).toBeInTheDocument()
  })

  it('leaves an agent only their own account pages (PoC item 12)', () => {
    stored = { membership: { role: 'AGENT' } }
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    for (const gone of [
      'settings.nav.account', 'settings.nav.members', 'settings.nav.billing',
      'settings.nav.customAttributes', 'settings.nav.sla',
      'settings.nav.webhooks', 'settings.nav.apiKeys',
      'settings.nav.contactsImport', 'settings.nav.dataExport', 'settings.nav.auditLog',
      'settings.nav.assistant',
    ]) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    for (const kept of ['settings.nav.profile', 'settings.nav.security', 'settings.nav.availability']) {
      expect(screen.getByText(kept)).toBeInTheDocument()
    }
  })

  it('an administrator still sees everything', () => {
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(screen.getByText('settings.nav.webhooks')).toBeInTheDocument()
    expect(screen.getByText('settings.nav.auditLog')).toBeInTheDocument()
  })
})

describe('SettingsNav — assistant entry', () => {
  // The assistant lives in the desktop sidebar, and the mobile bottom bar is
  // full at five items. Settings is reachable on every viewport, so this link
  // is the only route to the assistant on a phone.
  it('offers the assistant to an administrator', () => {
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(screen.getByText('settings.nav.assistant').closest('a')).toHaveAttribute(
      'href',
      '/assistant',
    )
  })

  it('hides it from a non-administrator, who would only get a 403', () => {
    stored = { membership: { role: 'AGENT' } }
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(screen.queryByText('settings.nav.assistant')).toBeNull()
    // The ordinary settings entries are untouched.
    expect(screen.getByText('settings.nav.profile')).toBeInTheDocument()
  })

  it('fails closed when the membership is unreadable', () => {
    stored = null
    usePathnameMock.mockReturnValue('/settings/profile')
    render(<SettingsNav />)
    expect(screen.queryByText('settings.nav.assistant')).toBeNull()
    expect(screen.getByText('settings.nav.profile')).toBeInTheDocument()
  })

  it('marks it active while on the assistant page', () => {
    usePathnameMock.mockReturnValue('/assistant')
    render(<SettingsNav />)
    expect(screen.getByText('settings.nav.assistant').closest('a')?.className).toMatch(/bg-subtle/)
  })
})
