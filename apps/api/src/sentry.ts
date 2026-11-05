// Sentry bootstrap for cosmika-api. Initialized at the very top of main.ts
// so it's installed before any other module load can throw. No-op when
// SENTRY_DSN is unset — local dev stays quiet.

import * as Sentry from '@sentry/node'

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    // 100% sample errors; only sample traces for cost control.
    sampleRate: Number(process.env.SENTRY_SAMPLE_RATE ?? 1.0),
    // Don't capture the bodies of inbound webhooks (signatures, tokens).
    sendDefaultPii: false,
  })
  // eslint-disable-next-line no-console
  console.log('[sentry] enabled')
}

export { Sentry }
