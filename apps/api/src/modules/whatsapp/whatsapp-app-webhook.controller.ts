import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common'

import { type AppWebhookPayload, WhatsappAppWebhookService } from './whatsapp-app-webhook.service'

type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer
}

// Our app's default callback for the WhatsApp Business Account object (App
// Dashboard > WhatsApp > Configuration). Separate from the per-inbox route
// /webhooks/whatsapp/:inboxId, which keeps serving every existing channel
// exactly as before.
@Controller('webhooks/whatsapp-app')
export class WhatsappAppWebhookController {
  constructor(private readonly appWebhook: WhatsappAppWebhookService) {}

  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    return this.appWebhook.verifyChallenge(mode, token, challenge)
  }

  @Post()
  @HttpCode(200)
  async event(
    @Req() req: WebhookRequest,
    @Body() body: unknown,
  ): Promise<{ processed: number; ignored: number }> {
    const sigHeader = req.headers['x-hub-signature-256']
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    return this.appWebhook.ingest(
      req.rawBody ?? Buffer.alloc(0),
      signature,
      (body ?? {}) as AppWebhookPayload,
    )
  }
}
