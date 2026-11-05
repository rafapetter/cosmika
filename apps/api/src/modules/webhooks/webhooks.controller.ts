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
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDTO,
  WebhookDeliveryDTO,
  WebhookWithSecret,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { WebhooksService } from './webhooks.service'

@Controller('accounts/:accountId/webhooks')
@UseGuards(AuthGuard)
export class WebhooksController {
  constructor(
    private readonly svc: WebhooksService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<WebhookDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateWebhookInput)) body: CreateWebhookInput,
  ): Promise<WebhookWithSecret> {
    const wh = await this.svc.create(auth.user.id, accountId, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'webhook.create',
      target: `webhook:${wh.id}`,
      metadata: { url: wh.url, events: wh.events },
    })
    return this.svc.toDTOWithSecret(wh)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWebhookInput)) body: UpdateWebhookInput,
  ): Promise<WebhookDTO> {
    const wh = await this.svc.update(auth.user.id, accountId, id, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'webhook.update',
      target: `webhook:${wh.id}`,
      metadata: body,
    })
    return this.svc.toDTO(wh)
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
      action: 'webhook.delete',
      target: `webhook:${id}`,
    })
  }

  @Get(':id/deliveries')
  async deliveries(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<WebhookDeliveryDTO[]> {
    const rows = await this.svc.listDeliveries(auth.user.id, accountId, id)
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      event: r.event,
      status: r.status,
      responseStatus: r.responseStatus,
      errorMessage: r.errorMessage,
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(204)
  async retryDelivery(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<void> {
    await this.svc.retryDelivery(auth.user.id, accountId, id, deliveryId)
  }
}
