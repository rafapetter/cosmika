import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }))

import { RuleForm } from './_form'

const rule = (kind: string) =>
  ({
    id: 'r1',
    name: 'Resposta automática',
    description: null,
    triggerEvent: 'MESSAGE_CREATED',
    isActive: true,
    runOncePerConversation: true,
    conditions: [],
    actions: [{ kind, value: 'Recebemos sua mensagem.' }],
  }) as never

describe('RuleForm: SEND_REPLY', () => {
  it('warns that the reply really reaches the contact', () => {
    render(<RuleForm initial={rule('SEND_REPLY')} onSubmit={() => undefined} />)
    expect(screen.getByTestId('action-0-send-reply-hint')).toHaveTextContent('automation.send_reply_hint')
  })

  it('says nothing for actions that stay inside the desk', () => {
    render(<RuleForm initial={rule('ADD_TAG')} onSubmit={() => undefined} />)
    expect(screen.queryByTestId('action-0-send-reply-hint')).toBeNull()
  })
})
