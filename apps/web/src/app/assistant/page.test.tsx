// This page can change members, channels and account settings, so two things
// matter more than layout: a non-administrator must never reach it, and a
// queued change must never look applied until someone approves it.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const T = (k: string, vars?: Record<string, unknown>) =>
  vars ? `${k}:${Object.values(vars).join(',')}` : k
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const listAdminAgentSessions = vi.fn()
const getAdminAgentSession = vi.fn()
const sendAdminAgentMessage = vi.fn()
const decideAdminAgentCalls = vi.fn()
vi.mock('../../lib/api', () => ({
  api: {
    listAdminAgentSessions: (...a: unknown[]) => listAdminAgentSessions(...a),
    getAdminAgentSession: (...a: unknown[]) => getAdminAgentSession(...a),
    sendAdminAgentMessage: (...a: unknown[]) => sendAdminAgentMessage(...a),
    decideAdminAgentCalls: (...a: unknown[]) => decideAdminAgentCalls(...a),
  },
  ApiError: class extends Error {},
}))

// Stable reference: in production this is React state and keeps its identity
// between renders, so the refresh callback doesn't spin.
let stored = {
  session: { token: 't' },
  account: { id: 'acc1', adminAgentRequiresApproval: true },
  membership: { role: 'ADMINISTRATOR' },
}
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => ({ session: stored }),
}))

import AssistantPage from './page'

const asAdmin = (approval = true) => {
  stored = {
    session: { token: 't' },
    account: { id: 'acc1', adminAgentRequiresApproval: approval },
    membership: { role: 'ADMINISTRATOR' },
  }
}

beforeEach(() => {
  asAdmin()
  listAdminAgentSessions.mockReset().mockResolvedValue([])
  getAdminAgentSession.mockReset()
  sendAdminAgentMessage.mockReset().mockResolvedValue({
    sessionId: 's1', reply: 'Two inboxes.', pending: [], executed: [],
  })
  decideAdminAgentCalls.mockReset()
})

async function ask(text: string) {
  await userEvent.type(screen.getByTestId('assistant-input'), text)
  await userEvent.click(screen.getByRole('button', { name: 'assistant.send' }))
}

// URL.createObjectURL doesn't exist in jsdom; attachment thumbnails need it.
beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('access', () => {
  it('refuses a non-administrator and explains why', () => {
    stored = {
      session: { token: 't' },
      account: { id: 'acc1', adminAgentRequiresApproval: true },
      membership: { role: 'AGENT' },
    }
    render(<AssistantPage />)
    expect(screen.getByText('assistant.admin_only')).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-input')).toBeNull()
  })

  it('renders nothing at all without a session', () => {
    stored = null as never
    const { container } = render(<AssistantPage />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('mode banner', () => {
  it('says changes are queued when approval is on', async () => {
    render(<AssistantPage />)
    expect(await screen.findByTestId('assistant-mode')).toHaveTextContent(
      'assistant.mode_approval',
    )
  })

  it('says changes apply immediately when approval is off', async () => {
    asAdmin(false)
    render(<AssistantPage />)
    expect(await screen.findByTestId('assistant-mode')).toHaveTextContent(
      'assistant.mode_auto',
    )
  })

  it('assumes approval is required when the stored session predates the field', async () => {
    // The cautious reading of a missing value — never assume autonomy.
    stored = {
      session: { token: 't' },
      account: { id: 'acc1' },
      membership: { role: 'ADMINISTRATOR' },
    } as never
    render(<AssistantPage />)
    expect(await screen.findByTestId('assistant-mode')).toHaveTextContent(
      'assistant.mode_approval',
    )
  })
})

describe('conversation', () => {
  it('shows the question and the answer', async () => {
    render(<AssistantPage />)
    await ask('how many inboxes?')
    expect(await screen.findByText('Two inboxes.')).toBeInTheDocument()
    expect(screen.getByText('how many inboxes?')).toBeInTheDocument()
  })

  it('starts a new session on the first message, then reuses it', async () => {
    render(<AssistantPage />)
    await ask('first')
    await screen.findByText('Two inboxes.')
    expect(sendAdminAgentMessage).toHaveBeenLastCalledWith('t', 'acc1', {
      message: 'first',
    })
    await ask('second')
    await waitFor(() =>
      expect(sendAdminAgentMessage).toHaveBeenLastCalledWith('t', 'acc1', {
        sessionId: 's1', message: 'second',
      }),
    )
  })

  it('reports which tools it consulted, in words', async () => {
    sendAdminAgentMessage.mockResolvedValue({
      sessionId: 's1', reply: 'ok', pending: [],
      executed: [{ toolName: 'list_inboxes', critical: false }],
    })
    render(<AssistantPage />)
    await ask('x')
    expect(await screen.findByText('assistantTools.list_inboxes')).toBeInTheDocument()
  })

  it('renders a markdown table from the answer instead of raw pipes', async () => {
    sendAdminAgentMessage.mockResolvedValue({
      sessionId: 's1',
      reply: '| Inbox | Mode |\n|---|---|\n| Suporte | AUTO_SAFE |',
      pending: [], executed: [],
    })
    render(<AssistantPage />)
    await ask('list the inboxes')
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'AUTO_SAFE' })).toBeInTheDocument()
  })

  it('opens the data behind an answer', async () => {
    sendAdminAgentMessage.mockResolvedValue({
      sessionId: 's1', reply: 'You spent very little.', pending: [],
      executed: [
        { toolName: 'ai_spend', critical: false, output: { monthToDateUsd: 0.0869 } },
      ],
    })
    render(<AssistantPage />)
    await ask('spend?')
    await userEvent.click(await screen.findByTestId('tool-chip-ai_spend'))
    expect(screen.getByText('$0.09')).toBeInTheDocument()
  })

  it('sends on Enter but not on Shift+Enter', async () => {
    render(<AssistantPage />)
    const box = screen.getByTestId('assistant-input')
    await userEvent.type(box, 'hi{Shift>}{Enter}{/Shift}')
    expect(sendAdminAgentMessage).not.toHaveBeenCalled()
    await userEvent.type(box, '{Enter}')
    await waitFor(() => expect(sendAdminAgentMessage).toHaveBeenCalled())
  })

  it('surfaces an API failure instead of a blank reply', async () => {
    sendAdminAgentMessage.mockRejectedValue(new Error('boom'))
    render(<AssistantPage />)
    await ask('x')
    expect(await screen.findByText('errors.generic')).toBeInTheDocument()
  })

  it('ignores an empty message', async () => {
    render(<AssistantPage />)
    await userEvent.type(screen.getByTestId('assistant-input'), '   {Enter}')
    expect(sendAdminAgentMessage).not.toHaveBeenCalled()
  })

  it('offers starter questions and fills the box with one', async () => {
    render(<AssistantPage />)
    await userEvent.click(screen.getByText('assistant.suggest_spend'))
    expect(screen.getByTestId('assistant-input')).toHaveValue(
      'assistant.suggest_spend',
    )
  })
})

describe('approvals', () => {
  const withPending = {
    sessionId: 's1',
    reply: 'I can switch that inbox to AUTO_FULL.',
    pending: [
      { id: 'call1', toolName: 'set_inbox_ai_mode', input: { inboxId: 'i1', mode: 'AUTO_FULL' } },
    ],
    executed: [],
  }

  it('shows what is about to change, field by field', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    render(<AssistantPage />)
    await ask('switch it to auto')
    expect(await screen.findByTestId('assistant-approval')).toBeInTheDocument()
    expect(screen.getByText('assistantTools.set_inbox_ai_mode')).toBeInTheDocument()
    expect(screen.getByText('assistantValues.auto_full')).toBeInTheDocument()
  })

  it('applies only after approval, and says so', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    decideAdminAgentCalls.mockResolvedValue([
      { id: 'call1', toolName: 'set_inbox_ai_mode', status: 'CONFIRMED' },
    ])
    render(<AssistantPage />)
    await ask('switch it')
    await userEvent.click(await screen.findByRole('button', { name: 'assistant.approve' }))
    expect(decideAdminAgentCalls).toHaveBeenCalledWith('t', 'acc1', 's1', [
      { id: 'call1', approve: true },
    ])
    expect(
      await screen.findByText('assistant.applied:set_inbox_ai_mode'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('assistant-approval')).toBeNull()
  })

  it('says plainly that nothing changed when rejected', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    decideAdminAgentCalls.mockResolvedValue([
      { id: 'call1', toolName: 'set_inbox_ai_mode', status: 'REJECTED' },
    ])
    render(<AssistantPage />)
    await ask('switch it')
    await userEvent.click(await screen.findByRole('button', { name: 'assistant.reject' }))
    expect(
      await screen.findByText('assistant.rejected:set_inbox_ai_mode'),
    ).toBeInTheDocument()
  })

  it('reports a failed approval as failed, not applied', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    decideAdminAgentCalls.mockResolvedValue([
      { id: 'call1', toolName: 'set_inbox_ai_mode', status: 'ERROR' },
    ])
    render(<AssistantPage />)
    await ask('switch it')
    await userEvent.click(await screen.findByRole('button', { name: 'assistant.approve' }))
    expect(
      await screen.findByText('assistant.failed:set_inbox_ai_mode'),
    ).toBeInTheDocument()
  })

  it('offers a bulk decision only when more than one call is queued', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    render(<AssistantPage />)
    await ask('one change')
    await screen.findByTestId('assistant-approval')
    expect(screen.queryByRole('button', { name: 'assistant.approve_all' })).toBeNull()

    sendAdminAgentMessage.mockResolvedValue({
      ...withPending,
      pending: [
        ...withPending.pending,
        { id: 'call2', toolName: 'set_member_role', input: { userId: 'u9', role: 'AGENT' } },
      ],
    })
    await ask('two changes')
    expect(
      await screen.findByRole('button', { name: 'assistant.approve_all' }),
    ).toBeInTheDocument()
  })

  it('decides every queued call at once', async () => {
    sendAdminAgentMessage.mockResolvedValue({
      ...withPending,
      pending: [
        ...withPending.pending,
        { id: 'call2', toolName: 'set_member_role', input: {} },
      ],
    })
    decideAdminAgentCalls.mockResolvedValue([])
    render(<AssistantPage />)
    await ask('two changes')
    await userEvent.click(
      await screen.findByRole('button', { name: 'assistant.reject_all' }),
    )
    expect(decideAdminAgentCalls).toHaveBeenCalledWith('t', 'acc1', 's1', [
      { id: 'call1', approve: false },
      { id: 'call2', approve: false },
    ])
  })

  it('surfaces a failure to record the decision', async () => {
    sendAdminAgentMessage.mockResolvedValue(withPending)
    decideAdminAgentCalls.mockRejectedValue(new Error('nope'))
    render(<AssistantPage />)
    await ask('switch it')
    await userEvent.click(await screen.findByRole('button', { name: 'assistant.approve' }))
    expect(await screen.findByText('errors.generic')).toBeInTheDocument()
  })
})

describe('session history', () => {
  it('lists past sessions and reopens one', async () => {
    listAdminAgentSessions.mockResolvedValue([
      { id: 's7', title: 'Budget check', lastActiveAt: '', createdAt: '', totalCostUsd: 0.1 },
    ])
    getAdminAgentSession.mockResolvedValue({
      id: 's7', title: 'Budget check', totalCostUsd: 0.1,
      transcript: [{ role: 'user', text: 'budget?' }, { role: 'assistant', text: '$4.20' }],
      toolCalls: [],
    })
    render(<AssistantPage />)
    await userEvent.click(await screen.findByText('Budget check'))
    expect(await screen.findByText('$4.20')).toBeInTheDocument()
  })

  it('restores approvals that were still pending when the page was closed', async () => {
    // A queued change nobody decided is not a change that went away.
    listAdminAgentSessions.mockResolvedValue([
      { id: 's7', title: 'Half-done', lastActiveAt: '', createdAt: '', totalCostUsd: 0 },
    ])
    getAdminAgentSession.mockResolvedValue({
      id: 's7', title: 'Half-done', totalCostUsd: 0, transcript: [],
      toolCalls: [
        { id: 'c1', toolName: 'set_member_role', input: { userId: 'u9' }, output: null, status: 'PENDING', critical: true, createdAt: '' },
        { id: 'c2', toolName: 'list_inboxes', input: {}, output: {}, status: 'SUCCESS', critical: false, createdAt: '' },
      ],
    })
    render(<AssistantPage />)
    await userEvent.click(await screen.findByText('Half-done'))
    expect(await screen.findByTestId('assistant-approval')).toBeInTheDocument()
    expect(screen.getAllByTestId('assistant-approval')).toHaveLength(1)
  })

  it('handles a tool call stored without input', async () => {
    listAdminAgentSessions.mockResolvedValue([
      { id: 's7', title: 'X', lastActiveAt: '', createdAt: '', totalCostUsd: 0 },
    ])
    getAdminAgentSession.mockResolvedValue({
      id: 's7', title: 'X', totalCostUsd: 0, transcript: [],
      toolCalls: [
        { id: 'c1', toolName: 'set_member_role', input: null, output: null, status: 'PENDING', critical: true, createdAt: '' },
      ],
    })
    render(<AssistantPage />)
    await userEvent.click(await screen.findByText('X'))
    expect(await screen.findByTestId('assistant-approval')).toBeInTheDocument()
  })

  it('surfaces a failure to open a session', async () => {
    listAdminAgentSessions.mockResolvedValue([
      { id: 's7', title: 'Broken', lastActiveAt: '', createdAt: '', totalCostUsd: 0 },
    ])
    getAdminAgentSession.mockRejectedValue(new Error('gone'))
    render(<AssistantPage />)
    await userEvent.click(await screen.findByText('Broken'))
    expect(await screen.findByText('errors.generic')).toBeInTheDocument()
  })

  it('keeps working when the session list cannot be loaded', async () => {
    listAdminAgentSessions.mockRejectedValue(new Error('offline'))
    render(<AssistantPage />)
    expect(await screen.findByText('assistant.no_sessions')).toBeInTheDocument()
    await ask('still works')
    await waitFor(() => expect(sendAdminAgentMessage).toHaveBeenCalled())
  })

  it('falls back to a placeholder for an untitled session', async () => {
    listAdminAgentSessions.mockResolvedValue([
      { id: 's7', title: null, lastActiveAt: '', createdAt: '', totalCostUsd: 0 },
    ])
    render(<AssistantPage />)
    expect(await screen.findByText('assistant.untitled')).toBeInTheDocument()
  })

  it('clears the thread when starting a new chat', async () => {
    render(<AssistantPage />)
    await ask('hello')
    await screen.findByText('Two inboxes.')
    await userEvent.click(screen.getByRole('button', { name: 'assistant.new_chat' }))
    expect(screen.queryByText('Two inboxes.')).toBeNull()
    // And the next message must start a fresh session, not append to the old.
    await ask('again')
    await waitFor(() =>
      expect(sendAdminAgentMessage).toHaveBeenLastCalledWith('t', 'acc1', {
        message: 'again',
      }),
    )
  })

  it('drops a turn with no prose and no tools rather than rendering an empty bubble', async () => {
    sendAdminAgentMessage.mockResolvedValue({
      sessionId: 's1', reply: '', pending: [], executed: [],
    })
    render(<AssistantPage />)
    await ask('x')
    await waitFor(() =>
      expect(screen.getAllByTestId('assistant-turn-user')).toHaveLength(1),
    )
    expect(screen.queryByTestId('assistant-turn-assistant')).toBeNull()
  })

  it('attaches a file and sends it with the message', async () => {
    render(<AssistantPage />)
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    await userEvent.upload(screen.getByTestId('file-input'), file)
    expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('shot.png')
    await ask('what is this?')
    await waitFor(() =>
      expect(sendAdminAgentMessage).toHaveBeenCalledWith('t', 'acc1', {
        message: 'what is this?',
        attachments: [
          expect.objectContaining({ name: 'shot.png', mediaType: 'image/png' }),
        ],
      }),
    )
  })

  it('refuses a file type the model cannot read', async () => {
    // The file picker's `accept` filters this out, but drag-and-drop does
    // not — so the guard has to hold on its own. applyAccept:false reproduces
    // the drop path.
    render(<AssistantPage />)
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })
    await userEvent.upload(screen.getByTestId('file-input'), file, {
      applyAccept: false,
    })
    expect(await screen.findByText(/attach_bad_type/)).toBeInTheDocument()
    expect(screen.queryByTestId('attachment-chip')).toBeNull()
  })

  it('refuses a file too large for the API to accept', async () => {
    render(<AssistantPage />)
    const big = new File([new Uint8Array(4_000_000)], 'huge.png', { type: 'image/png' })
    await userEvent.upload(screen.getByTestId('file-input'), big)
    expect(await screen.findByText(/attach_too_big/)).toBeInTheDocument()
    expect(screen.queryByTestId('attachment-chip')).toBeNull()
  })

  it('clears attachments when starting a new chat', async () => {
    render(<AssistantPage />)
    await userEvent.upload(
      screen.getByTestId('file-input'),
      new File(['x'], 'a.png', { type: 'image/png' }),
    )
    await screen.findByTestId('attachment-chip')
    await userEvent.click(screen.getByRole('button', { name: /assistant.new_chat/ }))
    expect(screen.queryByTestId('attachment-chip')).toBeNull()
  })
})
