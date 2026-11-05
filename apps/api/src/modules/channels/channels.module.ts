import { forwardRef, Global, Module } from '@nestjs/common'

import { AttachmentsModule } from '../attachments/attachments.module'
import { ConversationsModule } from '../conversations/conversations.module'
import { MetaMessagingModule } from '../meta-messaging/meta-messaging.module'
import { TelegramModule } from '../telegram/telegram.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'

import { ChannelInboundService } from './channel-inbound.service'
import { ChannelsService } from './channels.service'

// Global: conversations, flows, AI, auto-reply and CSAT all push through it,
// and each of those modules already sits in a forwardRef cycle with WhatsApp.
@Global()
@Module({
  imports: [
    AttachmentsModule,
    forwardRef(() => WhatsappModule),
    forwardRef(() => ConversationsModule),
    forwardRef(() => TelegramModule),
    forwardRef(() => MetaMessagingModule),
  ],
  providers: [ChannelsService, ChannelInboundService],
  exports: [ChannelsService, ChannelInboundService],
})
export class ChannelsModule {}
