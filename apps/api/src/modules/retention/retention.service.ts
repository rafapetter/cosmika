import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import * as Sentry from '@sentry/node'

import { PrismaService } from '../../prisma/prisma.service'

/**
 * Nightly retention prune. Deletes stale rows that grow unbounded otherwise.
 * Thresholds are conservative enough that no real production data is lost —
 * deliveries and audit entries are operational telemetry, not source of truth.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name)
  private running = false

  private readonly WEBHOOK_DELIVERY_RETENTION_DAYS = 30
  private readonly AUDIT_LOG_RETENTION_DAYS = 90

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runDaily() {
    if (this.running) return
    this.running = true
    try {
      const w = await this.pruneWebhookDeliveries()
      const a = await this.pruneAuditLogs()
      this.logger.log(
        `retention prune complete: removed ${w} webhook deliveries, ${a} audit log rows`,
      )
    } catch (err) {
      this.logger.error(
        `retention prune failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      Sentry.captureException(err)
    } finally {
      this.running = false
    }
  }

  async pruneWebhookDeliveries(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    )
    const result = await this.prisma.webhookDelivery.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    return result.count
  }

  async pruneAuditLogs(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    )
    const result = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    return result.count
  }
}
