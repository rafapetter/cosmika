import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CreateMetaInboxesInput } from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import type { SessionContext } from '../auth/auth.service'
import { InboxesService } from '../inboxes/inboxes.service'

import { MetaMessagingService, type MetaWebhookPayload } from './meta-messaging.service'

type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer
}

const header = (req: WebhookRequest, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * Public: the callback for the app's `page` (Messenger) and `instagram`
 * objects. One URL for both; events are routed by Page or Instagram id.
 */
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly meta: MetaMessagingService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    return this.meta.verifyChallenge(mode, token, challenge)
  }

  @Post()
  @HttpCode(200)
  async event(@Req() req: WebhookRequest, @Body() body: unknown) {
    return this.meta.ingestWebhook(
      req.rawBody ?? Buffer.alloc(0),
      { sha256: header(req, 'x-hub-signature-256'), sha1: header(req, 'x-hub-signature') },
      (body ?? {}) as MetaWebhookPayload,
    )
  }
}

/** Connect a Facebook Page: Messenger, its Instagram Direct, or both. */
@Controller('accounts/:accountId/inboxes/meta')
@UseGuards(AuthGuard)
export class MetaInboxesController {
  constructor(
    private readonly meta: MetaMessagingService,
    private readonly inboxes: InboxesService,
  ) {}

  @Post()
  async connect(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateMetaInboxesInput)) body: CreateMetaInboxesInput,
  ) {
    const created = await this.meta.connectPage(auth.user.id, accountId, body)
    return created.map((inbox) => this.inboxes.toInboxDTO(inbox))
  }
}
