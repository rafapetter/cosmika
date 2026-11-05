import { Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { WebhooksController } from './webhooks.controller'
import { WebhooksService } from './webhooks.service'
import { WebhooksWorker } from './webhooks.worker'

@Global()
@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhooksWorker],
  exports: [WebhooksService],
})
export class WebhooksModule {}
