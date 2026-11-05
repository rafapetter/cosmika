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
  CreateSavedViewInput,
  SavedViewDTO,
  SavedViewEntity,
  UpdateSavedViewInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { SavedViewsService } from './saved-views.service'

@Controller('accounts/:accountId/saved-views')
@UseGuards(AuthGuard)
export class SavedViewsController {
  constructor(private readonly svc: SavedViewsService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query('entity', new ZodValidationPipe(SavedViewEntity.optional()))
    entity?: SavedViewEntity,
  ): Promise<SavedViewDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId, entity)
    return rows.map((r) => this.svc.toDTO(r) as SavedViewDTO)
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateSavedViewInput))
    body: CreateSavedViewInput,
  ): Promise<SavedViewDTO> {
    const r = await this.svc.create(auth.user.id, accountId, body)
    return this.svc.toDTO(r) as SavedViewDTO
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSavedViewInput))
    body: UpdateSavedViewInput,
  ): Promise<SavedViewDTO> {
    const r = await this.svc.update(auth.user.id, accountId, id, body)
    return this.svc.toDTO(r) as SavedViewDTO
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
