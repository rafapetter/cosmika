import { Global, Module } from '@nestjs/common'

import { BillingService } from './billing.service'
import { OverageService } from './overage.service'
import { PlanSyncService } from './plan-sync.service'

// Global: controllers across every feature module apply `@UseGuards(AuthGuard)`
// directly, and Nest instantiates that guard in the HOST module's injector.
// Without @Global, each of those modules would have to import BillingModule
// or the app fails to boot ("can't resolve dependencies of the AuthGuard").
@Global()
@Module({
  providers: [BillingService, OverageService, PlanSyncService],
  exports: [BillingService, OverageService, PlanSyncService],
})
export class BillingModule {}
