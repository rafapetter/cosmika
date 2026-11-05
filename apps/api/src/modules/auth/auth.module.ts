import { Module } from '@nestjs/common'

import { BillingModule } from '../billing/billing.module'
import { EmailModule } from '../email/email.module'

import { AuthController } from './auth.controller'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'

@Module({
  imports: [BillingModule, EmailModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
