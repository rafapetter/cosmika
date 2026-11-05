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
  CreateLabelInput,
  LabelDTO,
  UpdateLabelInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { LabelsService } from './labels.service'

@Controller('accounts/:accountId/labels')
@UseGuards(AuthGuard)
export class LabelsController {
  constructor(private readonly svc: LabelsService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<LabelDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateLabelInput))
    body: CreateLabelInput,
  ): Promise<LabelDTO> {
    const r = await this.svc.create(auth.user.id, accountId, body)
    return this.svc.toDTO(r)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateLabelInput))
    body: UpdateLabelInput,
  ): Promise<LabelDTO> {
    const r = await this.svc.update(auth.user.id, accountId, id, body)
    return this.svc.toDTO(r)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.remove(auth.user.id, accountId, id)
  }
}

@Controller('accounts/:accountId/conversations/:conversationId/labels')
@UseGuards(AuthGuard)
export class ConversationLabelsController {
  constructor(private readonly svc: LabelsService) {}

  @Post(':labelId')
  @HttpCode(204)
  async apply(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('conversationId') conversationId: string,
    @Param('labelId') labelId: string,
  ): Promise<void> {
    await this.svc.applyToConversation(
      auth.user.id,
      accountId,
      conversationId,
      labelId,
    )
  }

  @Delete(':labelId')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('conversationId') conversationId: string,
    @Param('labelId') labelId: string,
  ): Promise<void> {
    await this.svc.removeFromConversation(
      auth.user.id,
      accountId,
      conversationId,
      labelId,
    )
  }
}
