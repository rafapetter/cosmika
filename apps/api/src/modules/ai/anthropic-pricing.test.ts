import { describe, expect, it } from 'vitest'

import { computeCostUsd, pricingFor } from './anthropic-pricing'

describe('pricingFor', () => {
  it('returns the dedicated table entry for claude-opus-4-7', () => {
    const p = pricingFor('claude-opus-4-7')
    expect(p.input).toBe(5.0)
    expect(p.output).toBe(25.0)
    expect(p.cacheRead).toBe(0.5)
    expect(p.cacheWrite5m).toBe(6.25)
  })

  it('returns the dedicated entry for claude-sonnet-4-6', () => {
    const p = pricingFor('claude-sonnet-4-6')
    expect(p.input).toBe(3.0)
    expect(p.output).toBe(15.0)
  })

  it('prices claude-sonnet-5 below sonnet 4.6, as published', () => {
    const p = pricingFor('claude-sonnet-5')
    expect(p.input).toBe(2.0)
    expect(p.output).toBe(10.0)
    expect(p.cacheWrite5m).toBe(2.5)
    expect(p.cacheRead).toBe(0.2)
  })

  it('prices gpt-5.6-luna at OpenAI rates, with no charge for cache writes', () => {
    const p = pricingFor('gpt-5.6-luna')
    expect(p).toEqual({ input: 0.2, output: 1.2, cacheWrite5m: 0, cacheRead: 0.02 })
  })

  it('prices the OpenRouter standby model at its list rate', () => {
    expect(pricingFor('deepseek/deepseek-v4.1-flash')).toEqual({
      input: 0.15,
      output: 0.6,
      cacheWrite5m: 0,
      cacheRead: 0.15,
    })
  })

  it('falls back for claude-haiku-4-5 (uses FALLBACK)', () => {
    const p = pricingFor('claude-haiku-4-5')
    expect(p.input).toBe(1.0)
    expect(p.output).toBe(5.0)
  })

  it('falls back for any unknown model', () => {
    const p = pricingFor('claude-fake-2-1')
    expect(p.input).toBe(1.0)
    expect(p.output).toBe(5.0)
    expect(p.cacheWrite5m).toBe(1.25)
    expect(p.cacheRead).toBe(0.1)
  })
})

describe('computeCostUsd', () => {
  it('zero usage → zero cost', () => {
    expect(
      computeCostUsd('claude-opus-4-7', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0)
  })

  it('1M input + 1M output on opus-4-7 = $5 + $25 = $30', () => {
    expect(
      computeCostUsd('claude-opus-4-7', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(30)
  })

  it('factors in cache reads and writes proportionally', () => {
    // opus-4-7: cacheRead 0.5, cacheWrite5m 6.25
    // 1M cache read = $0.50, 1M cache write = $6.25
    expect(
      computeCostUsd('claude-opus-4-7', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(6.75, 6)
  })

  it('uses the model-specific pricing (sonnet vs opus differs)', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    const opus = computeCostUsd('claude-opus-4-7', usage)
    const sonnet = computeCostUsd('claude-sonnet-4-6', usage)
    expect(opus).toBeGreaterThan(sonnet)
    expect(sonnet).toBe(3 + 15)
  })

  it('falls back to FALLBACK pricing for unknown models', () => {
    expect(
      computeCostUsd('made-up-model', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(6) // 1 + 5
  })

  it('scales linearly for partial million counts', () => {
    // 500K input on opus = (500_000 * 5) / 1_000_000 = 2.5
    expect(
      computeCostUsd('claude-opus-4-7', {
        inputTokens: 500_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(2.5)
  })
})
