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
  CreateFlowInput,
  FlowDTO,
  FlowPublishResultDTO,
  type FlowPreviewResultDTO,
  FlowPreviewInput,
  FlowSummaryDTO,
  UpdateFlowInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { FlowsService } from './flows.service'

@Controller('accounts/:accountId/flows')
@UseGuards(AuthGuard)
export class FlowsController {
  constructor(private readonly flows: FlowsService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<FlowSummaryDTO[]> {
    const rows = await this.flows.list(auth.user.id, accountId)
    return rows.map((f) => this.flows.toSummaryDTO(f))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateFlowInput)) body: CreateFlowInput,
  ): Promise<FlowDTO> {
    const flow = await this.flows.create(auth.user.id, accountId, body)
    return this.flows.toDTO(flow)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<FlowDTO> {
    const flow = await this.flows.get(auth.user.id, accountId, id)
    return this.flows.toDTO(flow)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateFlowInput)) body: UpdateFlowInput,
  ): Promise<FlowDTO> {
    const flow = await this.flows.update(auth.user.id, accountId, id, body)
    return this.flows.toDTO(flow)
  }

  @Post(':id/preview')
  async preview(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(FlowPreviewInput)) body: FlowPreviewInput,
  ): Promise<FlowPreviewResultDTO> {
    const result = await this.flows.preview(auth.user.id, accountId, id, body)
    return result as unknown as FlowPreviewResultDTO
  }

  @Post(':id/publish')
  async publish(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<FlowPublishResultDTO> {
    const { flow, checks } = await this.flows.publish(auth.user.id, accountId, id)
    return { flow: this.flows.toDTO(flow), checks }
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.flows.archive(auth.user.id, accountId, id)
  }
}
