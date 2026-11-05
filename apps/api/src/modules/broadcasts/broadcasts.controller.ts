import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import type {
  BroadcastAudiencePreview,
  BroadcastDTO,
} from '@cosmika/shared'
import { CreateBroadcastInput, PreviewAudienceInput } from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { BroadcastsService } from './broadcasts.service'

@Controller('accounts/:accountId/broadcasts')
@UseGuards(AuthGuard)
export class BroadcastsController {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<BroadcastDTO[]> {
    const rows = await this.broadcasts.list(auth.user.id, accountId)
    return rows.map((b) => this.broadcasts.toDTO(b))
  }

  @Post('preview-audience')
  async preview(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(PreviewAudienceInput))
    body: PreviewAudienceInput,
  ): Promise<BroadcastAudiencePreview> {
    return this.broadcasts.previewAudience(
      auth.user.id,
      accountId,
      body.inboxId,
      body.audience,
    )
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateBroadcastInput))
    body: CreateBroadcastInput,
  ): Promise<BroadcastDTO> {
    const b = await this.broadcasts.create(auth.user.id, accountId, body)
    return this.broadcasts.toDTO(b)
  }

  @Post(':id/send')
  async send(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<BroadcastDTO> {
    const b = await this.broadcasts.send(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'broadcast.send',
      target: `broadcast:${id}`,
      metadata: { sent: b.sentCount, failed: b.failedCount },
    })
    return this.broadcasts.toDTO(b)
  }
}
