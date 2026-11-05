// Per-million-token pricing for cost tracking. Update when pricing changes.
// Values are USD per million tokens.
export type ModelPricing = {
  input: number
  output: number
  cacheWrite5m: number
  cacheRead: number
}

const FALLBACK: ModelPricing = {
  input: 1.0,
  output: 5.0,
  cacheWrite5m: 1.25,
  cacheRead: 0.1,
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': {
    input: 5.0,
    output: 25.0,
    cacheWrite5m: 6.25, // 1.25x input
    cacheRead: 0.5, // 0.1x input
  },
  'claude-sonnet-5': {
    input: 2.0,
    output: 10.0,
    cacheWrite5m: 2.5, // 1.25x input
    cacheRead: 0.2, // 0.1x input
  },
  'claude-opus-4-7': {
    input: 5.0,
    output: 25.0,
    cacheWrite5m: 6.25, // 1.25x input
    cacheRead: 0.5, // 0.1x input
  },
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheWrite5m: 3.75,
    cacheRead: 0.3,
  },
  'claude-haiku-4-5': FALLBACK,
  // OpenRouter bills the provider's list price per token (its 5.5% fee is on
  // buying credits, not per call). Cache reads priced as input: not all
  // zero-retention endpoints discount them.
  'deepseek/deepseek-v4.1-flash': {
    input: 0.15,
    output: 0.6,
    cacheWrite5m: 0,
    cacheRead: 0.15,
  },
  'gpt-5.6-luna': {
    input: 0.2,
    output: 1.2,
    cacheWrite5m: 0, // OpenAI caches automatically, writes are not billed
    cacheRead: 0.02,
  },
}

export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK
}

export type UsageBreakdown = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function computeCostUsd(model: string, usage: UsageBreakdown): number {
  const p = pricingFor(model)
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite5m) /
    1_000_000
  )
}
