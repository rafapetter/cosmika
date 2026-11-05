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
  CreateCustomAttributeInput,
  CustomAttributeDTO,
  CustomAttributeTarget,
  UpdateCustomAttributeInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { CustomAttributesService } from './custom-attributes.service'

@Controller('accounts/:accountId/custom-attributes')
@UseGuards(AuthGuard)
export class CustomAttributesController {
  constructor(
    private readonly svc: CustomAttributesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query('target') target?: string,
  ): Promise<CustomAttributeDTO[]> {
    const parsedTarget =
      target && CustomAttributeTarget.safeParse(target).success
        ? (target as CustomAttributeTarget)
        : undefined
    const rows = await this.svc.list(auth.user.id, accountId, parsedTarget)
    return rows.map((r) => this.svc.toDTO(r) as CustomAttributeDTO)
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateCustomAttributeInput))
    body: CreateCustomAttributeInput,
  ): Promise<CustomAttributeDTO> {
    const row = await this.svc.create(auth.user.id, accountId, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'custom_attribute.create',
      target: `custom_attribute:${row.id}`,
      metadata: { key: row.key, target: row.target, type: row.type },
    })
    return this.svc.toDTO(row) as CustomAttributeDTO
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCustomAttributeInput))
    body: UpdateCustomAttributeInput,
  ): Promise<CustomAttributeDTO> {
    const row = await this.svc.update(auth.user.id, accountId, id, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'custom_attribute.update',
      target: `custom_attribute:${row.id}`,
      metadata: body,
    })
    return this.svc.toDTO(row) as CustomAttributeDTO
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.remove(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'custom_attribute.delete',
      target: `custom_attribute:${id}`,
    })
  }
}
