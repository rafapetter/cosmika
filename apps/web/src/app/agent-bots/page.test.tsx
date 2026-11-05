import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const T = (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k)
vi.mock('next-intl', () => ({ useTranslations: () => T }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const apiMock = vi.hoisted(() => ({ listAgentBots: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../../lib/session-store', () => ({
  useStoredSession: () => ({ ready: true, session: { session: { token: 't' }, account: { id: 'acc1' } } }),
}))

import AgentBotsListPage from './page'

const bot = (over: Record<string, unknown>) => ({
  id: 'b1',
  name: 'Financeiro',
  description: null,
  systemPrompt: 'Você é a Ana, do Financeiro.',
  model: 'claude-haiku-4-5',
  isActive: true,
  inboxCount: 1,
  costLast24hUsd: 0,
  dailyBudgetUsd: 10,
  knowledgeTags: ['financeiro', 'anuidade'],
  knowledgeArticleCount: 4,
  ...over,
})

describe('AgentBotsListPage', () => {
  it("shows each agent's persona and its own knowledge base", async () => {
    apiMock.listAgentBots.mockResolvedValue([
      bot({}),
      bot({ id: 'b2', name: 'Cadastro', description: 'Bruno, do Cadastro.', knowledgeTags: [], knowledgeArticleCount: 9 }),
    ])
    render(<AgentBotsListPage />)
    const fin = await screen.findByTestId('bot-b1-profile')
    expect(fin).toHaveTextContent('Você é a Ana, do Financeiro.')
    expect(fin).toHaveTextContent('agentBots.knowledge_base_tags {"tags":"financeiro, anuidade","count":4}')
    const cad = screen.getByTestId('bot-b2-profile')
    expect(cad).toHaveTextContent('Bruno, do Cadastro.')
    expect(cad).toHaveTextContent('agentBots.knowledge_base_all {"count":9}')
  })
})
