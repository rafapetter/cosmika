import { Module } from '@nestjs/common'

import { AiModule } from '../ai/ai.module'
import { FlowsModule } from '../flows/flows.module'

import { WidgetController } from './widget.controller'
import { WidgetService } from './widget.service'

@Module({
  imports: [AiModule, FlowsModule],
  controllers: [WidgetController],
  providers: [WidgetService],
})
export class WidgetModule {}
