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
  CannedResponseDTO,
  CreateCannedResponseInput,
  UpdateCannedResponseInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { CannedResponsesService } from './canned-responses.service'

@Controller('accounts/:accountId/canned-responses')
@UseGuards(AuthGuard)
export class CannedResponsesController {
  constructor(private readonly svc: CannedResponsesService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<CannedResponseDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateCannedResponseInput))
    body: CreateCannedResponseInput,
  ): Promise<CannedResponseDTO> {
    const r = await this.svc.create(auth.user.id, accountId, body)
    return this.svc.toDTO(r)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCannedResponseInput))
    body: UpdateCannedResponseInput,
  ): Promise<CannedResponseDTO> {
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
