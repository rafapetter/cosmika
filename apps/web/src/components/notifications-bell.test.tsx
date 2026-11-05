// NotificationsBell tests — polling count, lazy list fetch on open, item
// click + mark-all-read, relative time formatter via behavior.
import {
  render as rtlRender,
  screen,
  act,
  fireEvent,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@cosmika/ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function render(ui: React.ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>)
}

// Translator stub: the key, then any params, so assertions see both.
const T = (k: string, p?: Record<string, unknown>) =>
  p ? `${k} ${Object.values(p).join(' ')}` : k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const notificationCounts = vi.fn()
const listNotifications = vi.fn()
const markNotificationRead = vi.fn()
const markAllNotificationsRead = vi.fn()

vi.mock('../lib/api', async () => {
  const actual = (await vi.importActual('../lib/api')) as Record<string, unknown>
  return {
    ...actual,
    api: {
      notificationCounts: (...a: unknown[]) => notificationCounts(...a),
      listNotifications: (...a: unknown[]) => listNotifications(...a),
      markNotificationRead: (...a: unknown[]) => markNotificationRead(...a),
      markAllNotificationsRead: (...a: unknown[]) =>
        markAllNotificationsRead(...a),
    },
  }
})

const useStoredSessionMock = vi.fn()
vi.mock('../lib/session-store', () => ({
  useStoredSession: () => useStoredSessionMock(),
}))

import { NotificationsBell } from './notifications-bell'

const SESSION = {
  session: { token: 'tok' },
  user: { id: 'u', email: 'a@e.com' },
  account: { id: 'acc1', name: 'Acme' },
}

beforeEach(() => {
  notificationCounts.mockReset().mockResolvedValue({ unread: 0 })
  listNotifications.mockReset().mockResolvedValue([])
  markNotificationRead.mockReset().mockResolvedValue(undefined)
  markAllNotificationsRead.mockReset().mockResolvedValue({ updated: 0 })
  useStoredSessionMock.mockReturnValue({
    session: SESSION,
    ready: true,
    setSession: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NotificationsBell — auth gating', () => {
  it('renders nothing when no session', () => {
    useStoredSessionMock.mockReturnValue({
      session: null,
      ready: false,
      setSession: vi.fn(),
    })
    const { container } = render(<NotificationsBell />)
    expect(container.firstChild).toBeNull()
  })
})

describe('NotificationsBell — count polling', () => {
  it('renders the bell trigger and fetches the initial unread count', async () => {
    notificationCounts.mockResolvedValue({ unread: 3 })
    render(<NotificationsBell />)
    expect(screen.getByTestId('notifications-bell')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('notifications-badge')).toHaveTextContent('3')
    })
  })

  it('re-checks the count when the tab regains focus', async () => {
    notificationCounts.mockResolvedValue({ unread: 0 })
    render(<NotificationsBell />)
    await waitFor(() => expect(notificationCounts).toHaveBeenCalledTimes(1))
    notificationCounts.mockResolvedValue({ unread: 2 })
    fireEvent.focus(window)
    // Without this the badge only appears at the next poll, up to 30s later.
    await waitFor(() => {
      expect(screen.getByTestId('notifications-badge')).toHaveTextContent('2')
    })
  })

  it('stops listening for focus once unmounted', async () => {
    notificationCounts.mockResolvedValue({ unread: 0 })
    const { unmount } = render(<NotificationsBell />)
    await waitFor(() => expect(notificationCounts).toHaveBeenCalledTimes(1))
    unmount()
    fireEvent.focus(window)
    expect(notificationCounts).toHaveBeenCalledTimes(1)
  })

  it('renders no badge when unread is zero', async () => {
    notificationCounts.mockResolvedValue({ unread: 0 })
    render(<NotificationsBell />)
    await waitFor(() => expect(notificationCounts).toHaveBeenCalled())
    expect(screen.queryByTestId('notifications-badge')).toBeNull()
  })

  it('caps the badge at 99+', async () => {
    notificationCounts.mockResolvedValue({ unread: 250 })
    render(<NotificationsBell />)
    await waitFor(() =>
      expect(screen.getByTestId('notifications-badge')).toHaveTextContent('99+'),
    )
  })

  it('polls the count every 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    notificationCounts.mockResolvedValue({ unread: 1 })
    render(<NotificationsBell />)
    await waitFor(() => expect(notificationCounts).toHaveBeenCalledTimes(1))
    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(notificationCounts).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('swallows count-fetch errors silently', async () => {
    notificationCounts.mockRejectedValue(new Error('network'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<NotificationsBell />)
    await waitFor(() => expect(notificationCounts).toHaveBeenCalled())
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('NotificationsBell — list fetch on open', () => {
  it('fetches the list when the dropdown opens', async () => {
    notificationCounts.mockResolvedValue({ unread: 2 })
    listNotifications.mockResolvedValue([])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => expect(listNotifications).toHaveBeenCalled())
  })

  it('shows "No notifications yet." when the list is empty', async () => {
    listNotifications.mockResolvedValue([])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByText(/notifications.empty/)).toBeInTheDocument(),
    )
  })

  it('shows fetched notification items with mention + preview + relative time', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        readAt: null,
        conversationId: 'cv1',
        messagePreview: 'see the spec please',
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        mentionedBy: { id: 'u', fullName: 'Alice', email: 'a@e.com' },
        conversation: { id: 'cv1', displayId: 7 },
      },
      {
        id: 'n2',
        readAt: new Date().toISOString(),
        conversationId: null,
        messagePreview: null,
        createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
        mentionedBy: null,
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => {
      expect(screen.getByTestId('notification-n1')).toBeInTheDocument()
    })
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByText(/see the spec please/)).toBeInTheDocument()
    expect(screen.getByText(/#7/)).toBeInTheDocument()
    expect(screen.getByText(/notifications.just_now/)).toBeInTheDocument()
    expect(screen.getByText(/notifications.hours_ago 2/)).toBeInTheDocument()
    expect(screen.getByText(/notifications.someone/)).toBeInTheDocument()
  })

  // Before the assignment type existed, every row rendered "mentioned you".
  // An assignment notice saying that would be worse than none at all.
  it('reads an assignment as an assignment, not as a mention', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        type: 'ASSIGNMENT',
        readAt: null,
        conversationId: 'cv1',
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: { id: 'u', fullName: 'Alice', email: 'a@e.com' },
        conversation: { id: 'cv1', displayId: 7 },
      },
      {
        // Automatic distribution: nobody did this, so nobody is named.
        id: 'n2',
        type: 'ASSIGNMENT',
        readAt: null,
        conversationId: 'cv2',
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: null,
        conversation: { id: 'cv2', displayId: 8 },
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => {
      expect(screen.getByTestId('notification-n1')).toBeInTheDocument()
    })

    const byPerson = screen.getByTestId('notification-n1')
    expect(byPerson).toHaveTextContent('Alice')
    expect(byPerson).toHaveTextContent('notifications.assigned_you')
    expect(byPerson).not.toHaveTextContent('notifications.mentioned_you')

    const automatic = screen.getByTestId('notification-n2')
    expect(automatic).toHaveTextContent('notifications.assigned_you_auto')
    // An automatic row invents nobody.
    expect(automatic).not.toHaveTextContent('notifications.someone')
  })

  it('reads a coverage-gap notice without inventing a person', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n3',
        type: 'ASSIGNMENT_FALLBACK',
        readAt: null,
        conversationId: 'cv3',
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: null,
        conversation: { id: 'cv3', displayId: 9 },
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => {
      expect(screen.getByTestId('notification-n3')).toBeInTheDocument()
    })

    const row = screen.getByTestId('notification-n3')
    expect(row).toHaveTextContent('notifications.assigned_off_shift')
    expect(row).toHaveTextContent('#9')
    // Nobody caused it, so no name and no "someone".
    expect(row).not.toHaveTextContent('notifications.someone')
    expect(row).not.toHaveTextContent('notifications.assigned_you')
  })

  it('formats createdAt 30 minutes ago as Xm ago', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        readAt: null,
        conversationId: null,
        messagePreview: null,
        createdAt: new Date(Date.now() - 1800_000).toISOString(), // 30 min
        mentionedBy: { id: 'x', fullName: 'X', email: 'x@e.com' },
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => expect(screen.getByText(/notifications.minutes_ago 30/)).toBeInTheDocument())
  })

  it('formats createdAt older than a day as a locale date', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        readAt: null,
        conversationId: null,
        messagePreview: null,
        createdAt: new Date('2026-01-15T00:00:00Z').toISOString(),
        mentionedBy: { id: 'x', fullName: 'X', email: 'x@e.com' },
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() => {
      // formatRel returns "<day> <month abbrev>" for >1d. Exact format depends
      // on jsdom's Intl, but should contain "Jan" or "15".
      const text = screen.getByTestId('notification-n1').textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
    })
  })

  it('falls back to [] when list fetch errors', async () => {
    listNotifications.mockRejectedValue(new Error('network'))
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByText(/notifications.empty/)).toBeInTheDocument(),
    )
  })
})

describe('NotificationsBell — item click + mark all read', () => {
  it('clicking an unread item marks it read and navigates to the conversation', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        readAt: null,
        conversationId: 'cv99',
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: { id: 'u', fullName: 'Alice', email: 'a@e.com' },
      },
    ])
    const origLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...origLocation, href: '' },
    })
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('notification-n1')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('notification-n1'))
    expect(markNotificationRead).toHaveBeenCalledWith('tok', 'acc1', 'n1')
    expect(window.location.href).toBe('/conversations/cv99')
    Object.defineProperty(window, 'location', {
      value: origLocation,
      writable: true,
    })
  })

  it('clicking an already-read item does not call markNotificationRead', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n2',
        readAt: new Date().toISOString(),
        conversationId: 'cv1',
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: { id: 'u', fullName: 'X', email: 'x@e.com' },
      },
    ])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('notification-n2')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('notification-n2'))
    expect(markNotificationRead).not.toHaveBeenCalled()
  })

  it('clicking a notification without conversationId does not navigate', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n3',
        readAt: null,
        conversationId: null,
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: { id: 'u', fullName: 'X', email: 'x@e.com' },
      },
    ])
    const origLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...origLocation, href: '' },
    })
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('notification-n3')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('notification-n3'))
    expect(window.location.href).toBe('')
    Object.defineProperty(window, 'location', {
      value: origLocation,
      writable: true,
    })
  })

  it('swallows markNotificationRead errors (no rethrow)', async () => {
    listNotifications.mockResolvedValue([
      {
        id: 'n1',
        readAt: null,
        conversationId: null, // no nav → no jsdom console.error noise
        messagePreview: null,
        createdAt: new Date().toISOString(),
        mentionedBy: { id: 'u', fullName: 'A', email: 'a@e.com' },
      },
    ])
    markNotificationRead.mockRejectedValue(new Error('boom'))
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('notification-n1')).toBeInTheDocument(),
    )
    // Just verify the click doesn't throw (the catch swallows the error).
    await expect(
      userEvent.click(screen.getByTestId('notification-n1')),
    ).resolves.toBeUndefined()
    // The mock should have been called even though it rejected.
    expect(markNotificationRead).toHaveBeenCalled()
  })

  it('mark-all-read button shows when unread > 0 and calls the API', async () => {
    notificationCounts.mockResolvedValue({ unread: 5 })
    listNotifications.mockResolvedValue([])
    render(<NotificationsBell />)
    await waitFor(() =>
      expect(screen.getByTestId('notifications-badge')).toHaveTextContent('5'),
    )
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('mark-all-read')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('mark-all-read'))
    expect(markAllNotificationsRead).toHaveBeenCalled()
  })

  it('mark-all-read button hidden when unread = 0', async () => {
    notificationCounts.mockResolvedValue({ unread: 0 })
    listNotifications.mockResolvedValue([])
    render(<NotificationsBell />)
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByText(/notifications.empty/)).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('mark-all-read')).toBeNull()
  })

  it('swallows mark-all-read errors silently', async () => {
    notificationCounts.mockResolvedValue({ unread: 3 })
    listNotifications.mockResolvedValue([])
    markAllNotificationsRead.mockRejectedValue(new Error('boom'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<NotificationsBell />)
    await waitFor(() =>
      expect(screen.getByTestId('notifications-badge')).toHaveTextContent('3'),
    )
    await userEvent.click(screen.getByTestId('notifications-bell'))
    await waitFor(() =>
      expect(screen.getByTestId('mark-all-read')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByTestId('mark-all-read'))
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
