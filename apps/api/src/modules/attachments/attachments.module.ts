import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import {
  AttachmentsController,
  AttachmentsFilesController,
} from './attachments.controller'
import { AttachmentsService } from './attachments.service'

@Module({
  imports: [AuthModule],
  controllers: [AttachmentsController, AttachmentsFilesController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
