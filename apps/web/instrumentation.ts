// Next.js instrumentation hook — loads on every server start (Node + Edge
// runtimes). We branch by runtime so we can use the right Sentry SDK.

export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}
