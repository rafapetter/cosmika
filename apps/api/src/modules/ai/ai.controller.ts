import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ConfirmToolCallsInput } from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { OrchestratorService } from './orchestrator.service'

@Controller('accounts/:accountId/conversations/:conversationId/ai')
@UseGuards(AuthGuard)
export class AiController {
  constructor(private readonly orchestrator: OrchestratorService) {}

  @Get()
  async get(
    @Auth() _auth: SessionContext,
    @Param('accountId') _accountId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.orchestrator.getSessionView(conversationId)
  }

  @Post('confirm-tool-calls')
  async confirm(
    @Auth() _auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('conversationId') conversationId: string,
    @Body(new ZodValidationPipe(ConfirmToolCallsInput))
    body: ConfirmToolCallsInput,
  ) {
    const calls = await this.orchestrator.confirmToolCalls({
      accountId,
      conversationId,
      toolCallIds: body.toolCallIds,
      decision: body.decision,
    })
    return calls.map((c) => this.orchestrator.toToolCallDTO(c))
  }
}
