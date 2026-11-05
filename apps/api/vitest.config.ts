import { defineConfig } from 'vitest/config'

// Vitest config for apps/api. Backed by v8 coverage so we don't pull in a
// separate instrumenter. Excludes are the things we genuinely never test:
// generated Prisma types, the bootstrap entrypoint, the controllers (covered
// by the e2e suite end-to-end, hitting a real running API).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // *.boot.test.ts compiles the real NestJS graph and needs decorator
    // metadata, which this config's esbuild transform does not emit. It runs
    // under vitest.boot.config.ts (swc) via `pnpm test:boot`.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.boot.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/**/*.controller.ts',
        'src/**/*.module.ts',
        'src/**/*.d.ts',
        'src/instrumentation.ts',
        // CLI entrypoints: argument parsing plus a process.exit. The logic
        // they drive lives in src/common/channel-secret-migration.ts, which
        // is pinned at 100% below.
        'src/scripts/**',
        // Test files themselves shouldn't count toward source coverage.
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.boot.test.ts',
      ],
      // L4 sprint thresholds. Global floor is 85% lines / 80% branches /
      // 85% functions / 85% statements; per-file 100% on every module
      // listed below. We crossed the global floor at 100% / 100% / 100% /
      // 100% on 2026-05-25, so the global block enforces the floor while
      // the per-file blocks lock in the 100% pins on security-sensitive
      // modules.
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        // Per-file 100% on the security-sensitive + already-done modules.
        // These are the code paths where a regression is most expensive.
        'src/modules/auth/totp.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Encryption at rest for channel credentials. A regression here is
        // either a leaked secret or a channel that cannot talk to Meta.
        'src/common/secret-crypto.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/channel-secrets.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/channel-secret-migration.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/safe-fetch.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/widget/widget-jwt.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/api-keys/api-keys.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The welcome flow's answers: who may read them, and the two
        // timestamps that decide whether an account is still in the funnel.
        'src/modules/account-profile/account-profile.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/onboarding/onboarding.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/onboarding/onboarding.controller.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/plan-limits.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Measurement and the AI allowance. Everything an invoice is derived
        // from, plus the gate that decides whether a customer's bot answers.
        // A regression in any of these is either money charged that was not
        // owed, or a bot that went quiet for a reason nobody can explain.
        'src/modules/usage/billing-month.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/ai-usage.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/ai-allowance.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/ai-allowance.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/usage-alerts.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/billing/overage.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/billing/plan-sync.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/auth/auth.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/whatsapp/whatsapp.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Embedded Signup: the token exchange, the asset check, the webhook
        // routing and the app-level callback. A regression here either hands
        // one business's events to another account or leaves a new customer
        // with a channel that never receives a message.
        'src/modules/whatsapp/whatsapp-embedded-signup.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/whatsapp/whatsapp-app-webhook.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/whatsapp/embedded-signup.config.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/whatsapp/embedded-signup.graph.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/whatsapp/whatsapp-templates.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/broadcasts/broadcasts.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/usage/usage.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/audit-log/audit-log.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/anthropic-pricing.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/auth/auth.guard.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/agent-availability/agent-availability.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Automatic distribution: who receives a conversation. A regression
        // here silently sends work to people off shift, or to nobody.
        'src/modules/assignment/assignment.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/assignment/availability-window.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/search/search.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/working-hours/working-hours.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/sla/sla.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/teams/teams.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/api-keys/public-api.guard.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/zod-validation.pipe.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/sentry-exception.filter.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/maybe-throttler.guard.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/retention/retention.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/realtime/realtime.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/labels/labels.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/canned-responses/canned-responses.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/custom-attributes/custom-attributes.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/saved-views/saved-views.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/notifications/notifications.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/accounts/accounts.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/webhooks/webhooks.worker.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/common/request-log.interceptor.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/automation/automation.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/widget/widget.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/csat/csat.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/ai-tools.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The AI agent a flow hands a conversation to (pilot 03/04/07).
        'src/modules/ai/flow-agent.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flow-datetime.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/orchestrator.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/prisma/prisma.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/agent-bots.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/webhooks/webhooks.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/contacts/contacts.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/automation/automation.engine.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/articles/articles.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/conversations/conversations.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/inboxes/inboxes.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/sentry.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/attachments/attachments.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/reports/reports.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/anthropic-client.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/ai/openai-chat.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/activity/activity.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/conversations/auto-resolve.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/conversations/auto-reply.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/billing/billing-status.controller.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/billing/billing.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flows.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flow-engine.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flow-lint.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flow-migration.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/support-tickets/support-tickets.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/modules/flows/flow-runner.service.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
})
