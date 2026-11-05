import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common'
import {
  AgentAvailabilityDTO,
  ReplaceAgentAvailabilityInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { AgentAvailabilityService } from './agent-availability.service'

@Controller('accounts/:accountId/agents/:memberId/availability')
@UseGuards(AuthGuard)
export class AgentAvailabilityController {
  constructor(private readonly svc: AgentAvailabilityService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('memberId') memberId: string,
  ): Promise<AgentAvailabilityDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId, memberId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Put()
  async replace(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(ReplaceAgentAvailabilityInput))
    body: ReplaceAgentAvailabilityInput,
  ): Promise<AgentAvailabilityDTO[]> {
    const rows = await this.svc.replace(
      auth.user.id,
      accountId,
      memberId,
      body.schedule,
    )
    return rows.map((r) => this.svc.toDTO(r))
  }
}
