import { Module } from '@nestjs/common'

import { AttachmentsModule } from '../attachments/attachments.module'
import { AuthModule } from '../auth/auth.module'
import { InboxesModule } from '../inboxes/inboxes.module'

import { MetaInboxesController, MetaWebhookController } from './meta-messaging.controller'
import { MetaMessagingService } from './meta-messaging.service'

@Module({
  imports: [AuthModule, AttachmentsModule, InboxesModule],
  controllers: [MetaWebhookController, MetaInboxesController],
  providers: [MetaMessagingService],
  exports: [MetaMessagingService],
})
export class MetaMessagingModule {}
