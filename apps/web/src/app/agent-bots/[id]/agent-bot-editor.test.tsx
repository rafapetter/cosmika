// The editor must round-trip every field it shows. It previously offered a
// model list that excluded the model the live bot actually runs, so opening
// the bot and saving would silently downgrade it.
import { describe, expect, it } from 'vitest'
import { AgentBotModel, BUILT_IN_AGENT_TOOLS, UpdateAgentBotInput } from '@cosmika/shared'

describe('agent bot model options', () => {
  it('accepts the models the API prices and the client can call', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(AgentBotModel.safeParse(m).success).toBe(true)
    }
  })

  it('still accepts the older models existing bots may be on', () => {
    for (const m of ['claude-opus-4-7', 'claude-sonnet-4-6']) {
      expect(AgentBotModel.safeParse(m).success).toBe(true)
    }
  })
})

describe('agent bot tool list', () => {
  it('every offered tool is accepted by the update schema', () => {
    const parsed = UpdateAgentBotInput.safeParse({
      toolsEnabled: BUILT_IN_AGENT_TOOLS.map((name) => ({ name })),
    })
    expect(parsed.success).toBe(true)
  })

  it('includes the knowledge-base pair the support agent depends on', () => {
    expect(BUILT_IN_AGENT_TOOLS).toContain('search_knowledge_base')
    expect(BUILT_IN_AGENT_TOOLS).toContain('read_knowledge_base_article')
  })
})

describe('confidence threshold', () => {
  it('accepts the full 0-100 range and rejects outside it', () => {
    expect(UpdateAgentBotInput.safeParse({ autoSafeConfidenceThreshold: 70 }).success).toBe(true)
    expect(UpdateAgentBotInput.safeParse({ autoSafeConfidenceThreshold: 0 }).success).toBe(true)
    expect(UpdateAgentBotInput.safeParse({ autoSafeConfidenceThreshold: 101 }).success).toBe(false)
  })
})
