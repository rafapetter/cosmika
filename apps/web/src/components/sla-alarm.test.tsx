import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
let handler: ((e: Record<string, unknown>) => void) | null = null
vi.mock('../lib/use-realtime', () => ({
  useRealtime: (_t: string | null, cb: (e: never) => void) => {
    handler = cb as never
  },
}))
const SESSION = { session: { token: 't' }, user: { id: 'me' }, account: { id: 'acc1' } }
vi.mock('../lib/session-store', () => ({ useStoredSession: () => ({ session: SESSION, ready: true }) }))

import { SlaAlarm } from './sla-alarm'

const breach = (over: Record<string, unknown> = {}) => ({
  type: 'SlaBreached',
  accountId: 'acc1',
  conversationId: 'cv1',
  displayId: 42,
  inboxId: 'inb1',
  teamId: 't1',
  assigneeId: null,
  dimension: 'firstResponse',
  targetAt: '2026-10-16T12:01:00.000Z',
  userIds: ['me'],
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  handler = null
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SlaAlarm', () => {
  it('raises a banner for me, links the conversation, and nudges the bell', () => {
    const nudged = vi.fn()
    window.addEventListener('cosmika:notifications-refresh', nudged)
    render(<SlaAlarm />)
    act(() => handler!(breach()))
    expect(screen.getByTestId('sla-alarm').textContent).toContain('slaAlarm.body:{"displayId":42}')
    expect(screen.getByRole('link').getAttribute('href')).toBe('/conversations/cv1')
    expect(nudged).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.queryByTestId('sla-alarm')).toBeNull()
    window.removeEventListener('cosmika:notifications-refresh', nudged)
  })

  it('ignores breaches meant for others and unrelated events', () => {
    render(<SlaAlarm />)
    act(() => handler!(breach({ userIds: ['someone-else'] })))
    act(() => handler!({ type: 'MessageCreated' }))
    expect(screen.queryByTestId('sla-alarm')).toBeNull()
  })

  it('can be dismissed, and keeps one banner per conversation', () => {
    render(<SlaAlarm />)
    act(() => handler!(breach()))
    act(() => handler!(breach()))
    expect(screen.getAllByTestId('sla-alarm')).toHaveLength(1)
    act(() => screen.getByLabelText('common.close').click())
    expect(screen.queryByTestId('sla-alarm')).toBeNull()
  })
})
