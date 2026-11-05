// GlobalSearch tests — search popover with debounce + keyboard nav.
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiSearch = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = (await vi.importActual('../lib/api')) as Record<string, unknown>
  return {
    ...actual,
    api: { search: (...args: unknown[]) => apiSearch(...args) },
  }
})

// Translator stub: the key, then any params, so assertions see both.
const T = (k: string, p?: Record<string, unknown>) =>
  p ? `${k} ${Object.values(p).join(' ')}` : k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const useStoredSessionMock = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

import { GlobalSearch } from './global-search'

const SESSION = {
  session: { token: 'tok' },
  user: { id: 'u', email: 'a@e.com' },
  account: { id: 'acc1', name: 'Acme' },
}

beforeEach(() => {
  apiSearch.mockReset()
  useStoredSessionMock.mockReturnValue({
    session: SESSION,
    ready: true,
    setSession: vi.fn(),
  })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GlobalSearch — auth gating', () => {
  it('renders nothing when there is no session', () => {
    useStoredSessionMock.mockReturnValue({
      session: null,
      ready: false,
      setSession: vi.fn(),
    })
    const { container } = render(<GlobalSearch />)
    expect(container.firstChild).toBeNull()
  })
})

describe('GlobalSearch — query + popover', () => {
  it('renders the input with the right placeholder', () => {
    render(<GlobalSearch />)
    expect(screen.getByPlaceholderText('globalSearch.placeholder')).toBeInTheDocument()
  })

  it('does not call the API for queries under 2 chars', async () => {
    render(<GlobalSearch />)
    const input = screen.getByTestId('global-search-input')
    await userEvent.type(input, 'a')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(apiSearch).not.toHaveBeenCalled()
  })

  it('debounces and calls api.search with the current query (≥2 chars)', async () => {
    apiSearch.mockResolvedValue({ hits: [] })
    render(<GlobalSearch />)
    const input = screen.getByTestId('global-search-input')
    await userEvent.type(input, 'bo')
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(apiSearch).toHaveBeenCalledWith('tok', 'acc1', 'bo')
    })
  })

  it('renders hits with title + kind label + subtitle', async () => {
    apiSearch.mockResolvedValue({
      hits: [
        { kind: 'contact', id: 'c1', title: 'Bob', subtitle: 'bob@e.com' },
        { kind: 'conversation', id: 'cv1', title: 'Pricing', subtitle: null },
      ],
    })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'bo')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('Bob')).toBeInTheDocument()
    })
    expect(screen.getByText('Pricing')).toBeInTheDocument()
    expect(screen.getByText('bob@e.com')).toBeInTheDocument()
    expect(screen.getByText('globalSearch.kind_contact')).toBeInTheDocument()
    expect(screen.getByText('globalSearch.kind_conversation')).toBeInTheDocument()
  })

  it('shows "No matches." when query returns empty', async () => {
    apiSearch.mockResolvedValue({ hits: [] })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'zz')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByText('globalSearch.no_matches')).toBeInTheDocument()
    })
  })

  it('logs non-ApiError errors and stops loading', async () => {
    apiSearch.mockRejectedValue(new Error('network'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'oops')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('swallows ApiError silently', async () => {
    const { ApiError } = await import('../lib/api')
    apiSearch.mockRejectedValue(new ApiError(403, 'forbidden', null))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'bb')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})

describe('GlobalSearch — keyboard navigation', () => {
  it('Arrow Down/Up moves activeIndex; Enter navigates to selected hit', async () => {
    apiSearch.mockResolvedValue({
      hits: [
        { kind: 'contact', id: 'c1', title: 'Bob', subtitle: null },
        { kind: 'conversation', id: 'cv1', title: 'Pricing', subtitle: null },
      ],
    })
    // jsdom doesn't navigate when location.href is set, but the assignment
    // still happens — capture it.
    const origLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...origLocation, href: '' },
    })
    render(<GlobalSearch />)
    const input = screen.getByTestId('global-search-input')
    await userEvent.type(input, 'b')
    await userEvent.type(input, 'o')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument())
    // Move to the 2nd item and press Enter.
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{Enter}')
    expect(window.location.href).toBe('/conversations/cv1')
    Object.defineProperty(window, 'location', { value: origLocation, writable: true })
  })

  it('Arrow Up does not go below 0', async () => {
    apiSearch.mockResolvedValue({
      hits: [{ kind: 'article', id: 'a1', title: 'A', subtitle: null }],
    })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'aa')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('A')).toBeInTheDocument())
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}')
    // No crash — first item remains active.
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('Escape closes the popover', async () => {
    apiSearch.mockResolvedValue({
      hits: [{ kind: 'article', id: 'a1', title: 'A1', subtitle: null }],
    })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'aa')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('A1')).toBeInTheDocument())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('A1')).not.toBeInTheDocument()
  })

  it('Enter with no hits is a no-op', async () => {
    apiSearch.mockResolvedValue({ hits: [] })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'qq')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await userEvent.keyboard('{Enter}')
    // No crash, no navigation.
    expect(screen.getByText('globalSearch.no_matches')).toBeInTheDocument()
  })
})

describe('GlobalSearch — click-outside + mouse interactions', () => {
  it('hovering a hit updates the active item', async () => {
    apiSearch.mockResolvedValue({
      hits: [
        { kind: 'contact', id: 'c1', title: 'B1', subtitle: null },
        { kind: 'contact', id: 'c2', title: 'B2', subtitle: null },
      ],
    })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'bb')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('B2')).toBeInTheDocument())
    await userEvent.hover(screen.getByText('B2'))
    expect(screen.getByText('B2').closest('a')?.className).toMatch(/bg-muted/)
  })

  it('clicking a hit closes the popover', async () => {
    apiSearch.mockResolvedValue({
      hits: [{ kind: 'contact', id: 'c1', title: 'Bob', subtitle: null }],
    })
    render(<GlobalSearch />)
    await userEvent.type(screen.getByTestId('global-search-input'), 'bb')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument())
    await userEvent.click(screen.getByText('Bob'))
    // Popover dom should be gone (open state false)
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })

  it('pointerdown outside the container closes the popover', async () => {
    apiSearch.mockResolvedValue({
      hits: [{ kind: 'contact', id: 'c1', title: 'Bob', subtitle: null }],
    })
    render(
      <div>
        <GlobalSearch />
        <button data-testid="outside">outside</button>
      </div>,
    )
    await userEvent.type(screen.getByTestId('global-search-input'), 'bb')
    await act(async () => {
      vi.advanceTimersByTime(250)
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument())
    // Dispatch a pointerdown on the outside button. jsdom doesn't ship
    // PointerEvent — use a generic Event with the right type so the listener
    // still fires.
    act(() => {
      const evt = new Event('pointerdown', { bubbles: true })
      screen.getByTestId('outside').dispatchEvent(evt)
    })
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })
})
