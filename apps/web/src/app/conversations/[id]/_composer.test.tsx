// Composer attachment tests — upload on pick, staged chips, attachment-only
// sends, and the send button's enable rules.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// next-intl — return the translation key so we can assert on labels.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key, useLocale: () => 'pt-BR'
}))

import { Composer } from './_composer'

function setup(over: Record<string, unknown> = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined)
  const onUpload = vi.fn().mockResolvedValue('att-1')
  render(
    <Composer
      onSend={onSend}
      onUpload={onUpload}
      sending={false}
      replyTo={null}
      onClearReply={() => {}}
      cannedResponses={[]}
      accountMembers={[]}
      currentUserId="u1"
      {...over}
    />,
  )
  return { onSend, onUpload }
}

/** Like `setup`, but keeps the handle so a test can re-render with new props. */
function renderComposer(over: Record<string, unknown> = {}) {
  const props = {
    onSend: vi.fn().mockResolvedValue(undefined),
    onUpload: vi.fn().mockResolvedValue('att-1'),
    sending: false,
    replyTo: null,
    onClearReply: () => {},
    cannedResponses: [],
    accountMembers: [],
    currentUserId: 'u1',
    ...over,
  }
  const view = render(<Composer {...(props as never)} />)
  return {
    rerender: (next: Record<string, unknown>) =>
      view.rerender(<Composer {...({ ...props, ...next } as never)} />),
  }
}

function file(name = 'photo.png', type = 'image/png', size = 1234) {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('Composer — attachments', () => {
  it('uploads on pick and stages a chip', async () => {
    const { onUpload } = setup()
    const input = screen.getByTestId('composer-file-input')
    await userEvent.upload(input, file())
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachment-chip')).toBeInTheDocument(),
    )
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('photo.png')).toBeInTheDocument()
  })

  it('enables send for an attachment with no text — the whole point', async () => {
    setup()
    const send = screen.getByTestId('composer-send')
    expect(send).toBeDisabled()
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() => expect(send).toBeEnabled())
  })

  it('sends attachmentIds and clears the staged files', async () => {
    const { onSend } = setup()
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled())
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenCalledWith({
      content: '',
      isPrivate: false,
      inReplyToId: undefined,
      attachmentIds: ['att-1'],
    })
    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachment-chip')).not.toBeInTheDocument(),
    )
  })

  it('sends text alongside the attachment', async () => {
    const { onSend } = setup()
    await userEvent.type(screen.getByTestId('composer-input'), 'here you go')
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled())
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'here you go', attachmentIds: ['att-1'] }),
    )
  })

  it('keeps send disabled while an upload is in flight', async () => {
    let release: (id: string) => void = () => {}
    setup({
      onUpload: vi.fn(
        () => new Promise<string>((res) => { release = res }),
      ),
    })
    await userEvent.type(screen.getByTestId('composer-input'), 'text is ready')
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    // Text alone would normally be sendable; a pending upload holds it back so
    // the file isn't dropped from the message.
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeDisabled())
    release('att-9')
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled())
  })

  it('surfaces an upload failure and excludes it from the send', async () => {
    const { onSend } = setup({
      onUpload: vi.fn().mockRejectedValue(new Error('File exceeds 25 bytes')),
    })
    await userEvent.type(screen.getByTestId('composer-input'), 'hi')
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    // The API's English never reaches the operator.
    await waitFor(() =>
      expect(screen.getByText('conversations.attachment_failed')).toBeInTheDocument(),
    )
    expect(screen.queryByText('File exceeds 25 bytes')).toBeNull()
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: [] }),
    )
  })

  it('a failed upload alone cannot be sent', async () => {
    setup({ onUpload: vi.fn().mockRejectedValue(new Error('nope')) })
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() =>
      expect(screen.getByText('conversations.attachment_failed')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('composer-send')).toBeDisabled()
  })

  it('removes a staged attachment', async () => {
    setup()
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() =>
      expect(screen.getByTestId('composer-attachment-chip')).toBeInTheDocument(),
    )
    await userEvent.click(screen.getByLabelText('conversations.attachment_remove'))
    expect(screen.queryByTestId('composer-attachment-chip')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-send')).toBeDisabled()
  })

  it('caps staged attachments at the API limit of 10', async () => {
    setup()
    const many = Array.from({ length: 12 }, (_, i) => file(`f${i}.png`))
    await userEvent.upload(screen.getByTestId('composer-file-input'), many)
    await waitFor(() =>
      expect(screen.getAllByTestId('composer-attachment-chip')).toHaveLength(10),
    )
    expect(screen.getByTestId('composer-attach')).toBeDisabled()
  })

  it('disables the paperclip when no upload handler is wired', () => {
    setup({ onUpload: undefined })
    expect(screen.getByTestId('composer-attach')).toBeDisabled()
  })
})

describe('Composer — AI draft prefill', () => {
  const box = () => screen.getByRole('textbox')

  it('loads the suggestion into the box', () => {
    setup({ prefill: { text: 'Olá, tudo bem?', nonce: 1 } })
    expect(box()).toHaveValue('Olá, tudo bem?')
  })

  it('does not clobber what the agent typed when props re-render', async () => {
    const { rerender } = renderComposer({ prefill: { text: 'Sugestão', nonce: 1 } })
    await userEvent.clear(box())
    await userEvent.type(box(), 'minha própria resposta')
    // Same nonce → the agent's edits survive.
    rerender({ prefill: { text: 'Sugestão', nonce: 1 } })
    expect(box()).toHaveValue('minha própria resposta')
  })

  it('re-loads the same text when chosen again (new nonce)', async () => {
    const { rerender } = renderComposer({ prefill: { text: 'Sugestão', nonce: 1 } })
    await userEvent.clear(box())
    rerender({ prefill: { text: 'Sugestão', nonce: 2 } })
    expect(box()).toHaveValue('Sugestão')
  })

  it('leaves the box alone when there is no suggestion', () => {
    setup({ prefill: null })
    expect(box()).toHaveValue('')
  })
})

describe('Composer — 24h messaging window', () => {
  it('warns when the window has closed', () => {
    setup({ messagingWindow: { open: false, lastInboundAt: null, expiresAt: null } })
    expect(screen.getByText('conversations.window_closed')).toBeInTheDocument()
  })

  it('stays quiet while the window is open', () => {
    setup({
      messagingWindow: {
        open: true,
        lastInboundAt: '2026-08-06T00:00:00.000Z',
        expiresAt: '2026-08-07T00:00:00.000Z',
      },
    })
    expect(screen.queryByText('conversations.window_closed')).toBeNull()
  })

  it('stays quiet on channels that have no window at all', () => {
    // Widget/API inboxes send null — absence of a window is not a closed one.
    setup({ messagingWindow: null })
    expect(screen.queryByText('conversations.window_closed')).toBeNull()
  })
})

describe('Composer — closed conversation', () => {
  const closed = { newConversationHref: '/conversations/new?contactId=c1&inboxId=i1' }
  const TEMPLATE = {
    id: 't1', name: 'aviso', language: 'pt_BR', body: 'Olá', variableCount: 0, status: 'APPROVED',
  }

  it('says it cannot be reopened and points to a new conversation', () => {
    setup({ closed })
    expect(screen.getByTestId('composer-closed')).toHaveTextContent('conversations.closed_notice')
    expect(screen.getByTestId('composer-new-conversation')).toHaveAttribute(
      'href',
      '/conversations/new?contactId=c1&inboxId=i1',
    )
  })

  it('only takes internal notes: reply mode is locked and what is sent is private', async () => {
    const user = userEvent.setup()
    const { onSend } = setup({ closed })
    const reply = screen.getByTestId('composer-mode-reply')
    expect(reply).toBeDisabled()
    await user.click(reply)
    await user.type(screen.getByTestId('composer-input'), 'ligou depois, tudo certo')
    await user.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      content: 'ligou depois, tudo certo',
      isPrivate: true,
    })
  })

  it('offers no template, since a template would reach the contact', () => {
    setup({ closed, templates: [TEMPLATE], onSendTemplate: vi.fn() })
    expect(screen.queryByTestId('composer-template-toggle')).toBeNull()
  })

  it('shows the closed notice instead of the 24h window warning, not both', () => {
    setup({ closed, messagingWindow: { open: false, lastInboundAt: null, expiresAt: null } })
    expect(screen.getByTestId('composer-closed')).toBeInTheDocument()
    expect(screen.queryByText('conversations.window_closed')).toBeNull()
  })

  it('a conversation in progress keeps reply mode and templates', () => {
    setup({ closed: null, templates: [TEMPLATE], onSendTemplate: vi.fn() })
    expect(screen.queryByTestId('composer-closed')).toBeNull()
    expect(screen.getByTestId('composer-mode-reply')).not.toBeDisabled()
    expect(screen.getByTestId('composer-template-toggle')).toBeInTheDocument()
  })
})

// Conversation 8746 (2026-10-28): the box emptied and the message only showed
// up a second or two later. The thread now shows it at once, so the box clears
// at once too, and gets the text back if the send did not go.
describe('Composer — instant send', () => {
  it('clears the box before the send finishes', async () => {
    let finish: (ok: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((r) => { finish = r }))
    setup({ onSend })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await userEvent.type(input, 'oi')
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(input.value).toBe('')
    expect(input).toBeEnabled()
    finish(true)
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('gives the text and files back when the send did not go', async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    setup({ onSend })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await userEvent.type(input, 'oi')
    await userEvent.upload(screen.getByTestId('composer-file-input'), file())
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled())
    await userEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(input.value).toBe('oi'))
    expect(screen.getByTestId('composer-attachment-chip')).toBeInTheDocument()
  })

  it('does not overwrite what was typed meanwhile', async () => {
    let fail: (ok: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((r) => { fail = r }))
    setup({ onSend })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await userEvent.type(input, 'primeira')
    await userEvent.click(screen.getByTestId('composer-send'))
    await userEvent.type(input, 'segunda')
    fail(false)
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(input.value).toBe('segunda')
  })
})

// A suggestion loaded with "Editar antes" is still that suggestion when sent:
// the page marks the reply and takes the suggestion out of the thread.
describe('Composer — reply from an AI suggestion', () => {
  it('says which suggestion the text came from, and whether it was changed', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const { rerender } = renderComposer({ onSend })
    rerender({ prefill: { text: 'Bom dia!', nonce: 1, draftId: 'd1' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe('Bom dia!'))
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'Bom dia!', fromDraft: { id: 'd1', edited: false } }),
    )

    rerender({ prefill: { text: 'Bom dia!', nonce: 2, draftId: 'd2' } })
    await waitFor(() => expect(input.value).toBe('Bom dia!'))
    await userEvent.type(input, ' Tudo bem?')
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromDraft: { id: 'd2', edited: true } }),
    )

    // The next message is the agent's own.
    await userEvent.type(input, 'outra')
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls.at(-1)![0].fromDraft).toBeUndefined()
  })

  it('forgets the suggestion when the box is emptied, and keeps it when the send fails', async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const { rerender } = renderComposer({ onSend })
    rerender({ prefill: { text: 'Oi', nonce: 1, draftId: 'd1' } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe('Oi'))
    await userEvent.click(screen.getByTestId('composer-send'))
    await waitFor(() => expect(input.value).toBe('Oi'))
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls[1]![0].fromDraft).toEqual({ id: 'd1', edited: false })

    rerender({ prefill: { text: 'Oi', nonce: 2, draftId: 'd3' } })
    await waitFor(() => expect(input.value).toBe('Oi'))
    await userEvent.clear(input)
    await userEvent.type(input, 'meu texto')
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls.at(-1)![0].fromDraft).toBeUndefined()
  })

  it('a prefill without a suggestion id, or a note, carries no suggestion', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const { rerender } = renderComposer({ onSend })
    rerender({ prefill: { text: 'Oi', nonce: 1 } })
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    await waitFor(() => expect(input.value).toBe('Oi'))
    await userEvent.click(screen.getByTestId('composer-send'))
    expect(onSend.mock.calls.at(-1)![0].fromDraft).toBeUndefined()
  })
})
