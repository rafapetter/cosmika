import { Module } from '@nestjs/common'
import { ActivityModule } from '../activity/activity.module'

import { AuthModule } from '../auth/auth.module'

import {
  ConversationLabelsController,
  LabelsController,
} from './labels.controller'
import { LabelsService } from './labels.service'

@Module({
  imports: [ActivityModule, AuthModule],
  controllers: [LabelsController, ConversationLabelsController],
  providers: [LabelsService],
  exports: [LabelsService],
})
export class LabelsModule {}
