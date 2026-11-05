import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  AgentBotDTO,
  CreateAgentBotInput,
  UpdateAgentBotInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { AgentBotsService } from './agent-bots.service'

@Controller('accounts/:accountId/agent-bots')
@UseGuards(AuthGuard)
export class AgentBotsController {
  constructor(private readonly bots: AgentBotsService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<AgentBotDTO[]> {
    const rows = await this.bots.list(auth.user.id, accountId)
    return Promise.all(rows.map((b) => this.bots.toDTO(b)))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateAgentBotInput))
    body: CreateAgentBotInput,
  ): Promise<AgentBotDTO> {
    const bot = await this.bots.create(auth.user.id, accountId, body)
    return this.bots.toDTO(bot)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<AgentBotDTO> {
    const bot = await this.bots.get(auth.user.id, accountId, id)
    return this.bots.toDTO(bot)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAgentBotInput))
    body: UpdateAgentBotInput,
  ): Promise<AgentBotDTO> {
    const bot = await this.bots.update(auth.user.id, accountId, id, body)
    return this.bots.toDTO(bot)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.bots.remove(auth.user.id, accountId, id)
  }
}
