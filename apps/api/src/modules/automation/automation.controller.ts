import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  AutomationDryRunQuery,
  AutomationDryRunResult,
  AutomationRuleDTO,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { AutomationService } from './automation.service'

@Controller('accounts/:accountId/automation-rules')
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<AutomationRuleDTO[]> {
    const rules = await this.automation.list(auth.user.id, accountId)
    return rules.map((r) => this.automation.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateAutomationRuleInput))
    body: CreateAutomationRuleInput,
  ): Promise<AutomationRuleDTO> {
    const rule = await this.automation.create(auth.user.id, accountId, body)
    return this.automation.toDTO(rule)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<AutomationRuleDTO> {
    const rule = await this.automation.get(auth.user.id, accountId, id)
    return this.automation.toDTO(rule)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAutomationRuleInput))
    body: UpdateAutomationRuleInput,
  ): Promise<AutomationRuleDTO> {
    const rule = await this.automation.update(auth.user.id, accountId, id, body)
    return this.automation.toDTO(rule)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.automation.remove(auth.user.id, accountId, id)
  }

  @Get(':id/run-dry')
  async dryRun(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(AutomationDryRunQuery))
    query: AutomationDryRunQuery,
  ): Promise<AutomationDryRunResult> {
    return this.automation.dryRun(
      auth.user.id,
      accountId,
      id,
      query.conversationId,
    )
  }
}
