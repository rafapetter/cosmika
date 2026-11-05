// Unit tests for AnthropicClient — both the stub mode (deterministic) and the
// real-SDK passthrough path (Anthropic SDK mocked so no network).
import type { ConfigService } from '@nestjs/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AnthropicClient,
  modelRejectsTemperature,
  withHistoryBreakpoint,
} from './anthropic-client'

// Mock the Anthropic SDK so `new Anthropic(...)` returns an object whose
// `.messages.create` is a vi.fn we can program per-test. vi.hoisted lets us
// define the spies BEFORE the hoisted vi.mock factory runs.
const { sdkCreate, SdkCtor } = vi.hoisted(() => {
  const sdkCreate = vi.fn()
  const SdkCtor = vi.fn().mockImplementation(() => ({
    messages: { create: sdkCreate },
  }))
  return { sdkCreate, SdkCtor }
})
vi.mock('@anthropic-ai/sdk', () => ({
  default: SdkCtor,
}))

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: vi.fn((k: string) => overrides[k]),
  } as unknown as ConfigService
}

beforeEach(() => {
  sdkCreate.mockReset()
  SdkCtor.mockClear()
})

// ─── constructor ─────────────────────────────────────────────────

describe('AnthropicClient constructor', () => {
  it('enters stub mode when COSMIKA_AI_STUB=1', () => {
    const c = new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' }))
    expect(c.isStub).toBe(true)
    expect(c.isAvailable()).toBe(true)
    expect(SdkCtor).not.toHaveBeenCalled()
  })

  it('warns + no real client when ANTHROPIC_API_KEY missing and STUB unset', () => {
    const c = new AnthropicClient(makeConfig())
    expect(c.isStub).toBe(false)
    expect(c.isAvailable()).toBe(false)
    expect(SdkCtor).not.toHaveBeenCalled()
  })

  it('constructs the SDK with the API key when provided', () => {
    new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
    expect(SdkCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-test' })
  })

  it('passes ANTHROPIC_BASE_URL to the SDK when set', () => {
    new AnthropicClient(
      makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: ' https://gw.example/anthropic ' }),
    )
    expect(SdkCtor).toHaveBeenCalledWith({
      apiKey: 'sk-ant-test',
      baseURL: 'https://gw.example/anthropic',
    })
  })

  it('omits baseURL when ANTHROPIC_BASE_URL is empty (compose passes it as "")', () => {
    new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: '' }))
    expect(SdkCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-test' })
  })

  it('isAvailable=true when real client is configured', () => {
    const c = new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
    expect(c.isStub).toBe(false)
    expect(c.isAvailable()).toBe(true)
  })
})

// ─── createMessage real-SDK path ─────────────────────────────────

describe('AnthropicClient: GPT models go to OpenAI', () => {
  const history = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'oi' }] }]

  it('reports availability per model from the key each provider needs', () => {
    const onlyOpenAi = new AnthropicClient(makeConfig({ OPENAI_API_KEY: 'sk-oa' }))
    expect(onlyOpenAi.isAvailable('gpt-5.6-luna')).toBe(true)
    expect(onlyOpenAi.isAvailable('claude-sonnet-5')).toBe(false)
    expect(onlyOpenAi.isAvailable()).toBe(false)
    const onlyAnthropic = new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
    expect(onlyAnthropic.isAvailable('gpt-5.6-luna')).toBe(false)
    expect(onlyAnthropic.isAvailable('claude-sonnet-5')).toBe(true)
    expect(new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' })).isAvailable('gpt-5.6-luna')).toBe(true)
  })

  it('throws a clear error when a GPT model runs without OPENAI_API_KEY', async () => {
    const c = new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
    await expect(
      c.createMessage({ model: 'gpt-5.6-luna', systemPrompt: 's', tools: [], messages: history }),
    ).rejects.toThrow(/OpenAI client not configured for gpt-5.6-luna/)
    expect(sdkCreate).not.toHaveBeenCalled()
  })

  it('calls OpenAI (gateway base URL honored), never the Anthropic SDK, and drops temperature', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Olá' } }] }),
    } as Response)
    const c = new AnthropicClient(
      makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: ' sk-oa ', OPENAI_BASE_URL: ' https://gw.example/v1 ' }),
    )
    const res = await c.createMessage({ model: 'gpt-5.6-luna', systemPrompt: 's', tools: [], messages: history, temperature: 0.3 })
    expect(res.content).toEqual([{ type: 'text', text: 'Olá' }])
    expect(sdkCreate).not.toHaveBeenCalled()
    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe('https://gw.example/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-oa' })
    expect(JSON.parse((init as RequestInit).body as string)).not.toHaveProperty('temperature')
    spy.mockRestore()
  })

  it('sends vendor/model ids to OpenRouter, zero-retention only', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Oi' } }] }),
    } as Response)
    const c = new AnthropicClient(makeConfig({ OPENAI_API_KEY: 'sk-oa', OPENROUTER_API_KEY: ' sk-or ' }))
    expect(c.isAvailable('deepseek/deepseek-v4.1-flash')).toBe(true)
    await c.createMessage({ model: 'deepseek/deepseek-v4.1-flash', systemPrompt: 's', tools: [], messages: history })
    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-or' })
    expect(JSON.parse((init as RequestInit).body as string).provider).toEqual({ data_collection: 'deny', zdr: true })
    spy.mockRestore()
  })

  it('honors OPENROUTER_BASE_URL and refuses vendor/model ids without a key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response)
    const withGw = new AnthropicClient(
      makeConfig({ OPENROUTER_API_KEY: 'sk-or', OPENROUTER_BASE_URL: ' https://gw.example/or ' }),
    )
    await withGw.createMessage({ model: 'z-ai/glm-5.2', systemPrompt: 's', tools: [], messages: history })
    expect(spy.mock.calls[0]![0]).toBe('https://gw.example/or/chat/completions')
    spy.mockRestore()
    const without = new AnthropicClient(makeConfig({ OPENAI_API_KEY: 'sk-oa' }))
    expect(without.isAvailable('deepseek/deepseek-v4.1-flash')).toBe(false)
    await expect(
      without.createMessage({ model: 'deepseek/deepseek-v4.1-flash', systemPrompt: 's', tools: [], messages: history }),
    ).rejects.toThrow(/OpenRouter client not configured for deepseek\/deepseek-v4.1-flash/)
  })

  it('defaults to api.openai.com when OPENAI_BASE_URL is empty', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response)
    const c = new AnthropicClient(makeConfig({ OPENAI_API_KEY: 'sk-oa', OPENAI_BASE_URL: '' }))
    await c.createMessage({ model: 'gpt-5.6-luna', systemPrompt: 's', tools: [], messages: history })
    expect(spy.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions')
    spy.mockRestore()
  })
})

describe('AnthropicClient.createMessage — real-SDK passthrough', () => {
  function realClient() {
    return new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
  }

  it('throws when no key + no stub', async () => {
    const c = new AnthropicClient(makeConfig())
    await expect(
      c.createMessage({
        model: 'claude-opus-4-7',
        systemPrompt: 'sys',
        tools: [],
        messages: [],
      }),
    ).rejects.toThrow(/Anthropic client not configured/)
  })

  it('forwards model + system + messages and unwraps usage', async () => {
    sdkCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Hi there' },
        { type: 'tool_use', id: 't1', name: 'attach_tag', input: { tag: 'x' } },
        { type: 'thinking', text: 'ignored' }, // filtered out
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
      },
    })
    const r = await realClient().createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'You are a helpful agent.',
      tools: [
        {
          name: 'attach_tag',
          description: 'Tag the conversation',
          input_schema: { type: 'object', properties: { tag: { type: 'string' } } },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(r.content).toEqual([
      { type: 'text', text: 'Hi there' },
      { type: 'tool_use', id: 't1', name: 'attach_tag', input: { tag: 'x' } },
    ])
    expect(r.stop_reason).toBe('tool_use')
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
    })
    // Verify params shape
    const params = sdkCreate.mock.calls[0]![0]
    expect(params.model).toBe('claude-opus-4-7')
    expect(params.max_tokens).toBe(4096)
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // The conversation is cached too, so the next tool round reads it cheaply.
    expect(params.messages.at(-1).content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    expect(params.tools).toHaveLength(1)
    // Opus 4.7 → no temperature passed even if supplied
    expect(params.temperature).toBeUndefined()
  })

  it('passes temperature on non-Opus-4.7 models when supplied', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await realClient().createMessage({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.42,
    })
    const params = sdkCreate.mock.calls[0]![0]
    expect(params.temperature).toBe(0.42)
    // No tools supplied → params.tools should be undefined
    expect(params.tools).toBeUndefined()
  })

  it('omits temperature on a Claude 5 model even when supplied', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await realClient().createMessage({
      model: 'claude-sonnet-5',
      systemPrompt: 'sys',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.3,
    })
    // The API 400s the whole request when these models are sent a temperature.
    expect(sdkCreate.mock.calls[0]![0].temperature).toBeUndefined()
  })

  it('omits temperature on Opus-4.7 even when supplied', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await realClient().createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
      temperature: 0.7,
    })
    expect(sdkCreate.mock.calls[0]![0].temperature).toBeUndefined()
  })

  it('omits temperature when undefined on non-Opus-4.7', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    await realClient().createMessage({
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
    })
    expect(sdkCreate.mock.calls[0]![0].temperature).toBeUndefined()
  })

  it('honors maxTokens override', async () => {
    sdkCreate.mockResolvedValue({
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    await realClient().createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
      maxTokens: 8192,
    })
    expect(sdkCreate.mock.calls[0]![0].max_tokens).toBe(8192)
  })

  it('defaults tool_use.input to {} when SDK returns undefined', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'noop', input: undefined }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const r = await realClient().createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
    })
    expect(r.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'noop', input: {} },
    ])
  })

  it('defaults stop_reason to end_turn and usage counts to 0 when missing', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: null,
      usage: {}, // no input_tokens / output_tokens / cache fields
    })
    const r = await realClient().createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
    })
    expect(r.stop_reason).toBe('end_turn')
    expect(r.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

// ─── createMessage stub path ────────────────────────────────────

describe('AnthropicClient.createMessage — stub mode', () => {
  const stub = new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' }))

  function call(text: string) {
    return stub.createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
  }

  it('returns the canned text response by default', async () => {
    const r = await call('Hi there!')
    expect(r.stop_reason).toBe('end_turn')
    expect(r.content[0]).toEqual({
      type: 'text',
      text: 'Thanks for reaching out — happy to help.',
    })
  })

  it('returns tool_use attach_tag on STUB_USE_TOOL marker', async () => {
    const r = await call('please STUB_USE_TOOL now')
    expect(r.stop_reason).toBe('tool_use')
    const c = r.content[0] as { type: string; name: string; input: { tag: string } }
    expect(c.type).toBe('tool_use')
    expect(c.name).toBe('attach_tag')
    expect(c.input).toEqual({ tag: 'stubbed' })
  })

  it('returns tool_use assign_conversation_to_human on STUB_ASSIGN_HUMAN marker', async () => {
    const r = await call('please STUB_ASSIGN_HUMAN')
    expect(r.stop_reason).toBe('tool_use')
    const c = r.content[0] as { type: string; name: string }
    expect(c.name).toBe('assign_conversation_to_human')
  })

  it('returns tool_use for the tool named by a STUB_CALL_TOOL:<name> marker', async () => {
    const r = await call('please STUB_CALL_TOOL:refund_order now')
    expect(r.stop_reason).toBe('tool_use')
    const c = r.content[0] as { type: string; name: string; input: unknown }
    expect(c.type).toBe('tool_use')
    expect(c.name).toBe('refund_order')
    expect(c.input).toEqual({ source: 'stub' })
  })

  it('returns 1M output tokens on STUB_BIG_RESPONSE marker', async () => {
    const r = await call('STUB_BIG_RESPONSE')
    expect(r.usage.outputTokens).toBe(1_000_000)
  })

  it('returns uncertain reply on STUB_UNCERTAIN marker', async () => {
    const r = await call('STUB_UNCERTAIN')
    const c = r.content[0] as { text: string }
    expect(c.text).toMatch(/not sure|check/i)
  })

  it('returns end-of-loop reply when last turn was a tool_result', async () => {
    const r = await stub.createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
      ],
    })
    expect(r.stop_reason).toBe('end_turn')
    const c = r.content[0] as { text: string }
    expect(c.text).toMatch(/Anything else/)
  })

  it('handles empty messages array gracefully', async () => {
    const r = await stub.createMessage({
      model: 'claude-opus-4-7',
      systemPrompt: 'sys',
      tools: [],
      messages: [],
    })
    // Falls through to default canned text reply.
    expect(r.stop_reason).toBe('end_turn')
  })
})

// ─── classifyDeviation ──────────────────────────────────────────

describe('AnthropicClient.classifyDeviation', () => {
  function realReply(text: string) {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    })
    return new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
  }

  it('stub prefers answer when allowed', async () => {
    const stub = new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' }))
    expect(
      await stub.classifyDeviation({ stepIntent: 'collect email', userText: 'why?', allowedActions: ['answer', 'fill'] }),
    ).toEqual({
      action: 'answer',
      reply: '[stub] why?',
      value: null,
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('stub falls back to the first allowed action when answer is not allowed', async () => {
    const stub = new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' }))
    const r = await stub.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['handoff'] })
    expect(r.action).toBe('handoff')
  })

  it('stub defaults to answer when no actions are allowed', async () => {
    const stub = new AnthropicClient(makeConfig({ COSMIKA_AI_STUB: '1' }))
    const r = await stub.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: [] })
    expect(r.action).toBe('answer')
  })

  it('real parses a valid JSON decision', async () => {
    const c = realReply('{"action":"fill","reply":"Got it","value":"a@b.com"}')
    expect(
      await c.classifyDeviation({ stepIntent: 'collect email', userText: 'a@b.com', allowedActions: ['answer', 'fill'] }),
    ).toEqual({
      action: 'fill',
      reply: 'Got it',
      value: 'a@b.com',
      model: 'claude-haiku-4-5',
      // The caller bills this to the account's AI budget; a classifier that
      // reported nothing is how flow spend stayed invisible.
      usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('real coerces a disallowed action to the first allowed', async () => {
    const c = realReply('{"action":"exit","reply":"bye","value":null}')
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['answer'] })
    expect(r.action).toBe('answer')
    expect(r.reply).toBe('bye')
    expect(r.value).toBeNull()
  })

  it('real falls back to raw text when reply is missing, value non-string → null', async () => {
    const c = realReply('{"action":"answer","value":123}')
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['answer'] })
    expect(r.reply).toBe('{"action":"answer","value":123}')
    expect(r.value).toBeNull()
  })

  it('real extracts JSON embedded in prose', async () => {
    const c = realReply('Sure thing {"action":"answer","reply":"ok","value":""} done')
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['answer'] })
    expect(r.action).toBe('answer')
    expect(r.reply).toBe('ok')
    expect(r.value).toBeNull() // empty string → null
  })

  it('real falls back when the text is not parseable JSON', async () => {
    const c = realReply('no json here at all')
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['handoff', 'answer'] })
    expect(r.action).toBe('handoff') // fallback = first allowed
    expect(r.reply).toBe('no json here at all')
  })

  it('real ignores a non-object JSON (array) and falls back', async () => {
    const c = realReply('[1,2,3]')
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['answer'] })
    expect(r.action).toBe('answer')
    expect(r.reply).toBe('[1,2,3]')
  })

  it('real handles no text block (empty raw)', async () => {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 0 },
    })
    const c = new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
    const r = await c.classifyDeviation({ stepIntent: 's', userText: 'x', allowedActions: ['answer'] })
    expect(r).toEqual({
      action: 'answer',
      reply: '',
      value: null,
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })
})

describe('modelRejectsTemperature', () => {
  it('is true for Opus 4.7 and the Claude 5 family, including dated aliases', () => {
    for (const m of [
      'claude-opus-4-7',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-5-20260401',
    ]) {
      expect(modelRejectsTemperature(m)).toBe(true)
    }
  })

  it('is false for models that still accept the knob', () => {
    for (const m of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', '']) {
      expect(modelRejectsTemperature(m)).toBe(false)
    }
  })
})


describe('withHistoryBreakpoint', () => {
  it('marks only the last block of the last message, on a copy', () => {
    const history = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'b' },
          { type: 'text' as const, text: 'c' },
        ],
      },
    ]
    const out = withHistoryBreakpoint(history)
    expect(out[1]!.content[1]).toEqual({
      type: 'text',
      text: 'c',
      cache_control: { type: 'ephemeral' },
    })
    expect(out[1]!.content[0]).not.toHaveProperty('cache_control')
    expect(out[0]).toBe(history[0])
    // Callers persist these objects; the marker must not leak into storage.
    expect(history[1]!.content[1]).not.toHaveProperty('cache_control')
  })

  it('leaves an empty history, or an empty last message, alone', () => {
    expect(withHistoryBreakpoint([])).toEqual([])
    const empty = [{ role: 'user' as const, content: [] }]
    expect(withHistoryBreakpoint(empty)).toBe(empty)
  })
})

// Conversation 8741 (2026-10-13): fed one sentence and nothing else, the
// classifier asked a customer with a stopped bot for an "order number", and
// promised a transfer the inbox policy did not allow.
describe('AnthropicClient.classifyDeviation, with the conversation in view', () => {
  function client() {
    sdkCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"action":"handoff","reply":"Vou te passar para a equipe.","value":null}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    })
    return new AnthropicClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' }))
  }
  function sent() {
    const req = sdkCreate.mock.calls.at(-1)![0] as {
      system: Array<{ text: string }> | string
      messages: Array<{ content: Array<{ text: string }> }>
    }
    const system = typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('')
    return { system, user: req.messages[0]!.content[0]!.text }
  }

  it('speaks for the business, in its language, with the transcript and the latest message', async () => {
    const r = await client().classifyDeviation({
      stepIntent: 'ask the company website',
      userText: 'Precisamos resolver',
      allowedActions: ['answer', 'handoff'],
      transcript: 'Cliente: Meu bot está parado\nBot: Qual o site?',
      businessName: 'CosmoBots',
      locale: 'pt-BR',
    })
    const { system, user } = sent()
    expect(system).toContain('WhatsApp assistant of CosmoBots')
    expect(system).toContain('Brazilian Portuguese')
    expect(system).toMatch(/never say you will transfer/i)
    expect(system).toMatch(/order numbers/)
    expect(user).toContain('Cliente: Meu bot está parado')
    expect(user).toContain("Customer's latest message: Precisamos resolver")
    expect(r.action).toBe('handoff')
  })

  it('falls back to a neutral business name and Portuguese, and copes with no transcript', async () => {
    await client().classifyDeviation({
      stepIntent: 's',
      userText: 'oi',
      allowedActions: ['answer'],
      locale: 'xx',
    })
    const { system, user } = sent()
    expect(system).toContain('WhatsApp assistant of the company')
    expect(system).toContain('Brazilian Portuguese')
    expect(user).toBe("Customer's latest message: oi")
  })

  it('writes in the account language when it is not Portuguese', async () => {
    await client().classifyDeviation({
      stepIntent: 's', userText: 'hola', allowedActions: ['answer'], locale: 'es', transcript: '   ',
    })
    expect(sent().system).toContain('Spanish')
    expect(sent().user).toBe("Customer's latest message: hola")
  })
})
