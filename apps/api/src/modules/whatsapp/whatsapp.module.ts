import { forwardRef, Module } from '@nestjs/common'

import { AttachmentsModule } from '../attachments/attachments.module'
import { AuthModule } from '../auth/auth.module'
import { ConversationsModule } from '../conversations/conversations.module'
import { InboxesModule } from '../inboxes/inboxes.module'

import { WhatsappController } from './whatsapp.controller'
import { WhatsappService } from './whatsapp.service'
import { WhatsappAppWebhookController } from './whatsapp-app-webhook.controller'
import { WhatsappAppWebhookService } from './whatsapp-app-webhook.service'
import { WhatsappEmbeddedSignupController } from './whatsapp-embedded-signup.controller'
import { WhatsappEmbeddedSignupService } from './whatsapp-embedded-signup.service'
import { WhatsappTemplatesController } from './whatsapp-templates.controller'
import { WhatsappTemplatesService } from './whatsapp-templates.service'

@Module({
  imports: [
    AttachmentsModule,
    AuthModule,
    InboxesModule,
    forwardRef(() => ConversationsModule),
  ],
  controllers: [
    WhatsappController,
    WhatsappTemplatesController,
    WhatsappEmbeddedSignupController,
    WhatsappAppWebhookController,
  ],
  providers: [
    WhatsappService,
    WhatsappTemplatesService,
    WhatsappEmbeddedSignupService,
    WhatsappAppWebhookService,
  ],
  exports: [WhatsappService, WhatsappTemplatesService],
})
export class WhatsappModule {}
