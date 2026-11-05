import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { AuditLogModule } from '../audit-log/audit-log.module'

import { SupportTicketsController } from './support-tickets.controller'
import { SupportTicketsService } from './support-tickets.service'

@Module({
  imports: [AuthModule, AuditLogModule],
  controllers: [SupportTicketsController],
  providers: [SupportTicketsService],
  exports: [SupportTicketsService],
})
export class SupportTicketsModule {}
