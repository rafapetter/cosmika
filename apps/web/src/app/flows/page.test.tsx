import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stable translator: keys render as-is, params are ignored.
const T = (k: string) => k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

// next/link → plain anchor for jsdom.
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: unknown }) => (
    <a href={typeof href === 'string' ? href : (href as { pathname?: string })?.pathname} {...rest}>
      {children}
    </a>
  ),
}))

const apiMock = vi.hoisted(() => ({
  listFlows: vi.fn(),
  createFlow: vi.fn(),
  publishFlow: vi.fn(),
  deleteFlow: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}))

const SESSION = {
  session: { token: 'tok', expiresAt: new Date('2030-01-01').toISOString() },
  user: { id: 'u1', name: 'A', email: 'a@b.c' },
  account: { id: 'acc1', name: 'Acme' },
}
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => ({ session: SESSION }),
}))

import FlowsPage from './page'

beforeEach(() => {
  apiMock.listFlows.mockResolvedValue([
    { id: 'f1', name: 'Support menu', status: 'DRAFT', hasPublished: false, updatedAt: '2026-06-20T00:00:00.000Z' },
  ])
  apiMock.createFlow.mockResolvedValue({})
  apiMock.publishFlow.mockResolvedValue({ flow: {}, checks: [] })
  apiMock.deleteFlow.mockResolvedValue({})
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => vi.clearAllMocks())

describe('FlowsPage', () => {
  it('lists flows from the API', async () => {
    render(<FlowsPage />)
    expect(await screen.findByText('Support menu')).toBeInTheDocument()
    expect(screen.getByText('flows.draft_only')).toBeInTheDocument()
    expect(screen.getByText('flows.status_draft')).toBeInTheDocument()
  })

  it('creates a flow with a starter definition', async () => {
    render(<FlowsPage />)
    await screen.findByText('Support menu')
    fireEvent.change(screen.getByTestId('flow-name'), { target: { value: 'New flow' } })
    fireEvent.click(screen.getByTestId('flow-create'))
    await waitFor(() => expect(apiMock.createFlow).toHaveBeenCalled())
    const [, , body] = apiMock.createFlow.mock.calls[0]!
    expect(body.name).toBe('New flow')
    expect(body.definition.groups).toHaveLength(1)
    expect(body.definition.startGroupId).toBe(body.definition.groups[0].id)
    // The starter group and greeting are written in the viewer's language.
    expect(body.definition.groups[0].title).toBe('flows.start_group')
    expect(body.definition.groups[0].blocks[0].options.content).toBe('flows.starter_message')
  })

  it('publishes and deletes a flow', async () => {
    render(<FlowsPage />)
    await screen.findByText('Support menu')
    fireEvent.click(screen.getByTestId('flow-publish-f1'))
    await waitFor(() => expect(apiMock.publishFlow).toHaveBeenCalledWith('tok', 'acc1', 'f1'))
    // The row disables its buttons while a publish is in flight. Waiting only
    // for the call to be recorded leaves the re-render that clears `busyId`
    // racing us, so the delete click could land on a disabled button and do
    // nothing. Wait for the row to be idle again before the second click.
    await waitFor(() => expect(screen.getByTestId('flow-delete-f1')).toBeEnabled())
    fireEvent.click(screen.getByTestId('flow-delete-f1'))
    await waitFor(() => expect(apiMock.deleteFlow).toHaveBeenCalledWith('tok', 'acc1', 'f1'))
  })

  it('surfaces an error when listing fails', async () => {
    apiMock.listFlows.mockRejectedValueOnce(new (class extends Error {})('boom'))
    render(<FlowsPage />)
    // Not an ApiError (different class) → the generic wording
    expect(await screen.findByTestId('flows-error')).toHaveTextContent('errors.generic')
  })

  it('shows the empty state when there are no flows', async () => {
    apiMock.listFlows.mockResolvedValueOnce([])
    render(<FlowsPage />)
    expect(await screen.findByTestId('flows-empty')).toBeInTheDocument()
  })
})

describe('FlowsPage — publish checks', () => {
  it('says how many points to review and sends the author to the flow', async () => {
    apiMock.publishFlow.mockResolvedValue({
      flow: {},
      checks: [
        { code: 'unreachable_group', groupId: 'g2', groupTitle: 'Falar com consultor' },
      ],
    })
    render(<FlowsPage />)
    await waitFor(() => expect(screen.getByTestId('flow-publish-f1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('flow-publish-f1'))
    await waitFor(() => expect(screen.getByTestId('flows-checks')).toBeTruthy())
  })

  it('stays quiet when the flow is clean', async () => {
    apiMock.publishFlow.mockResolvedValue({ flow: {}, checks: [] })
    render(<FlowsPage />)
    await waitFor(() => expect(screen.getByTestId('flow-publish-f1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('flow-publish-f1'))
    await waitFor(() => expect(apiMock.publishFlow).toHaveBeenCalled())
    expect(screen.queryByTestId('flows-checks')).toBeNull()
  })
})
