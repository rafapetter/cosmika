import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { AgentAvailabilityController } from './agent-availability.controller'
import { AgentAvailabilityService } from './agent-availability.service'

@Module({
  imports: [AuthModule],
  controllers: [AgentAvailabilityController],
  providers: [AgentAvailabilityService],
  exports: [AgentAvailabilityService],
})
export class AgentAvailabilityModule {}
