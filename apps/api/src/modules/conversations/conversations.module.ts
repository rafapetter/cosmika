import { forwardRef, Module } from '@nestjs/common'
import { ActivityModule } from '../activity/activity.module'
import { WorkingHoursModule } from '../working-hours/working-hours.module'
import { AutoResolveService } from './auto-resolve.service'
import { AutoReplyService } from './auto-reply.service'

import { AuthModule } from '../auth/auth.module'
import { AiModule } from '../ai/ai.module'
import { AutomationModule } from '../automation/automation.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'
import { AttachmentsModule } from '../attachments/attachments.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { FlowsModule } from '../flows/flows.module'

import { ConversationsController } from './conversations.controller'
import { ConversationsService } from './conversations.service'

@Module({
  imports: [WorkingHoursModule, ActivityModule, 
    AuthModule,
    AiModule,
    AutomationModule,
    forwardRef(() => WhatsappModule),
    AttachmentsModule,
    NotificationsModule,
    forwardRef(() => FlowsModule),
  ],
  controllers: [ConversationsController],
  providers: [AutoReplyService, AutoResolveService, ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
