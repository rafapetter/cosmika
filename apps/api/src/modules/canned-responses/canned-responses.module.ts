import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { CannedResponsesController } from './canned-responses.controller'
import { CannedResponsesService } from './canned-responses.service'

@Module({
  imports: [AuthModule],
  controllers: [CannedResponsesController],
  providers: [CannedResponsesService],
  exports: [CannedResponsesService],
})
export class CannedResponsesModule {}
