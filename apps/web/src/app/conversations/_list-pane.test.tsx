// The console list must update itself when the account changes under it —
// new message, new conversation, status flip — without the user refreshing.
// The realtime handler is throttled: a burst of events costs one reload.
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
// Hoisted stable objects — a fresh object per render re-runs the load effect
// forever (silent OOM loop in jsdom).
const ROUTER = { push: vi.fn(), replace: vi.fn() }
const SEARCH_PARAMS = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ROUTER,
  usePathname: () => '/conversations',
  useSearchParams: () => SEARCH_PARAMS,
}))

// Capture the realtime handler so tests can inject events like the gateway.
let realtimeHandler: ((event: Record<string, unknown>) => void) | null = null
vi.mock('../../lib/use-realtime', () => ({
  useRealtime: (_token: string | null, onEvent: (e: never) => void) => {
    realtimeHandler = onEvent as never
  },
}))

const listConversations = vi.fn()
const listInboxes = vi.fn().mockResolvedValue([])
vi.mock('../../lib/api', () => ({
  api: {
    listConversations: (...a: unknown[]) => listConversations(...a),
    listInboxes: (...a: unknown[]) => listInboxes(...a),
    listLabels: vi.fn().mockResolvedValue([]),
    listTeams: vi.fn().mockResolvedValue([]),
    listSavedViews: vi.fn().mockResolvedValue([]),
    createSavedView: vi.fn(),
    deleteSavedView: vi.fn(),
    bulkConversations: vi.fn(),
  },
  ApiError: class extends Error {
    status: number
    constructor(status = 500) {
      super('api')
      this.status = status
    }
  },
}))

const STORED = {
  session: { token: 't' },
  account: { id: 'acc1' },
  membership: { role: 'ADMINISTRATOR' },
}
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => ({ session: STORED, ready: true }),
}))

import { ConversationListPane } from './_list-pane'

const conversation = {
  id: 'cv1',
  displayId: 8442,
  accountId: 'acc1',
  inboxId: 'inb1',
  status: 'OPEN',
  controlMode: 'HUMAN',
  priority: null,
  contact: { id: 'ct1', name: 'Depto TI', email: null, phoneNumber: '5519' },
  assignee: null,
  team: null,
  labels: [],
  lastMessage: { content: 'Precisamos de suporte', senderType: 'CONTACT', createdAt: '2026-08-21T14:53:00.000Z' },
  unreadCount: 1,
  createdAt: '2026-08-21T12:00:00.000Z',
  lastActivityAt: '2026-08-21T14:53:00.000Z',
}

beforeEach(() => {
  vi.useFakeTimers()
  realtimeHandler = null
  listConversations
    .mockReset()
    .mockResolvedValue({ data: [conversation], nextCursor: null })
})

// Hand the clock back. Vitest restores timers between files, so this file
// was not leaking, but leaving fakes installed means anything appended here
// later inherits them by accident.
afterEach(() => {
  vi.useRealTimers()
})

async function renderPane() {
  render(<ConversationListPane />)
  // Flush the initial load without real timers.
  await act(async () => {
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(listConversations).toHaveBeenCalled())
}

describe('ConversationListPane realtime refresh', () => {
  it('reloads the list when a message or conversation event arrives', async () => {
    await renderPane()
    const before = listConversations.mock.calls.length
    expect(realtimeHandler).not.toBeNull()
    act(() => {
      realtimeHandler!({ type: 'MessageCreated', accountId: 'acc1', conversationId: 'cvX' })
    })
    await act(async () => {
      vi.advanceTimersByTime(900)
      await Promise.resolve()
    })
    expect(listConversations.mock.calls.length).toBe(before + 1)
  })

  it('collapses a burst of events into one reload', async () => {
    await renderPane()
    const before = listConversations.mock.calls.length
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        realtimeHandler!({ type: 'ConversationCreated', accountId: 'acc1', conversationId: `c${i}` })
        realtimeHandler!({ type: 'MessageCreated', accountId: 'acc1', conversationId: `c${i}` })
      }
    })
    await act(async () => {
      vi.advanceTimersByTime(900)
      await Promise.resolve()
    })
    expect(listConversations.mock.calls.length).toBe(before + 1)
  })

  it('ignores events that cannot change the list', async () => {
    await renderPane()
    const before = listConversations.mock.calls.length
    act(() => {
      realtimeHandler!({ type: 'MessageStatusChanged', accountId: 'acc1', messageId: 'm1', status: 'READ' })
      realtimeHandler!({ type: 'Connected', accountId: 'acc1' })
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(listConversations.mock.calls.length).toBe(before)
  })
})


describe('ConversationListPane channel label', () => {
  it("shows each conversation's channel next to its inbox", async () => {
    listInboxes.mockResolvedValueOnce([{ id: 'inb1', name: 'Atendimento', channelType: 'INSTAGRAM' }])
    await renderPane()
    await act(async () => {
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('conversation-channel').textContent).toBe('inboxes.channel_instagram'),
    )
    expect(screen.getByText('Atendimento')).toBeTruthy()
  })
})
