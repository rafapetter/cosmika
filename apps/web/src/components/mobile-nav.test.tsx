import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const usePathnameMock = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}))

let role: string | undefined
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => ({ session: role ? { membership: { role } } : null }),
}))

import { MobileNav } from './mobile-nav'

beforeEach(() => {
  usePathnameMock.mockReset()
  role = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MobileNav', () => {
  it('renders all the expected nav items', () => {
    usePathnameMock.mockReturnValue('/inbox')
    render(<MobileNav />)
    for (const label of [
      'shell.mobile_inbox',
      'shell.mobile_chats',
      'shell.mobile_contacts',
      'shell.mobile_kb',
      'shell.mobile_settings',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('marks the item matching the current pathname as active', () => {
    usePathnameMock.mockReturnValue('/conversations/1234')
    render(<MobileNav />)
    const chats = screen.getByText('shell.mobile_chats').closest('a')
    expect(chats?.className).toMatch(/text-foreground|font-medium|active|bg-/)
  })

  it('handles null pathname gracefully', () => {
    usePathnameMock.mockReturnValue(null)
    render(<MobileNav />)
    expect(screen.getByText('shell.mobile_inbox')).toBeInTheDocument()
  })

  it('renders an <a> per item with the right href', () => {
    usePathnameMock.mockReturnValue('/inbox')
    render(<MobileNav />)
    const links = screen
      .getAllByRole('link')
      .map((el) => (el as HTMLAnchorElement).getAttribute('href'))
    expect(links).toEqual(
      expect.arrayContaining([
        '/inbox',
        '/conversations',
        '/contacts',
        '/knowledge-base',
        '/settings/profile',
      ]),
    )
  })

  it('labels the last tab as the agent\'s own account for operators (PoC item 12)', () => {
    role = 'AGENT'
    usePathnameMock.mockReturnValue('/inbox')
    render(<MobileNav />)
    expect(screen.queryByText('shell.mobile_settings')).toBeNull()
    expect(screen.getByText('shell.mobile_my_account').closest('a')?.getAttribute('href')).toBe('/settings/profile')
  })
})
