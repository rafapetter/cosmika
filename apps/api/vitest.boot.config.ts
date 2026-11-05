import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Separate config for the DI boot test ONLY.
//
// Why it can't live in the main suite: vitest transpiles with esbuild, which
// does not emit the `design:paramtypes` decorator metadata NestJS relies on
// to resolve constructor dependencies. Under esbuild every injected argument
// resolves to `undefined`, so a boot test there fails for the wrong reason
// and can never validate the real dependency graph.
//
// swc emits that metadata. It is scoped to this config so the 2000+ unit
// tests keep their current (fast, proven) esbuild transform — a transform
// swap across the whole suite is a much larger blast radius than this
// problem warrants.
//
// No coverage here: this test asserts the module graph compiles, not lines.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.boot.test.ts'],
    // Nest instantiates every provider in the graph; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
})
