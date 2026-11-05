import {
  Controller,
  Get,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'

import { PrismaService } from '../../prisma/prisma.service'

@Controller()
export class HealthController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthController.name)
  private redis: Redis | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379'
    // lazyConnect so app boot doesn't fail if Redis is briefly unreachable.
    this.redis = new Redis(url, { lazyConnect: true })
    this.redis.on('error', (err) =>
      this.logger.warn(`redis (health probe) error: ${err.message}`),
    )
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit().catch(() => undefined)
  }

  /** Liveness — just confirms the process is up. Cheap. */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'cosmika-api',
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Readiness — confirms downstreams are reachable. Used by deploy tooling /
   * load balancers to gate traffic. Returns 503 if Postgres OR Redis is down.
   */
  @Get('ready')
  async ready() {
    const checks: Record<string, { ok: boolean; error?: string }> = {}

    try {
      await this.prisma.$queryRawUnsafe('SELECT 1')
      checks.postgres = { ok: true }
    } catch (err) {
      checks.postgres = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    try {
      const pong = await this.redis!.ping()
      checks.redis = { ok: pong === 'PONG' }
    } catch (err) {
      checks.redis = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const allOk = Object.values(checks).every((c) => c.ok)
    const body = {
      status: allOk ? 'ready' : 'not_ready',
      service: 'cosmika-api',
      timestamp: new Date().toISOString(),
      checks,
    }
    if (!allOk) throw new ServiceUnavailableException(body)
    return body
  }
}
