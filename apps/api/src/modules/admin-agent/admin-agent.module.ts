import { Module } from '@nestjs/common'

import { AccountsModule } from '../accounts/accounts.module'
import { AiModule } from '../ai/ai.module'
import { ArticlesModule } from '../articles/articles.module'
import { AuditLogModule } from '../audit-log/audit-log.module'
import { AuthModule } from '../auth/auth.module'
import { AutomationModule } from '../automation/automation.module'
import { BroadcastsModule } from '../broadcasts/broadcasts.module'
import { CannedResponsesModule } from '../canned-responses/canned-responses.module'
import { ConversationsModule } from '../conversations/conversations.module'
import { InboxesModule } from '../inboxes/inboxes.module'
import { LabelsModule } from '../labels/labels.module'
import { SlaModule } from '../sla/sla.module'
import { SupportTicketsModule } from '../support-tickets/support-tickets.module'
import { TeamsModule } from '../teams/teams.module'
import { WorkingHoursModule } from '../working-hours/working-hours.module'

import { AdminAgentController } from './admin-agent.controller'
import { AdminAgentService } from './admin-agent.service'
import { AdminAgentAccountTools } from './admin-agent-account-tools'
import { AdminAgentTools } from './admin-agent-tools'

@Module({
  imports: [
    AuthModule,
    AiModule,
    AuditLogModule,
    // The account tools call the settings screens' own services.
    AccountsModule,
    ArticlesModule,
    AutomationModule,
    BroadcastsModule,
    CannedResponsesModule,
    ConversationsModule,
    InboxesModule,
    LabelsModule,
    SlaModule,
    SupportTicketsModule,
    TeamsModule,
    WorkingHoursModule,
  ],
  controllers: [AdminAgentController],
  providers: [AdminAgentService, AdminAgentTools, AdminAgentAccountTools],
  exports: [AdminAgentService],
})
export class AdminAgentModule {}
