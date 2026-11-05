import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vitest config for apps/web. Uses jsdom for React Testing Library and
// next/router shims. Coverage is v8-backed to match apps/api.
//
// Per-file 100% thresholds are added as modules are individually pinned;
// global thresholds will be enabled once we cross the L4 line of 85%.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror tsconfig "paths" so vitest can resolve `@/…` imports.
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        // Next.js entry points / framework boilerplate — covered by build, not unit tests.
        'src/app/**/layout.tsx',
        'src/app/**/page.tsx',
        'src/app/**/route.ts',
        'src/app/**/loading.tsx',
        'src/app/**/error.tsx',
        'src/app/**/not-found.tsx',
        // Page-coupled subcomponents (the `_xxx.tsx` convention): these are
        // tightly bound to one page, use React Query cache + router state, and
        // are exercised by the Playwright e2e suite (398 checks). Same
        // reasoning as apps/api excluding controllers — they're e2e-tested
        // rather than unit-tested. Standalone reusable components in
        // src/components/ ARE unit-tested.
        'src/app/**/_*.tsx',
        'src/app/**/_*.ts',
        'src/i18n/request.ts', // Server-only next-intl bootstrap
        // Test files themselves.
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
      ],
      // L4 sprint global thresholds. Crossed at 99.28% lines / 96.42%
      // branches / 99.34% functions on 2026-05-25 with the page-coupled
      // subcomponent exclusion in place. The 85/80/85/85 numbers are the
      // floor — any drop below these fails CI.
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        // The welcome flow. Pinned because the expensive failures here are
        // silent: an invited member seeing the account questions, a skip that
        // does not let somebody in, or a resume that retypes the form over
        // what the person was in the middle of writing.
        // Every flow question and agent reply goes through it; a wrong match
        // eats a customer's asterisks or bolds half a sentence.
        'src/lib/whatsapp-format.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Embedded Signup: which origins are trusted, how the 30-second code
        // is paired with the WABA ids, and what the customer reads when Meta
        // stops the flow.
        'src/lib/embedded-signup.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/components/whatsapp-embedded-signup.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // What the agent sees right after pressing send: a wrong merge shows a
        // message twice, or hides one that did go out.
        'src/lib/optimistic-messages.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/components/onboarding-flow.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/components/business-profile-fields.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/components/business-profile-form.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/components/onboarding-profile-prompt.tsx': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
})
