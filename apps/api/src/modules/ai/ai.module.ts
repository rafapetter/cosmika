import { Module, forwardRef } from '@nestjs/common'

import { ActivityModule } from '../activity/activity.module'
import { AuthModule } from '../auth/auth.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'

import { AgentBotsController } from './agent-bots.controller'
import { AgentBotsService } from './agent-bots.service'
import { AiController } from './ai.controller'
import { AiTools } from './ai-tools'
import { AnthropicClient } from './anthropic-client'
import { FlowAgentService } from './flow-agent.service'
import { OrchestratorService } from './orchestrator.service'

@Module({
  imports: [AuthModule, ActivityModule, forwardRef(() => WhatsappModule)],
  controllers: [AgentBotsController, AiController],
  providers: [AgentBotsService, AiTools, AnthropicClient, OrchestratorService, FlowAgentService],
  exports: [OrchestratorService, AgentBotsService, AnthropicClient, FlowAgentService],
})
export class AiModule {}
