import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'

import { WhatsappService } from './whatsapp.service'

type WebhookRequest = {
  headers: Record<string, string | string[] | undefined>
  rawBody?: Buffer
}

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get(':inboxId')
  async verify(
    @Param('inboxId') inboxId: string,
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): Promise<string> {
    return this.whatsapp.verifyChallenge(inboxId, mode, token, challenge)
  }

  @Post(':inboxId')
  @HttpCode(200)
  async event(
    @Param('inboxId') inboxId: string,
    @Req() req: WebhookRequest,
    @Body() body: unknown,
  ): Promise<{ processed: number }> {
    const sigHeader = req.headers['x-hub-signature-256']
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    // Nest sets `req.rawBody` automatically when `rawBody: true` is set on
    // NestFactory.create (see main.ts).
    const rawBody = req.rawBody ?? Buffer.alloc(0)
    return this.whatsapp.ingestWebhook(
      inboxId,
      rawBody,
      signature,
      body as Parameters<typeof this.whatsapp.ingestWebhook>[3],
    )
  }
}
