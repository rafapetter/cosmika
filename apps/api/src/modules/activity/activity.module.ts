import { Module } from '@nestjs/common'

import { RealtimeModule } from '../realtime/realtime.module'

import { ActivityService } from './activity.service'

@Module({
  imports: [RealtimeModule],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
