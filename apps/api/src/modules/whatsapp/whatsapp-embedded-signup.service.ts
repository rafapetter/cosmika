import { randomBytes, randomInt } from 'node:crypto'

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Inbox, Prisma } from '@cosmika/db'
import {
  WHATSAPP_STORED_SECRET_FIELDS,
  type CompleteEmbeddedSignupInput,
  type EmbeddedSignupConfigDTO,
  type WhatsappOnboarding,
} from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { encryptSecretsIn } from '../../common/secret-crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import {
  embeddedSignupAccountAllowed,
  embeddedSignupSettings,
  type EmbeddedSignupSettings,
} from './embedded-signup.config'
import { describeGraphError, graphCall } from './embedded-signup.graph'

/** Whether a stored channel config was created by Embedded Signup. */
export function isEmbeddedSignupConfig(raw: Prisma.JsonValue): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const onboarding = (raw as Record<string, unknown>).onboarding
  return onboarding === 'embedded_signup' || onboarding === 'coexistence'
}

/** Meta's limit on an override callback URL. */
const OVERRIDE_URI_MAX = 200

type DebugToken = {
  data?: {
    app_id?: string
    is_valid?: boolean
    granular_scopes?: Array<{ scope: string; target_ids?: string[] }>
  }
}

type PhoneNumbers = {
  data?: Array<{ id: string; display_phone_number?: string; verified_name?: string }>
}

/**
 * Onboards a customer's WhatsApp number through Embedded Signup v4, with
 * CosmoBots as the Tech Provider app. The customer's own Meta business keeps
 * owning the WABA and pays Meta directly; we only hold a business token
 * scoped to the assets they shared with us.
 *
 * Order matters:
 *  1. Exchange the code first. It dies 30 seconds after the popup closes, so
 *     only a cheap duplicate check runs before it.
 *  2. Confirm the token really covers the WABA and number the browser named.
 *     The ids come from a postMessage, so they are claims, not facts.
 *  3. Create the inbox, so its per-inbox webhook URL and verify token exist
 *     before Meta is told to call them.
 *  4. Point the WABA's webhooks at that inbox, then register the number.
 *     Any failure from here on deletes the inbox again: a half-onboarded
 *     channel would look connected and never receive a message.
 *
 * Existing inboxes are never read for credentials or changed: this path only
 * creates new ones.
 */
@Injectable()
export class WhatsappEmbeddedSignupService {
  private readonly logger = new Logger(WhatsappEmbeddedSignupService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /** What the screen needs. Any member may ask; the answer holds no secret. */
  async publicConfig(userId: string, accountId: string): Promise<EmbeddedSignupConfigDTO> {
    await this.requireMembership(userId, accountId)
    const s = embeddedSignupSettings()
    if (!s || !embeddedSignupAccountAllowed(accountId)) return { enabled: false }
    return {
      enabled: true,
      appId: s.appId,
      configId: s.configId,
      graphApiVersion: s.graphApiVersion,
    }
  }

  async complete(
    userId: string,
    accountId: string,
    input: CompleteEmbeddedSignupInput,
  ): Promise<Inbox> {
    const s = embeddedSignupSettings()
    if (!s || !embeddedSignupAccountAllowed(accountId)) throw new NotFoundException()
    const membership = await this.requireMembership(userId, accountId)
    if (membership.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
    if (!input.phoneNumberId) {
      throw new BadRequestException(
        errBody('whatsapp_es_phone_required', 'Embedded Signup finished without a phone number'),
      )
    }
    const phoneNumberId = input.phoneNumberId
    const onboarding: WhatsappOnboarding =
      input.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
        ? 'coexistence'
        : 'embedded_signup'

    // A number lives in one channel, in one account. This also keeps every
    // customer still on their own Meta app exactly where they are: their
    // number is already a channel, so it cannot be onboarded a second time.
    const clash = await this.prisma.inbox.findFirst({
      where: {
        channelType: 'WHATSAPP',
        channelConfig: { path: ['phoneNumberId'], equals: phoneNumberId },
      },
      select: { id: true },
    })
    if (clash) {
      throw new ConflictException(
        errBody('whatsapp_es_phone_already_connected', 'This phone number is already connected to a channel'),
      )
    }

    const businessToken = await this.exchangeCode(s, input.code)
    const phone = await this.confirmAssets(s, businessToken, input.wabaId, phoneNumberId)

    // Another number of the same WABA already onboarded here means the WABA
    // override already points at that number's inbox. Re-subscribing would
    // move it, so this number gets its own phone-level override instead
    // (Meta checks the phone override before the WABA one).
    // Channels on the same WABA that still run on a customer's own Meta app
    // do not count: our app's WABA override is only ours to have set.
    const sameWaba = await this.prisma.inbox.findMany({
      where: {
        channelType: 'WHATSAPP',
        channelConfig: { path: ['businessAccountId'], equals: input.wabaId },
      },
      select: { id: true, channelConfig: true },
    })
    const sibling = sameWaba.some((i) => isEmbeddedSignupConfig(i.channelConfig))

    const webhookVerifyToken = randomBytes(24).toString('hex')
    const registrationPin =
      onboarding === 'embedded_signup' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : undefined
    const name = input.name ?? phone.verified_name ?? phone.display_phone_number ?? 'WhatsApp'
    const config: Record<string, unknown> = {
      phoneNumberId,
      businessAccountId: input.wabaId,
      accessToken: businessToken,
      appSecret: s.appSecret,
      webhookVerifyToken,
      ...(registrationPin && { registrationPin }),
      onboarding,
      ...(input.businessId && { businessId: input.businessId }),
      ...(phone.display_phone_number && { displayPhoneNumber: phone.display_phone_number }),
      onboardedAt: new Date().toISOString(),
    }

    const inbox = await this.prisma.inbox.create({
      data: {
        accountId,
        name,
        channelType: 'WHATSAPP',
        channelConfig: encryptSecretsIn(config, WHATSAPP_STORED_SECRET_FIELDS) as Prisma.InputJsonValue,
        aiAutoreplyMode: 'DRAFT',
        autoResolveMinutes: 10080,
      },
    })

    const callbackUri = `${s.publicApiUrl}/webhooks/whatsapp/${inbox.id}`
    let routed: 'waba' | 'phone' | null = null
    try {
      if (callbackUri.length > OVERRIDE_URI_MAX) {
        throw this.metaStepFailed('whatsapp_es_subscribe_failed', 'callback URL longer than 200 characters')
      }
      if (sibling) {
        await this.step(
          s,
          `${phoneNumberId}`,
          businessToken,
          { webhook_configuration: { override_callback_uri: callbackUri, verify_token: webhookVerifyToken } },
          'whatsapp_es_subscribe_failed',
        )
        routed = 'phone'
      } else {
        await this.step(
          s,
          `${input.wabaId}/subscribed_apps`,
          businessToken,
          { override_callback_uri: callbackUri, verify_token: webhookVerifyToken },
          'whatsapp_es_subscribe_failed',
        )
        routed = 'waba'
      }
      // Coexistence: the number stays live on the WhatsApp Business app and
      // is already registered there. Calling register would take it off the
      // phone, which is exactly what the customer chose not to do.
      if (registrationPin) {
        await this.step(
          s,
          `${phoneNumberId}/register`,
          businessToken,
          { messaging_product: 'whatsapp', pin: registrationPin },
          'whatsapp_es_register_failed',
        )
      }
    } catch (err) {
      await this.rollback(s, inbox.id, businessToken, input.wabaId, phoneNumberId, routed)
      throw err
    }

    await this.audit.record({
      accountId,
      actorId: userId,
      action: 'inbox.whatsapp_embedded_signup',
      target: `inbox:${inbox.id}`,
      metadata: { wabaId: input.wabaId, phoneNumberId, onboarding, webhookRouting: routed },
    })
    this.logger.log(
      `embedded signup: inbox ${inbox.id} created for waba ${input.wabaId} phone ${phoneNumberId} (${onboarding}, ${routed} override)`,
    )
    return inbox
  }

  // ─── steps ──────────────────────────────────────────────────────

  private async exchangeCode(s: EmbeddedSignupSettings, code: string): Promise<string> {
    const res = await graphCall<{ access_token?: string }>(s.graphBase, 'oauth/access_token', {
      query: { client_id: s.appId, client_secret: s.appSecret, code },
    })
    if (!res.ok || !res.data.access_token) {
      this.logger.warn(
        `embedded signup: code exchange failed: ${res.ok ? 'no access_token in answer' : describeGraphError(res.error)}`,
      )
      throw new BadRequestException(
        errBody('whatsapp_es_code_rejected', 'Meta did not accept the signup code'),
      )
    }
    return res.data.access_token
  }

  /**
   * The browser told us which WABA and number were shared. Check both
   * against what the token can actually reach before storing anything, so a
   * valid code for one business cannot be paired with another business's ids.
   */
  private async confirmAssets(
    s: EmbeddedSignupSettings,
    token: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<{ display_phone_number?: string; verified_name?: string }> {
    const notGranted = (why: string) => {
      this.logger.warn(`embedded signup: waba ${wabaId} / phone ${phoneNumberId} not granted: ${why}`)
      return new ForbiddenException(
        errBody('whatsapp_es_waba_not_granted', 'The signup did not grant access to this WhatsApp account'),
      )
    }

    const debug = await graphCall<DebugToken>(s.graphBase, 'debug_token', {
      query: { input_token: token, access_token: `${s.appId}|${s.appSecret}` },
    })
    if (!debug.ok) throw notGranted(describeGraphError(debug.error))
    const d = debug.data.data
    if (!d?.is_valid || d.app_id !== s.appId) throw notGranted('token invalid or issued to another app')
    const management = d.granular_scopes?.find((g) => g.scope === 'whatsapp_business_management')
    if (!management) throw notGranted('no whatsapp_business_management scope')
    // No target_ids means the scope is not narrowed to particular assets.
    if (management.target_ids && !management.target_ids.includes(wabaId)) {
      throw notGranted('waba not among the granted assets')
    }

    const phones = await graphCall<PhoneNumbers>(s.graphBase, `${wabaId}/phone_numbers`, {
      token,
      query: { fields: 'id,display_phone_number,verified_name' },
    })
    if (!phones.ok) throw notGranted(describeGraphError(phones.error))
    const phone = phones.data.data?.find((p) => p.id === phoneNumberId)
    if (!phone) throw notGranted('phone number is not on this waba')
    return phone
  }

  private async step(
    s: EmbeddedSignupSettings,
    path: string,
    token: string,
    body: Record<string, unknown>,
    code: 'whatsapp_es_subscribe_failed' | 'whatsapp_es_register_failed',
  ): Promise<void> {
    const res = await graphCall<{ success?: boolean }>(s.graphBase, path, {
      method: 'POST',
      token,
      body,
    })
    if (!res.ok) throw this.metaStepFailed(code, describeGraphError(res.error))
    if (res.data.success === false) throw this.metaStepFailed(code, 'success=false')
  }

  private metaStepFailed(
    code: 'whatsapp_es_subscribe_failed' | 'whatsapp_es_register_failed',
    detail: string,
  ): BadGatewayException {
    this.logger.warn(`embedded signup: ${code}: ${detail}`)
    return new BadGatewayException(
      errBody(code, code === 'whatsapp_es_register_failed'
        ? 'Meta refused to register the phone number'
        : 'Meta refused the webhook subscription'),
    )
  }

  /**
   * Undo a half-finished onboarding. The inbox goes (nothing can reference it
   * yet), and the webhook routing we set is taken back, best effort: the
   * customer will most likely retry within a minute and a stale override
   * would send that retry's messages to a deleted inbox.
   */
  private async rollback(
    s: EmbeddedSignupSettings,
    inboxId: string,
    token: string,
    wabaId: string,
    phoneNumberId: string,
    routed: 'waba' | 'phone' | null,
  ): Promise<void> {
    await this.prisma.inbox.delete({ where: { id: inboxId } }).catch((err: unknown) => {
      this.logger.error(
        `embedded signup: could not delete inbox ${inboxId} after a failed onboarding: ${err instanceof Error ? err.name : 'unknown error'}`,
      )
    })
    if (routed === 'waba') {
      const res = await graphCall(s.graphBase, `${wabaId}/subscribed_apps`, { method: 'DELETE', token })
      if (!res.ok) this.logger.warn(`embedded signup: unsubscribe after failure: ${describeGraphError(res.error)}`)
    } else if (routed === 'phone') {
      const res = await graphCall(s.graphBase, phoneNumberId, {
        method: 'POST',
        token,
        body: { webhook_configuration: { override_callback_uri: '' } },
      })
      if (!res.ok) this.logger.warn(`embedded signup: clear phone override after failure: ${describeGraphError(res.error)}`)
    }
  }

  private async requireMembership(userId: string, accountId: string) {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return membership
  }
}
