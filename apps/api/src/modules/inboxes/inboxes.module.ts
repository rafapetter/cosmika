import { Module } from '@nestjs/common'

import { ChannelSecretsBootCheck } from '../../common/channel-secrets.service'
import { AuthModule } from '../auth/auth.module'

import { InboxesController } from './inboxes.controller'
import { InboxesService } from './inboxes.service'

@Module({
  imports: [AuthModule],
  controllers: [InboxesController],
  // ChannelSecretsBootCheck has no consumers: it exists to run its
  // onApplicationBootstrap hook. It lives in this module because channel
  // credentials are what it checks.
  providers: [InboxesService, ChannelSecretsBootCheck],
  exports: [InboxesService],
})
export class InboxesModule {}
