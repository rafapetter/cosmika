import { Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { WebhooksModule } from '../webhooks/webhooks.module'

import { SlaController, SlaReportsController } from './sla.controller'
import { SlaService } from './sla.service'

@Global()
@Module({
  imports: [AuthModule, WebhooksModule, NotificationsModule],
  controllers: [SlaController, SlaReportsController],
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
