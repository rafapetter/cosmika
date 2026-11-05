import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerModule } from '@nestjs/throttler'

import { MaybeThrottlerGuard } from './common/maybe-throttler.guard'

import { PrismaModule } from './prisma/prisma.module'
import { HealthModule } from './modules/health/health.module'
import { AuthModule } from './modules/auth/auth.module'
import { BillingModule } from './modules/billing/billing.module'
import { BillingStatusModule } from './modules/billing/billing-status.module'
import { AccountsModule } from './modules/accounts/accounts.module'
import { InboxesModule } from './modules/inboxes/inboxes.module'
import { ContactsModule } from './modules/contacts/contacts.module'
import { ConversationsModule } from './modules/conversations/conversations.module'
import { AiModule } from './modules/ai/ai.module'
import { WidgetModule } from './modules/widget/widget.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { TeamsModule } from './modules/teams/teams.module'
import { WorkingHoursModule } from './modules/working-hours/working-hours.module'
import { ReportsModule } from './modules/reports/reports.module'
import { AutomationModule } from './modules/automation/automation.module'
import { WhatsappModule } from './modules/whatsapp/whatsapp.module'
import { ChannelsModule } from './modules/channels/channels.module'
import { TelegramModule } from './modules/telegram/telegram.module'
import { MetaMessagingModule } from './modules/meta-messaging/meta-messaging.module'
import { BroadcastsModule } from './modules/broadcasts/broadcasts.module'
import { FlowsModule } from './modules/flows/flows.module'
import { AttachmentsModule } from './modules/attachments/attachments.module'
import { CannedResponsesModule } from './modules/canned-responses/canned-responses.module'
import { LabelsModule } from './modules/labels/labels.module'
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module'
import { AccountBackupModule } from './modules/account-backup/account-backup.module'
import { AdminAgentModule } from './modules/admin-agent/admin-agent.module'
import { NotificationsModule } from './modules/notifications/notifications.module'
import { OnboardingModule } from './modules/onboarding/onboarding.module'
import { AccountProfileModule } from './modules/account-profile/account-profile.module'
import { SavedViewsModule } from './modules/saved-views/saved-views.module'
import { CustomAttributesModule } from './modules/custom-attributes/custom-attributes.module'
import { AgentAvailabilityModule } from './modules/agent-availability/agent-availability.module'
import { AssignmentModule } from './modules/assignment/assignment.module'
import { AuditLogModule } from './modules/audit-log/audit-log.module'
import { WebhooksModule } from './modules/webhooks/webhooks.module'
import { CsatModule } from './modules/csat/csat.module'
import { RetentionModule } from './modules/retention/retention.module'
import { SlaModule } from './modules/sla/sla.module'
import { ArticlesModule } from './modules/articles/articles.module'
import { UsageModule } from './modules/usage/usage.module'
import { ApiKeysModule } from './modules/api-keys/api-keys.module'
import { PublicApiModule } from './modules/public-api/public-api.module'
import { SearchModule } from './modules/search/search.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Default throttle = 60 requests / 60s / IP across all endpoints. Specific
    // sensitive endpoints override this with stricter @Throttle({...}) decorators.
    // E2E suite runs >100 requests in a short window; disable when COSMIKA_DISABLE_THROTTLE=1.
    ThrottlerModule.forRoot(
      process.env.COSMIKA_DISABLE_THROTTLE === '1'
        ? [{ ttl: 60_000, limit: 100_000 }]
        : [{ ttl: 60_000, limit: 60 }],
    ),
    PrismaModule,
    HealthModule,
    AuthModule,
    BillingModule,
    BillingStatusModule,
    AccountsModule,
    InboxesModule,
    ContactsModule,
    ConversationsModule,
    AiModule,
    WidgetModule,
    RealtimeModule,
    TeamsModule,
    WorkingHoursModule,
    ReportsModule,
    AutomationModule,
    WhatsappModule,
    ChannelsModule,
    TelegramModule,
    MetaMessagingModule,
    BroadcastsModule,
    FlowsModule,
    AttachmentsModule,
    CannedResponsesModule,
    LabelsModule,
    SupportTicketsModule,
    AccountBackupModule,
    AdminAgentModule,
    NotificationsModule,
    OnboardingModule,
    AccountProfileModule,
    SavedViewsModule,
    AuditLogModule,
    WebhooksModule,
    CustomAttributesModule,
    AgentAvailabilityModule,
    AssignmentModule,
    CsatModule,
    RetentionModule,
    SlaModule,
    ArticlesModule,
    UsageModule,
    ApiKeysModule,
    PublicApiModule,
    SearchModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: MaybeThrottlerGuard }],
})
export class AppModule {}
