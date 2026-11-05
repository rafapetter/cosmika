import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { CreateInboxInput } from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { PrismaService } from '../../prisma/prisma.service'
import { Auth, AuthGuard } from '../auth/auth.guard'
import type { SessionContext } from '../auth/auth.service'
import { InboxesService } from '../inboxes/inboxes.service'

import { TelegramService, type TgUpdate } from './telegram.service'

/** Public: Telegram calls this for every update to a connected bot. */
@Controller('webhooks/telegram')
export class TelegramWebhookController {
  constructor(private readonly telegram: TelegramService) {}

  @Post(':inboxId')
  @HttpCode(200)
  async receive(
    @Param('inboxId') inboxId: string,
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: TgUpdate,
  ): Promise<{ ok: true }> {
    await this.telegram.ingestWebhook(inboxId, secret, update)
    return { ok: true }
  }
}

/**
 * Creating a Telegram inbox needs two calls to Telegram around the insert:
 * check the token before anything is stored, then point the bot's webhook at
 * the new inbox. A webhook Telegram refuses leaves no half-made inbox behind.
 */
@Controller('accounts/:accountId/inboxes/telegram')
@UseGuards(AuthGuard)
export class TelegramInboxesController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly inboxes: InboxesService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateInboxInput)) body: CreateInboxInput,
  ) {
    if (body.channelType !== 'TELEGRAM') {
      throw new BadRequestException(errBody('invalid_input', 'channelType must be TELEGRAM'))
    }
    const bot = await this.telegram.verifyToken(body.channelConfig.botToken)
    const inbox = await this.inboxes.create(auth.user.id, accountId, body)
    const publicApiUrl = process.env.API_PUBLIC_URL ?? 'http://localhost:3110'
    try {
      const connected = await this.telegram.connect(inbox, bot, publicApiUrl)
      return this.inboxes.toInboxDTO(connected)
    } catch (err) {
      await this.prisma.inbox.delete({ where: { id: inbox.id } }).catch(() => undefined)
      throw err
    }
  }
}
