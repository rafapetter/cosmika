import { describe, expect, it, vi } from 'vitest'

import type { TurnMessage } from './anthropic-client'
import {
  OPENROUTER_PRIVACY,
  createOpenAiMessage,
  fromOpenAiResponse,
  isOpenAiModel,
  isOpenRouterModel,
  toOpenAiMessages,
  toOpenAiTools,
} from './openai-chat'

describe('isOpenAiModel', () => {
  it('is true for GPT models and false for Claude', () => {
    expect(isOpenAiModel('gpt-5.6-luna')).toBe(true)
    expect(isOpenAiModel('gpt-5.4-mini')).toBe(true)
    expect(isOpenAiModel('claude-sonnet-5')).toBe(false)
    expect(isOpenAiModel('my-gpt-proxy')).toBe(false)
  })
})

describe('isOpenRouterModel', () => {
  it('matches vendor/model ids only', () => {
    expect(isOpenRouterModel('deepseek/deepseek-v4.1-flash')).toBe(true)
    expect(isOpenRouterModel('google/gemini-3.8-flash')).toBe(true)
    expect(isOpenRouterModel('openai/gpt-5.6-luna:batch')).toBe(true)
    expect(isOpenRouterModel('gpt-5.6-luna')).toBe(false)
    expect(isOpenRouterModel('claude-sonnet-5')).toBe(false)
    expect(isOpenRouterModel('a/b/c')).toBe(false)
    expect(isOpenRouterModel('../etc')).toBe(false)
  })
})

describe('toOpenAiMessages', () => {
  it('puts the system prompt first and flattens a text-only user turn to a string', () => {
    const out = toOpenAiMessages('be nice', [
      { role: 'user', content: [{ type: 'text', text: 'oi' }, { type: 'text', text: 'tudo bem?' }] },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'oi\ntudo bem?' },
    ])
  })

  it('turns tool_use into tool_calls and each tool_result into its own tool message', () => {
    const history: TurnMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'preciso de ajuda' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Vou verificar.' },
          { type: 'tool_use', id: 'call_1', name: 'search_knowledge_base', input: { query: 'janela' } },
          { type: 'tool_use', id: 'call_2', name: 'attach_tag', input: undefined as unknown as Record<string, unknown> },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
          { type: 'text', text: 'e agora?' },
        ],
      },
    ]
    const out = toOpenAiMessages('sys', history)
    expect(out.slice(2)).toEqual([
      {
        role: 'assistant',
        content: 'Vou verificar.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search_knowledge_base', arguments: '{"query":"janela"}' } },
          { id: 'call_2', type: 'function', function: { name: 'attach_tag', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_2', content: 'a\nb' },
      { role: 'user', content: 'e agora?' },
    ])
  })

  it('sends null content on a call-only assistant turn and "" on an empty one', () => {
    const out = toOpenAiMessages('sys', [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }] },
      { role: 'assistant', content: [] },
    ])
    expect(out[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }],
    })
    // The tool-result-only user turn adds no user message.
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'ok' })
    expect(out[3]).toEqual({ role: 'assistant', content: '' })
    expect(out).toHaveLength(4)
  })

  it('carries images and PDFs as data URLs next to the text', () => {
    const out = toOpenAiMessages('sys', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'olha isso' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' } },
        ],
      },
    ])
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'olha isso' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'file', file: { filename: 'document.pdf', file_data: 'data:application/pdf;base64,BBB' } },
      ],
    })
  })

  it('ignores block types it does not know', () => {
    const out = toOpenAiMessages('sys', [
      { role: 'user', content: [{ type: 'mystery' } as unknown as TurnMessage['content'][number]] },
    ])
    expect(out).toHaveLength(1)
  })
})

describe('toOpenAiTools', () => {
  it('wraps each tool as a function with its schema as parameters', () => {
    const schema = { type: 'object', properties: {} }
    expect(toOpenAiTools([{ name: 'n', description: 'd', input_schema: schema }])).toEqual([
      { type: 'function', function: { name: 'n', description: 'd', parameters: schema } },
    ])
  })
})

describe('fromOpenAiResponse', () => {
  it('maps text, tool calls and usage, keeping cached tokens apart from input', () => {
    const res = fromOpenAiResponse({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '  Um momento.  ',
            tool_calls: [
              { id: 'call_9', type: 'function', function: { name: 'attach_tag', arguments: '{"tag":"x"}' } },
              { id: 'call_10', type: 'function', function: { name: 'attach_tag', arguments: 'not json' } },
              { id: 'call_11', type: 'function', function: { name: 'attach_tag', arguments: '[1]' } },
              { id: 'call_12', type: 'function', function: { name: 'attach_tag', arguments: 'null' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    })
    expect(res.content).toEqual([
      { type: 'text', text: 'Um momento.' },
      { type: 'tool_use', id: 'call_9', name: 'attach_tag', input: { tag: 'x' } },
      { type: 'tool_use', id: 'call_10', name: 'attach_tag', input: {} },
      { type: 'tool_use', id: 'call_11', name: 'attach_tag', input: {} },
      { type: 'tool_use', id: 'call_12', name: 'attach_tag', input: {} },
    ])
    expect(res.stop_reason).toBe('tool_use')
    expect(res.usage).toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 })
  })

  it('trusts returned calls over a "stop" finish reason', () => {
    const res = fromOpenAiResponse({
      choices: [{ finish_reason: 'stop', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] } }],
    })
    expect(res.stop_reason).toBe('tool_use')
  })

  it('maps length and content_filter, and defaults the rest to end_turn', () => {
    expect(fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop_reason).toBe('max_tokens')
    expect(fromOpenAiResponse({ choices: [{ finish_reason: 'content_filter', message: { content: null } }] }).stop_reason).toBe('refusal')
    expect(fromOpenAiResponse({ choices: [{ finish_reason: null, message: { content: 'x', tool_calls: null } }] }).stop_reason).toBe('end_turn')
  })

  it('survives an empty body', () => {
    expect(fromOpenAiResponse({})).toEqual({
      content: [],
      stop_reason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(fromOpenAiResponse({ choices: [{}], usage: { prompt_tokens: 7 } }).usage.inputTokens).toBe(7)
  })
})

describe('createOpenAiMessage', () => {
  const okBody = { choices: [{ finish_reason: 'stop', message: { content: 'Olá!' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
  const history: TurnMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }]

  it('posts to chat/completions with reasoning off for luna and tools as functions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    const res = await createOpenAiMessage(
      { apiKey: 'sk-test', baseUrl: 'https://gw.example/v1/', fetch: fetchMock as unknown as typeof fetch },
      {
        model: 'gpt-5.6-luna',
        systemPrompt: 'sys',
        tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
        messages: history,
        maxTokens: 512,
      },
    )
    expect(res.content).toEqual([{ type: 'text', text: 'Olá!' }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://gw.example/v1/chat/completions')
    expect(init.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'gpt-5.6-luna', max_completion_tokens: 512, reasoning_effort: 'none' })
    expect(body.tools).toHaveLength(1)
    expect(body).not.toHaveProperty('temperature')
  })

  it('omits tools and effort when there are none, and defaults max tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => okBody })
    await createOpenAiMessage(
      { apiKey: 'k', baseUrl: 'https://api.openai.com/v1', fetch: fetchMock as unknown as typeof fetch },
      { model: 'gpt-5-mini', systemPrompt: 's', tools: [], messages: history },
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.max_completion_tokens).toBe(4096)
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('merges provider fields into the body and names OpenRouter in errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'no ZDR endpoint' })
    const conn = {
      apiKey: 'sk-or',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraBody: { provider: OPENROUTER_PRIVACY },
      fetch: fetchMock as unknown as typeof fetch,
    }
    const opts = { model: 'deepseek/deepseek-v4.1-flash', systemPrompt: 's', tools: [], messages: history }
    await createOpenAiMessage(conn, opts)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.provider).toEqual({ data_collection: 'deny', zdr: true })
    expect(body.model).toBe('deepseek/deepseek-v4.1-flash')
    await expect(createOpenAiMessage(conn, opts)).rejects.toThrow('OpenRouter 404: no ZDR endpoint')
  })

  it('throws with the status and a trimmed body on an HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'x'.repeat(500) })
    await expect(
      createOpenAiMessage(
        { apiKey: 'k', baseUrl: 'https://api.openai.com/v1', fetch: fetchMock as unknown as typeof fetch },
        { model: 'gpt-5.6-luna', systemPrompt: 's', tools: [], messages: history },
      ),
    ).rejects.toThrow(`OpenAI 400: ${'x'.repeat(300)}`)
  })

  it('uses the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => okBody } as Response)
    await createOpenAiMessage(
      { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
      { model: 'gpt-5.6-luna', systemPrompt: 's', tools: [], messages: history },
    )
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
