import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  CreateSlaPolicyInput,
  SlaMissDTO,
  SlaMissesQuery,
  SlaPolicyDTO,
  UpdateSlaPolicyInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { SlaService } from './sla.service'

@Controller('accounts/:accountId/sla-policies')
@UseGuards(AuthGuard)
export class SlaController {
  constructor(
    private readonly svc: SlaService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<SlaPolicyDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateSlaPolicyInput))
    body: CreateSlaPolicyInput,
  ): Promise<SlaPolicyDTO> {
    const row = await this.svc.create(auth.user.id, accountId, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'sla_policy.create',
      target: `sla_policy:${row.id}`,
      metadata: { name: row.name },
    })
    return this.svc.toDTO(row)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSlaPolicyInput))
    body: UpdateSlaPolicyInput,
  ): Promise<SlaPolicyDTO> {
    const row = await this.svc.update(auth.user.id, accountId, id, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'sla_policy.update',
      target: `sla_policy:${row.id}`,
      metadata: body,
    })
    return this.svc.toDTO(row)
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
      action: 'sla_policy.delete',
      target: `sla_policy:${id}`,
    })
  }
}

/** The missed-conversations report (pilot, item 11). */
@Controller('accounts/:accountId/sla')
@UseGuards(AuthGuard)
export class SlaReportsController {
  constructor(private readonly svc: SlaService) {}

  @Get('misses')
  misses(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(SlaMissesQuery)) query: SlaMissesQuery,
  ): Promise<SlaMissDTO[]> {
    return this.svc.misses(auth.user.id, accountId, query)
  }

  @Get('misses.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="atendimentos-perdidos.csv"')
  async missesCsv(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(SlaMissesQuery)) query: SlaMissesQuery,
  ): Promise<string> {
    return this.svc.missesCsv(await this.svc.misses(auth.user.id, accountId, query))
  }
}
