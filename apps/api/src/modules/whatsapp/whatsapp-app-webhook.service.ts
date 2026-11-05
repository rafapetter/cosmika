import { createHmac, timingSafeEqual } from 'node:crypto'

import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { appWebhookSettings } from './embedded-signup.config'
import { WhatsappService } from './whatsapp.service'
import { isEmbeddedSignupConfig } from './whatsapp-embedded-signup.service'

type AppWebhookChange = { field?: string; value?: Record<string, unknown> }
type AppWebhookEntry = { id?: string; changes?: AppWebhookChange[] }
export type AppWebhookPayload = { object?: string; entry?: AppWebhookEntry[] }

/**
 * Fields the per-inbox override receives. One that reaches this route instead
 * means the override is missing (it was never set, or Meta dropped it), and
 * the delivery is handed to the inbox so no customer message is lost.
 */
const OVERRIDE_FIELDS = new Set(['messages'])

/** Biggest event payload kept in the audit log, in characters of JSON. */
const AUDIT_VALUE_MAX = 4000

/**
 * Our app's default callback for the WhatsApp Business Account object.
 *
 * Messages for an Embedded Signup channel go to that channel's own URL (the
 * override set at onboarding). What Meta never sends to an override lands
 * here: template reviews (message_template_status_update), account_update,
 * account_alerts and the phone number quality and name updates. Each entry is
 * routed by its WABA id to the channels created by Embedded Signup; channels
 * on a customer's own Meta app never subscribed our app and are never matched.
 *
 * Signed with our app secret (META_APP_SECRET), not a per-inbox one.
 */
@Injectable()
export class WhatsappAppWebhookService {
  private readonly logger = new Logger(WhatsappAppWebhookService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly whatsapp: WhatsappService,
  ) {}

  verifyChallenge(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): string {
    const settings = appWebhookSettings()
    if (!settings) throw new NotFoundException()
    if (mode !== 'subscribe' || !token || !challenge || !safeEqual(token, settings.verifyToken)) {
      throw new ForbiddenException()
    }
    return challenge
  }

  async ingest(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    payload: AppWebhookPayload,
  ): Promise<{ processed: number; ignored: number }> {
    const s = appWebhookSettings()
    if (!s) throw new NotFoundException()
    const expected = `sha256=${createHmac('sha256', s.appSecret).update(rawBody).digest('hex')}`
    if (!signatureHeader || !safeEqual(signatureHeader, expected)) {
      throw new ForbiddenException('Forbidden')
    }

    let processed = 0
    let ignored = 0
    if (payload.object !== 'whatsapp_business_account') {
      // Answer 200 anyway: a non-2xx makes Meta retry for days.
      return { processed, ignored: 1 }
    }

    for (const entry of payload.entry ?? []) {
      const wabaId = entry.id
      const inboxes = wabaId ? await this.inboxesForWaba(wabaId) : []
      for (const change of entry.changes ?? []) {
        if (inboxes.length === 0 || !change.field) {
          ignored += 1
          continue
        }
        if (OVERRIDE_FIELDS.has(change.field)) {
          for (const inbox of inboxes) {
            // ingestWebhook checks the signature against the inbox's own app
            // secret, which for these channels is ours, and drops a change
            // for any other number of the WABA.
            try {
              const r = await this.whatsapp.ingestWebhook(inbox.id, rawBody, signatureHeader, {
                object: 'whatsapp_business_account',
                entry: [{ id: wabaId!, changes: [change] }],
              } as Parameters<WhatsappService['ingestWebhook']>[3])
              processed += r.processed
            } catch (err) {
              // One channel's problem must not make Meta retry the whole
              // delivery for every other channel of the WABA.
              this.logger.warn(
                `app webhook: fallback delivery to inbox ${inbox.id} failed: ${err instanceof Error ? err.name : 'unknown error'}`,
              )
              ignored += 1
            }
          }
          continue
        }
        if (change.field === 'message_template_status_update') {
          await this.applyTemplateStatus(inboxes, change.value ?? {})
        }
        await this.recordEvent(inboxes, wabaId!, change)
        processed += 1
      }
    }
    return { processed, ignored }
  }

  private async inboxesForWaba(wabaId: string): Promise<Array<{ id: string; accountId: string }>> {
    const rows = await this.prisma.inbox.findMany({
      where: {
        channelType: 'WHATSAPP',
        channelConfig: { path: ['businessAccountId'], equals: wabaId },
      },
      select: { id: true, accountId: true, channelConfig: true },
    })
    return rows
      .filter((r) => isEmbeddedSignupConfig(r.channelConfig))
      .map((r) => ({ id: r.id, accountId: r.accountId }))
  }

  /** A template was approved, rejected, paused or disabled at Meta. */
  private async applyTemplateStatus(
    inboxes: Array<{ id: string }>,
    value: Record<string, unknown>,
  ): Promise<void> {
    const name = value.message_template_name
    const language = value.message_template_language
    const status = value.event
    if (typeof name !== 'string' || typeof language !== 'string' || typeof status !== 'string') {
      return
    }
    await this.prisma.whatsappTemplate.updateMany({
      where: { inboxId: { in: inboxes.map((i) => i.id) }, name, language },
      data: { status, syncedAt: new Date() },
    })
  }

  /**
   * Leave a trace the account's administrators can read in the audit log:
   * a ban, a quality drop or a rejected template is otherwise invisible
   * until a send starts failing.
   */
  private async recordEvent(
    inboxes: Array<{ id: string; accountId: string }>,
    wabaId: string,
    change: AppWebhookChange,
  ): Promise<void> {
    const value = change.value ?? {}
    const json = JSON.stringify(value)
    const event = typeof value.event === 'string' ? value.event : null
    this.logger.log(`app webhook: waba ${wabaId} ${change.field} ${event ?? ''}`.trim())
    for (const inbox of inboxes) {
      await this.audit.record({
        accountId: inbox.accountId,
        actorId: null,
        action: 'whatsapp.waba_event',
        target: `inbox:${inbox.id}`,
        metadata: {
          field: change.field,
          wabaId,
          event,
          ...(json.length <= AUDIT_VALUE_MAX ? { value } : { truncated: true }),
        },
      })
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
