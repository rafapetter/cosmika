import { Module } from '@nestjs/common'

import { AuditLogModule } from '../audit-log/audit-log.module'
import { AuthModule } from '../auth/auth.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'

import { BroadcastsController } from './broadcasts.controller'
import { BroadcastsService } from './broadcasts.service'

@Module({
  imports: [AuthModule, WhatsappModule, AuditLogModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
