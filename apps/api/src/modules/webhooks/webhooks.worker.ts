import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import * as Sentry from '@sentry/node'

import { WebhooksService } from './webhooks.service'

@Injectable()
export class WebhooksWorker {
  private readonly logger = new Logger(WebhooksWorker.name)
  private running = false

  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Runs every 30 seconds. Skips a tick if the previous one is still in
   * flight — we don't want overlapping workers double-firing the same row.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick() {
    if (this.running) return
    this.running = true
    try {
      const processed = await this.webhooks.processDueDeliveries()
      if (processed > 0) {
        this.logger.log(`processed ${processed} due webhook deliveries`)
      }
    } catch (err) {
      this.logger.error(
        `webhook worker tick failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      // A failing tick means webhooks silently stop flowing — page on it.
      Sentry.captureException(err)
    } finally {
      this.running = false
    }
  }
}
