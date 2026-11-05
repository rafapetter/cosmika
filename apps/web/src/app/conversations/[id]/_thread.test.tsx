// Thread rendering for AI suggestions: the agent must be able to see a draft
// and load it into the composer without copy-pasting.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'pt',
}))
vi.mock('../../../lib/session-store', () => ({
  useStoredSession: () => ({ session: null }),
}))
vi.mock('../../../lib/api', () => ({
  api: vi.fn(),
  API_BASE: 'http://localhost:3110',
}))

import { Thread } from './_thread'

const msg = (over: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    conversationId: 'cv1',
    senderType: 'AGENT_BOT',
    senderName: null,
    isPrivate: true,
    status: 'PENDING',
    contentType: 'TEXT',
    content: '[draft] Bom dia! Vou verificar isso.',
    attachments: [],
    createdAt: '2026-08-06T00:00:00.000Z',
    ...over,
  }) as never

describe('Thread — AI suggestions', () => {
  it('shows the suggestion without its storage marker, under an AI label', () => {
    render(
      <Thread messages={[msg()]} meName="Ana" onReply={() => {}} conversationId="cv1" />,
    )
    expect(screen.getByText('Bom dia! Vou verificar isso.')).toBeInTheDocument()
    expect(screen.getByText('conversations.ai_draft_label')).toBeInTheDocument()
    // Not mislabelled as an ordinary internal note.
    expect(
      screen.queryByText('conversations.thread_internal_note_label'),
    ).not.toBeInTheDocument()
  })

  // Conversation 8746 (2026-10-28): the agent wanted the suggestion to go
  // out with one click, not land in the composer for a second one.
  it('sends the suggestion as it is when the agent uses it', async () => {
    const onUseDraft = vi.fn()
    render(
      <Thread
        messages={[msg()]}
        meName="Ana"
        onReply={() => {}}
        onUseDraft={onUseDraft}
        conversationId="cv1"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /ai_draft_use/ }))
    expect(onUseDraft).toHaveBeenCalledWith('m1', 'Bom dia! Vou verificar isso.')
  })

  it('still lets the agent change it first, in the composer', async () => {
    const onEditDraft = vi.fn()
    render(
      <Thread
        messages={[msg()]}
        meName="Ana"
        onReply={() => {}}
        onEditDraft={onEditDraft}
        conversationId="cv1"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /ai_draft_edit/ }))
    expect(onEditDraft).toHaveBeenCalledWith('m1', 'Bom dia! Vou verificar isso.')
  })

  // Once sent, the suggestion leaves the thread; the reply keeps only a small
  // mark that says where it came from on hover.
  it('marks a reply sent from a suggestion, and one edited first, and nothing else', () => {
    const reply = (id: string, aiDraft?: string, senderType = 'USER') =>
      msg({
        id, senderType, isPrivate: false, status: 'SENT', content: 'Oi',
        contentAttributes: aiDraft ? { aiDraft } : {},
      })
    render(
      <Thread
        messages={[reply('a', 'sent'), reply('b', 'edited'), reply('c'), reply('d', 'sent', 'CONTACT'), reply('e', 'other')]}
        meName="Ana"
        onReply={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.getByTitle('conversations.ai_draft_sent_hint')).toBeInTheDocument()
    expect(screen.getByTitle('conversations.ai_draft_edited_hint')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: /ai_draft_(sent|edited)_hint/ })).toHaveLength(2)
  })

  it('discards a suggestion the agent rejects', async () => {
    const onDiscardDraft = vi.fn()
    render(
      <Thread
        messages={[msg()]}
        meName="Ana"
        onReply={() => {}}
        onUseDraft={() => {}}
        onDiscardDraft={onDiscardDraft}
        conversationId="cv1"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /ai_draft_discard/ }))
    expect(onDiscardDraft).toHaveBeenCalledWith('m1')
  })

  it('offers no action for a flow internal note', () => {
    render(
      <Thread
        messages={[msg({ status: 'SENT', content: 'VIP' })]}
        meName="Ana"
        onReply={() => {}}
        onUseDraft={() => {}}
        conversationId="cv1"
      />,
    )
    expect(
      screen.getByText('conversations.thread_internal_note_label'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ai_draft_use/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /ai_draft_discard/ })).toBeNull()
  })
})

describe('Thread — failed delivery', () => {
  const outbound = (over: Record<string, unknown> = {}) =>
    ({
      id: 'm9', conversationId: 'cv1', senderType: 'USER', senderName: 'Ana',
      isPrivate: false, status: 'FAILED', contentType: 'TEXT',
      content: 'não chegou', attachments: [],
      createdAt: '2026-08-06T00:00:00.000Z', ...over,
    }) as never

  it('offers a retry on a message that never reached the contact', async () => {
    const onRetry = vi.fn()
    render(
      <Thread
        messages={[outbound()]}
        meName="Ana"
        onReply={() => {}}
        onRetry={onRetry}
        conversationId="cv1"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /retry_send/ }))
    expect(onRetry).toHaveBeenCalledWith('m9')
  })

  it('offers no retry once the message is delivered', () => {
    render(
      <Thread
        messages={[outbound({ status: 'DELIVERED' })]}
        meName="Ana"
        onReply={() => {}}
        onRetry={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.queryByRole('button', { name: /retry_send/ })).toBeNull()
  })

  it('offers no retry on an inbound message', () => {
    render(
      <Thread
        messages={[outbound({ senderType: 'CONTACT' })]}
        meName="Ana"
        onReply={() => {}}
        onRetry={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.queryByRole('button', { name: /retry_send/ })).toBeNull()
  })
})

// ─── Interactive messages: the operator sees what was offered and picked ──

describe('Thread — interactive options', () => {
  const listPrompt = msg({
    id: 'q1',
    isPrivate: false,
    status: 'SENT',
    contentType: 'QUICK_REPLIES',
    content: 'Qual a prioridade?',
    contentAttributes: {
      kind: 'list',
      body: 'Qual a prioridade?',
      buttonText: 'Ver opções',
      wamids: ['wamid.x'],
      sections: [
        {
          title: 'Prioridade',
          rows: [
            { id: 'pri_low', title: '🟢 Baixa', description: 'Sem urgência' },
            { id: 'pri_high', title: '🔴 Alta' },
          ],
        },
      ],
    },
  })
  const tap = msg({
    id: 'r1',
    senderType: 'CONTACT',
    isPrivate: false,
    status: 'DELIVERED',
    content: '🟢 Baixa',
    contentAttributes: { interactiveReplyId: 'pri_low' },
    createdAt: '2026-08-06T00:01:00.000Z',
  })

  it('shows the options a list offered, and marks the one the contact tapped', () => {
    render(
      <Thread messages={[listPrompt, tap]} meName="Ana" onReply={() => {}} conversationId="cv1" />,
    )
    const offer = screen.getByTestId('interactive-options')
    expect(offer).toHaveTextContent('Ver opções')
    expect(offer).toHaveTextContent('Prioridade')
    expect(offer).toHaveTextContent('Sem urgência')
    expect(offer).toHaveTextContent('🔴 Alta')
    const picked = offer.querySelector('[aria-current="true"]')
    expect(picked).toHaveTextContent('🟢 Baixa')
    // The contact's answer is labelled as a tap, not mistaken for typing.
    expect(screen.getByText('conversations.interactive_reply_label')).toBeInTheDocument()
  })

  it('shows reply buttons with nothing picked while the contact has not answered', () => {
    const buttons = msg({
      id: 'q2',
      isPrivate: false,
      status: 'SENT',
      contentType: 'QUICK_REPLIES',
      content: 'Resolveu?',
      contentAttributes: {
        kind: 'buttons',
        body: 'Resolveu?',
        buttons: [
          { id: 'yes', label: 'Sim' },
          { id: 'no', label: 'Não' },
        ],
      },
    })
    render(<Thread messages={[buttons]} meName="Ana" onReply={() => {}} conversationId="cv1" />)
    const offer = screen.getByTestId('interactive-options')
    expect(offer).toHaveTextContent('conversations.interactive_options_label')
    expect(offer).toHaveTextContent('Sim')
    expect(offer.querySelector('[aria-current="true"]')).toBeNull()
  })
})

import { chosenReplies, interactiveOptions, isInteractiveReply } from './_thread'

describe('interactive helpers', () => {
  const base = { senderType: 'AGENT_BOT', contentType: 'QUICK_REPLIES' }
  const as = (o: Record<string, unknown>) => o as never

  it('ignores anything that is not a well-formed offer', () => {
    expect(interactiveOptions(as({ ...base, contentType: 'TEXT', contentAttributes: {} }))).toBeNull()
    expect(interactiveOptions(as({ ...base, contentAttributes: { kind: 'buttons', buttons: [{ id: 1 }] } }))).toBeNull()
    expect(interactiveOptions(as({ ...base, contentAttributes: { kind: 'list', sections: [{ rows: [{ title: 'x' }] }] } }))).toBeNull()
    expect(interactiveOptions(as({ ...base, contentAttributes: { kind: 'list', sections: [{}] } }))).toBeNull()
    expect(interactiveOptions(as({ ...base, contentAttributes: { kind: 'carousel' } }))).toBeNull()
  })

  it('keeps list rows without title or description, and a list with no button text', () => {
    const offer = interactiveOptions(
      as({ ...base, contentAttributes: { kind: 'list', sections: [{ title: '', rows: [{ id: 'a', title: 'A', description: '' }] }] } }),
    )
    expect(offer).toEqual({
      kind: 'list',
      buttonText: undefined,
      groups: [{ title: undefined, options: [{ id: 'a', label: 'A', description: undefined }] }],
    })
  })

  it('only counts contact messages with a reply id as taps', () => {
    expect(isInteractiveReply(as({ senderType: 'CONTACT', contentAttributes: { interactiveReplyId: 'x' } }))).toBe(true)
    expect(isInteractiveReply(as({ senderType: 'CONTACT', contentAttributes: { interactiveReplyId: '' } }))).toBe(false)
    expect(isInteractiveReply(as({ senderType: 'CONTACT', contentAttributes: {} }))).toBe(false)
    expect(isInteractiveReply(as({ senderType: 'AGENT_BOT', contentAttributes: { interactiveReplyId: 'x' } }))).toBe(false)
  })

  it('pairs a question with the next contact message only, and only on a matching id', () => {
    const q = as({ id: 'q', ...base, contentAttributes: { kind: 'buttons', buttons: [{ id: 'y', label: 'Sim' }] } })
    const bot = as({ id: 'b', senderType: 'AGENT_BOT', contentType: 'TEXT', contentAttributes: {} })
    const typed = as({ id: 't', senderType: 'CONTACT', contentType: 'TEXT', contentAttributes: {} })
    const tapY = as({ id: 'c', senderType: 'CONTACT', contentType: 'TEXT', contentAttributes: { interactiveReplyId: 'y' } })
    // A bot message in between is skipped; the contact's answer is found.
    expect(chosenReplies([q, bot, tapY]).get('q')).toBe('y')
    // The contact typed instead of tapping: nothing is marked, and a later
    // tap does not get credited to the old question.
    expect(chosenReplies([q, typed, tapY]).has('q')).toBe(false)
    // Unanswered.
    expect(chosenReplies([q]).size).toBe(0)
  })
})

describe('Thread — reactions', () => {
  const inbound = (over: Record<string, unknown> = {}) =>
    msg({
      senderType: 'CONTACT',
      isPrivate: false,
      status: 'SENT',
      content: 'Obrigada',
      externalSourceId: 'wamid.in1',
      contentAttributes: {},
      ...over,
    })

  it('shows the contact reaction on the message it is for', () => {
    render(
      <Thread
        messages={[inbound({ contentAttributes: { reactions: { contact: { emoji: '👍' } } } })]}
        meName="Ana"
        onReply={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.getByTitle('conversations.reaction_contact')).toHaveTextContent('👍')
  })

  it('shows an old "[reaction]" row as what it was, not as text', () => {
    render(
      <Thread
        messages={[inbound({ content: '[reaction]', contentAttributes: { rawType: 'reaction' } })]}
        meName="Ana"
        onReply={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.getByText('conversations.reaction_legacy')).toBeInTheDocument()
    expect(screen.queryByText('[reaction]')).not.toBeInTheDocument()
  })

  it('reacts from the picker, and picking the same emoji again takes it off', async () => {
    const onReact = vi.fn()
    const { rerender } = render(
      <Thread messages={[inbound()]} meName="Ana" onReply={() => {}} onReact={onReact} conversationId="cv1" />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'conversations.react_button' }))
    await userEvent.click(screen.getByRole('menuitem', { name: '❤️' }))
    expect(onReact).toHaveBeenCalledWith('m1', '❤️')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    rerender(
      <Thread
        messages={[inbound({ contentAttributes: { reactions: { business: { emoji: '❤️' } } } })]}
        meName="Ana"
        onReply={() => {}}
        onReact={onReact}
        conversationId="cv1"
      />,
    )
    expect(screen.getByTitle('conversations.reaction_business')).toHaveTextContent('❤️')
    await userEvent.click(screen.getByRole('button', { name: 'conversations.react_button' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'conversations.reaction_remove' }))
    expect(onReact).toHaveBeenLastCalledWith('m1', '')
  })

  it('offers no reaction on a note, on a message that never went through WhatsApp, or where reacting is off', () => {
    const { rerender } = render(
      <Thread
        messages={[inbound({ externalSourceId: null })]}
        meName="Ana"
        onReply={() => {}}
        onReact={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.queryByRole('button', { name: 'conversations.react_button' })).not.toBeInTheDocument()
    rerender(
      <Thread messages={[inbound()]} meName="Ana" onReply={() => {}} conversationId="cv1" />,
    )
    expect(screen.queryByRole('button', { name: 'conversations.react_button' })).not.toBeInTheDocument()
  })

  it('lets the agent react to our own sent message too, and shows a clock while one is sending', () => {
    render(
      <Thread
        messages={[
          inbound({ id: 'm2', senderType: 'USER', content: 'Oi', externalSourceId: 'wamid.out1' }),
          inbound({ id: 'pending-1', senderType: 'USER', content: 'Já vai', status: 'PENDING', externalSourceId: null }),
        ]}
        meName="Ana"
        onReply={() => {}}
        onReact={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.getAllByRole('button', { name: 'conversations.react_button' })).toHaveLength(1)
    expect(screen.getByLabelText('conversations.sending')).toBeInTheDocument()
  })
})

describe('Thread — stale suggestions', () => {
  it('hides a suggestion the conversation already moved past, and keeps the current one', () => {
    render(
      <Thread
        messages={[
          msg({ id: 'd1', content: '[draft] Obrigado pelo retorno!' }),
          msg({ id: 'c1', senderType: 'CONTACT', isPrivate: false, status: 'SENT', content: 'Obrigada' }),
          msg({ id: 'd2', content: '[draft] Por nada!' }),
        ]}
        meName="Ana"
        onReply={() => {}}
        conversationId="cv1"
      />,
    )
    expect(screen.queryByText('Obrigado pelo retorno!')).not.toBeInTheDocument()
    expect(screen.getByText('Por nada!')).toBeInTheDocument()
  })
})
