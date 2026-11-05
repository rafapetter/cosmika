import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { AuditLogModule } from '../audit-log/audit-log.module'

import { AccountProfileController } from './account-profile.controller'
import { AccountProfileService } from './account-profile.service'

@Module({
  imports: [AuthModule, AuditLogModule],
  controllers: [AccountProfileController],
  providers: [AccountProfileService],
  exports: [AccountProfileService],
})
export class AccountProfileModule {}
