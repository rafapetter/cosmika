import { Module } from '@nestjs/common'

import { AttachmentsModule } from '../attachments/attachments.module'
import { AuthModule } from '../auth/auth.module'
import { InboxesModule } from '../inboxes/inboxes.module'

import { TelegramInboxesController, TelegramWebhookController } from './telegram.controller'
import { TelegramService } from './telegram.service'

@Module({
  imports: [AuthModule, AttachmentsModule, InboxesModule],
  controllers: [TelegramWebhookController, TelegramInboxesController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
