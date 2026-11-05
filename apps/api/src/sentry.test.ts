// Verifies the sentry bootstrap obeys SENTRY_DSN: no-op when unset, init+log
// when set. The module is side-effect at import time so each scenario calls
// `vi.resetModules()` and re-imports to get a fresh evaluation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const initSpy = vi.fn()
vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initSpy(...args),
}))

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  initSpy.mockClear()
  vi.restoreAllMocks()
})

describe('sentry bootstrap', () => {
  beforeEach(() => {
    // Reset modules so the next import re-executes top-level code.
    vi.resetModules()
  })

  it('is a no-op when SENTRY_DSN is unset', async () => {
    delete process.env.SENTRY_DSN
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./sentry')
    expect(initSpy).not.toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('calls Sentry.init and logs when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://example@sentry.io/123'
    process.env.SENTRY_ENVIRONMENT = 'staging'
    process.env.SENTRY_RELEASE = 'rev-abc'
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.5'
    process.env.SENTRY_SAMPLE_RATE = '0.9'
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./sentry')
    expect(initSpy).toHaveBeenCalledWith({
      dsn: 'https://example@sentry.io/123',
      environment: 'staging',
      release: 'rev-abc',
      tracesSampleRate: 0.5,
      sampleRate: 0.9,
      sendDefaultPii: false,
    })
    expect(consoleSpy).toHaveBeenCalledWith('[sentry] enabled')
  })

  it('falls back to NODE_ENV when SENTRY_ENVIRONMENT is unset', async () => {
    process.env.SENTRY_DSN = 'https://example@sentry.io/123'
    delete process.env.SENTRY_ENVIRONMENT
    process.env.NODE_ENV = 'test-fallback'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./sentry')
    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'test-fallback' }),
    )
  })

  it('falls back to "production" when both SENTRY_ENVIRONMENT and NODE_ENV unset', async () => {
    process.env.SENTRY_DSN = 'https://example@sentry.io/123'
    delete process.env.SENTRY_ENVIRONMENT
    delete process.env.NODE_ENV
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./sentry')
    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'production' }),
    )
  })

  it('defaults tracesSampleRate=0.1 and sampleRate=1.0 when env vars unset', async () => {
    process.env.SENTRY_DSN = 'https://example@sentry.io/123'
    delete process.env.SENTRY_TRACES_SAMPLE_RATE
    delete process.env.SENTRY_SAMPLE_RATE
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await import('./sentry')
    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tracesSampleRate: 0.1, sampleRate: 1.0 }),
    )
  })
})
