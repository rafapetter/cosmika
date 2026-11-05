import { Module, forwardRef } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'
import { AiModule } from '../ai/ai.module'
import { EmailModule } from '../email/email.module'
import { SupportTicketsModule } from '../support-tickets/support-tickets.module'

import { FlowsController } from './flows.controller'
import { FlowsService } from './flows.service'
import { FlowRunnerService } from './flow-runner.service'

@Module({
  imports: [
    AuthModule,
    RealtimeModule,
    AiModule,
    EmailModule,
    SupportTicketsModule,
    forwardRef(() => WhatsappModule),
  ],
  controllers: [FlowsController],
  providers: [FlowsService, FlowRunnerService],
  exports: [FlowsService, FlowRunnerService],
})
export class FlowsModule {}
