import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { BillingStatusController } from './billing-status.controller'

// Separate from BillingModule: that one is @Global and imported by the auth
// guard's host modules, while this controller needs AuthModule itself.
@Module({
  imports: [AuthModule],
  controllers: [BillingStatusController],
})
export class BillingStatusModule {}
