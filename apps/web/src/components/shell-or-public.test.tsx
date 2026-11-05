import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const usePathnameMock = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => usePathnameMock(),
}))

// AppShell pulls a deep tree (data fetching, router, etc.) — stub it.
vi.mock('./app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}))

import { ShellOrPublic } from './shell-or-public'

beforeEach(() => {
  usePathnameMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ShellOrPublic', () => {
  it('wraps children in AppShell on authenticated routes', () => {
    usePathnameMock.mockReturnValue('/inbox')
    render(
      <ShellOrPublic>
        <span>hi</span>
      </ShellOrPublic>,
    )
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(screen.getByText('hi')).toBeInTheDocument()
  })

  it.each([
    ['/sign-in'],
    ['/sign-up'],
    ['/csat/abc'],
    // Password recovery is reachable without a session — regression guard
    // for the 2026-08-04 bounce-to-sign-in bug.
    ['/forgot-password'],
    ['/reset-password'],
    // A locked-out account: the shell's calls would all answer 402.
    ['/subscription'],
    // The welcome flow: signed in, but shown without the menus.
    ['/welcome'],
  ])(
    'renders bare on public route %s',
    (path) => {
      usePathnameMock.mockReturnValue(path)
      render(
        <ShellOrPublic>
          <span>public-body</span>
        </ShellOrPublic>,
      )
      expect(screen.queryByTestId('app-shell')).toBeNull()
      expect(screen.getByText('public-body')).toBeInTheDocument()
    },
  )

  it('falls back to wrapped layout when pathname is null', () => {
    usePathnameMock.mockReturnValue(null)
    render(
      <ShellOrPublic>
        <span>z</span>
      </ShellOrPublic>,
    )
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
  })
})
