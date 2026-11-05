import { randomBytes, createHmac } from 'node:crypto'

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common'
import type { Prisma, Webhook } from '@cosmika/db'
import {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookEvent,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { assertSafeFetchUrl } from '../../common/safe-fetch'
import { errBody } from '../../common/app-error'

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name)

  constructor(private readonly prisma: PrismaService) {}

  private async assertAdmin(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  private generateSecret(): string {
    return 'whsec_' + randomBytes(24).toString('base64url')
  }

  async list(userId: string, accountId: string): Promise<Webhook[]> {
    await this.assertAdmin(userId, accountId)
    return this.prisma.webhook.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateWebhookInput,
  ): Promise<Webhook> {
    await this.assertAdmin(userId, accountId)
    return this.prisma.webhook.create({
      data: {
        accountId,
        name: input.name,
        url: input.url,
        events: input.events,
        secret: this.generateSecret(),
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateWebhookInput,
  ): Promise<Webhook> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.webhook.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    const data: Prisma.WebhookUpdateInput = {}
    if (input.name !== undefined) data.name = input.name
    if (input.url !== undefined) data.url = input.url
    if (input.events !== undefined) data.events = input.events
    if (input.isActive !== undefined) data.isActive = input.isActive
    return this.prisma.webhook.update({ where: { id }, data })
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.webhook.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    await this.prisma.webhook.delete({ where: { id } })
  }

  async listDeliveries(
    userId: string,
    accountId: string,
    id: string,
    limit = 50,
  ) {
    await this.assertAdmin(userId, accountId)
    const wh = await this.prisma.webhook.findUnique({ where: { id } })
    if (!wh || wh.accountId !== accountId) throw new NotFoundException()
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  // ─── retry policy ────────────────────────────────────────────────
  // Backoff schedule per attempt index. Length = max attempts. After the
  // last attempt fails we set status=FAILED and stop retrying.
  private readonly RETRY_BACKOFF_MS = [
    60_000,      // attempt #2 fires 1 min after attempt #1
    5 * 60_000,  // attempt #3 fires 5 min after attempt #2
    30 * 60_000, // we never schedule a 4th — final attempt is #3
  ]
  private readonly MAX_ATTEMPTS = 3

  /**
   * Fire an event to all subscribed webhooks for an account. Records a
   * PENDING delivery row per webhook with nextRetryAt=NOW; the scheduled
   * worker picks it up and runs the actual HTTP POST.
   */
  async dispatch(
    accountId: string,
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const webhooks = await this.prisma.webhook.findMany({
      where: { accountId, isActive: true, events: { has: event } },
      select: { id: true },
    })
    if (webhooks.length === 0) return
    await this.prisma.webhookDelivery.createMany({
      data: webhooks.map((wh) => ({
        webhookId: wh.id,
        event,
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
        nextRetryAt: new Date(),
      })),
    })
  }

  /**
   * Worker entry point. Picks up due deliveries (PENDING + nextRetryAt<=NOW),
   * runs each one. Capped at 50 per tick to avoid stampedes.
   */
  async processDueDeliveries(): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: {
        status: 'PENDING',
        nextRetryAt: { lte: new Date() },
      },
      include: { webhook: true },
      orderBy: { nextRetryAt: 'asc' },
      take: 50,
    })
    for (const d of due) {
      await this.attemptDelivery(d.id, d.webhook, d.event, d.payload, d.attempts)
    }
    return due.length
  }

  /**
   * Force a retry of one delivery — used by the admin "Retry" button. Bumps
   * nextRetryAt to NOW and resets status to PENDING (it may be FAILED). Does
   * not zero attempts — operators want to see the original failure history.
   */
  async retryDelivery(
    userId: string,
    accountId: string,
    webhookId: string,
    deliveryId: string,
  ) {
    await this.assertAdmin(userId, accountId)
    const wh = await this.prisma.webhook.findUnique({ where: { id: webhookId } })
    if (!wh || wh.accountId !== accountId) throw new NotFoundException()
    const d = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
    })
    if (!d || d.webhookId !== webhookId) throw new NotFoundException()
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'PENDING', nextRetryAt: new Date() },
    })
  }

  private async attemptDelivery(
    deliveryId: string,
    wh: Webhook,
    event: string,
    payload: Prisma.JsonValue,
    priorAttempts: number,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    })
    const signature = createHmac('sha256', wh.secret).update(body).digest('hex')
    const attemptNumber = priorAttempts + 1
    let httpStatus: number | null = null
    let success = false
    let errorMessage: string | null = null
    try {
      await assertSafeFetchUrl(wh.url)
      const res = await fetch(wh.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cosmika-event': event,
          'x-cosmika-signature': `sha256=${signature}`,
          'x-cosmika-attempt': String(attemptNumber),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      httpStatus = res.status
      success = res.ok
      if (!res.ok) errorMessage = `HTTP ${res.status}`
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    if (success) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SUCCESS',
          responseStatus: httpStatus,
          errorMessage: null,
          attempts: attemptNumber,
          lastAttemptAt: new Date(),
        },
      })
      return
    }

    // Failure: schedule next retry, or mark FAILED if out of attempts.
    if (attemptNumber >= this.MAX_ATTEMPTS) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          responseStatus: httpStatus,
          errorMessage,
          attempts: attemptNumber,
          lastAttemptAt: new Date(),
        },
      })
      return
    }
    // attemptNumber ∈ [1, MAX_ATTEMPTS-1] here (guarded above), so index
    // (attemptNumber - 1) is always in-range on RETRY_BACKOFF_MS. The
    // `?? 60_000` is a belt-and-braces fallback against future drift if
    // MAX_ATTEMPTS is bumped without extending the backoff schedule.
    /* c8 ignore next */
    const backoffMs = this.RETRY_BACKOFF_MS[attemptNumber - 1] ?? 60_000
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'PENDING',
        responseStatus: httpStatus,
        errorMessage,
        attempts: attemptNumber,
        lastAttemptAt: new Date(),
        nextRetryAt: new Date(Date.now() + backoffMs),
      },
    })
  }

  toDTO(wh: Webhook) {
    return {
      id: wh.id,
      accountId: wh.accountId,
      name: wh.name,
      url: wh.url,
      events: wh.events as WebhookEvent[],
      isActive: wh.isActive,
      createdAt: wh.createdAt.toISOString(),
    }
  }

  toDTOWithSecret(wh: Webhook) {
    return { ...this.toDTO(wh), secret: wh.secret }
  }
}
