import { Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { EmailModule } from '../email/email.module'

import { AiAllowanceService } from './ai-allowance.service'
import { AiUsageService } from './ai-usage.service'
import { UsageAlertsService } from './usage-alerts.service'
import { UsageController } from './usage.controller'
import { UsageService } from './usage.service'

// Global, and deliberately so. Measurement is read and written from the
// orchestrator, the flow runner, the admin assistant, conversations, contacts
// and the month-end billing run — wiring an import into each of those, in
// both directions, is how you get a circular module graph that fails to boot.
// The AI ledger lives here rather than under modules/ai for the same reason:
// the gate that reads it and the meters that report it are usage concerns.
@Global()
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [UsageController],
  providers: [
    UsageService,
    AiUsageService,
    AiAllowanceService,
    UsageAlertsService,
  ],
  exports: [UsageService, AiUsageService, AiAllowanceService, UsageAlertsService],
})
export class UsageModule {}
