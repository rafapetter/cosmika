import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keys render as-is; params are appended so the agent summary can be read.
const T = (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k)
vi.mock('next-intl', () => ({ useTranslations: () => T, useLocale: () => 'pt-BR' }))

const apiMock = vi.hoisted(() => ({
  listAgentBots: vi.fn(),
  listTeams: vi.fn(),
  listFlows: vi.fn(),
}))
vi.mock('../../../lib/api', () => ({ api: apiMock }))

import { BlockEditor } from './_editors'

const BOT = {
  id: 'bot-fin',
  name: 'Financeiro',
  description: 'Ana, do Financeiro: anuidade e boletos.',
  systemPrompt: 'Você é a Ana.',
  isActive: true,
  knowledgeTags: ['financeiro'],
  knowledgeArticleCount: 4,
}

function defWith(block: Record<string, unknown>) {
  return {
    groups: [{ id: 'g1', blocks: [block] }],
    edges: [],
    variables: [],
    startGroupId: 'g1',
  } as never
}

beforeEach(() => {
  apiMock.listAgentBots.mockResolvedValue([BOT, { ...BOT, id: 'bot-off', name: 'Antigo', isActive: false }])
  apiMock.listTeams.mockResolvedValue([])
  apiMock.listFlows.mockResolvedValue([])
})
afterEach(() => vi.clearAllMocks())

describe('BlockEditor: AI agent', () => {
  const block = { id: 'ag', type: 'AI agent', options: { agentBotId: 'bot-fin', maxAiTurns: 3, offTopic: 'refuse' } }

  it("shows the chosen agent's persona and knowledge base, and the transfer exit", async () => {
    render(<BlockEditor def={defWith(block)} groupId="g1" block={block} onChange={() => undefined} token="t" accountId="acc1" />)
    const summary = await screen.findByTestId('drawer-agent-summary')
    expect(summary).toHaveTextContent('Ana, do Financeiro: anuidade e boletos.')
    expect(summary).toHaveTextContent('flows.agent_base_tags {"tags":"financeiro","count":4}')
    expect(screen.getByText('flows.field_after_ai_agent')).toBeInTheDocument()
    expect(apiMock.listAgentBots).toHaveBeenCalledWith('t', 'acc1')
  })

  it('writes maxAiTurns as a whole, non-negative number', async () => {
    const onChange = vi.fn()
    render(<BlockEditor def={defWith(block)} groupId="g1" block={block} onChange={onChange} token="t" accountId="acc1" />)
    await screen.findByTestId('drawer-agent-summary')
    fireEvent.change(screen.getByTestId('drawer-max-ai-turns'), { target: { value: '5' } })
    const next = onChange.mock.calls.at(-1)![0] as { groups: { blocks: { options: Record<string, unknown> }[] }[] }
    expect(next.groups[0]!.blocks[0]!.options.maxAiTurns).toBe(5)
    fireEvent.change(screen.getByTestId('drawer-max-ai-turns'), { target: { value: '-2' } })
    const clamped = onChange.mock.calls.at(-1)![0] as typeof next
    expect(clamped.groups[0]!.blocks[0]!.options.maxAiTurns).toBe(0)
  })
})

describe('BlockEditor: Condition with a date', () => {
  it('offers "now" and a datetime field for a date operator, with an end for between', () => {
    const block = {
      id: 'c',
      type: 'Condition',
      options: {
        items: [
          {
            id: 'i1',
            comparisons: [
              { id: 'k1', variableId: 'now', comparisonOperator: 'Is between', value: '2026-10-20T08:00', valueTo: '2026-10-20 18:00' },
            ],
          },
        ],
      },
    }
    const onChange = vi.fn()
    render(<BlockEditor def={defWith(block)} groupId="g1" block={block} onChange={onChange} token="t" accountId="acc1" />)
    const from = screen.getByLabelText('flows.date_from') as HTMLInputElement
    const to = screen.getByLabelText('flows.date_to') as HTMLInputElement
    expect(from.type).toBe('datetime-local')
    expect(from.value).toBe('2026-10-20T08:00')
    // A space-separated value still shows in the picker.
    expect(to.value).toBe('2026-10-20T18:00')
    expect(screen.getByText('flows.date_hint')).toBeInTheDocument()
    fireEvent.change(to, { target: { value: '2026-10-21T18:30' } })
    const next = onChange.mock.calls.at(-1)![0] as {
      groups: { blocks: { options: { items: { comparisons: Record<string, unknown>[] }[] } }[] }[]
    }
    expect(next.groups[0]!.blocks[0]!.options.items[0]!.comparisons[0]).toMatchObject({ valueTo: '2026-10-21T18:30' })
  })

  it('a time-of-day rule uses a time field', () => {
    const block = {
      id: 'c',
      type: 'Condition',
      options: { items: [{ id: 'i1', comparisons: [{ id: 'k1', variableId: 'now', comparisonOperator: 'Is after', value: '18:00' }] }] },
    }
    render(<BlockEditor def={defWith(block)} groupId="g1" block={block} onChange={() => undefined} token="t" accountId="acc1" />)
    const from = screen.getByLabelText('flows.date_from') as HTMLInputElement
    expect(from.type).toBe('time')
    expect(from.value).toBe('18:00')
    expect(screen.queryByLabelText('flows.date_to')).toBeNull()
  })
})
