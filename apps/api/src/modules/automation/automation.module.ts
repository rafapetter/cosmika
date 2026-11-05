import { Module, forwardRef } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'
import { WorkingHoursModule } from '../working-hours/working-hours.module'

import { AutomationController } from './automation.controller'
import { AutomationEngine } from './automation.engine'
import { AutomationService } from './automation.service'

@Module({
  imports: [AuthModule, WorkingHoursModule, forwardRef(() => WhatsappModule)],
  controllers: [AutomationController],
  providers: [AutomationService, AutomationEngine],
  exports: [AutomationEngine, AutomationService],
})
export class AutomationModule {}
