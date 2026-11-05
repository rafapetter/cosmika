import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { WorkingHoursController } from './working-hours.controller'
import { WorkingHoursService } from './working-hours.service'

@Module({
  imports: [AuthModule],
  controllers: [WorkingHoursController],
  providers: [WorkingHoursService],
  exports: [WorkingHoursService],
})
export class WorkingHoursModule {}
