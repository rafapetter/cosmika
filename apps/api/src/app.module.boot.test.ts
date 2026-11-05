import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'

import { AppModule } from './app.module'
import { PrismaService } from './prisma/prisma.service'

/**
 * Compiles the REAL dependency graph.
 *
 * This exists because two production outages on 2026-08-06 were caused by DI
 * wiring that no unit test could see — unit tests construct providers by hand,
 * so a missing provider or a circular import is invisible to them:
 *
 *   1. BillingModule wasn't @Global, so AuthGuard couldn't resolve it in the
 *      feature modules that apply it via @UseGuards.
 *   2. auto-reply.service imports WhatsappService, which imports
 *      conversations.service back; the param type resolved to `undefined` and
 *      Nest reported "dependency at index [12]".
 *
 * Both failed only at container boot. This test reproduces that boot in CI.
 *
 * `compile()` instantiates every provider but does NOT run lifecycle hooks
 * (onModuleInit), so nothing connects to Postgres, Redis or Meta. Prisma is
 * overridden anyway so no client is constructed.
 *
 * Runs under vitest.boot.config.ts (swc), not the main config — see the
 * comment there for why esbuild cannot host this test.
 */
describe('AppModule (dependency graph)', () => {
  it('resolves every provider, guard and controller', async () => {
    const prismaStub = {
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $on: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
      onModuleInit: vi.fn().mockResolvedValue(undefined),
      enableShutdownHooks: vi.fn(),
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile()

    // Reaching here means Nest resolved the whole graph. Spot-check that a
    // guard with cross-module dependencies actually materialised, since that
    // is the exact shape that broke twice.
    const { AuthGuard } = await import('./modules/auth/auth.guard')
    expect(moduleRef.get(AuthGuard, { strict: false })).toBeDefined()

    await moduleRef.close()
  })
})
