import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import type { WhatsappTemplateDTO } from '@cosmika/shared'

import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { WhatsappTemplatesService } from './whatsapp-templates.service'

@Controller('accounts/:accountId/inboxes/:inboxId/whatsapp-templates')
@UseGuards(AuthGuard)
export class WhatsappTemplatesController {
  constructor(private readonly templates: WhatsappTemplatesService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('inboxId') inboxId: string,
  ): Promise<WhatsappTemplateDTO[]> {
    const rows = await this.templates.list(auth.user.id, accountId, inboxId)
    return rows.map((t) => this.templates.toDTO(t))
  }

  @Post('sync')
  async sync(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('inboxId') inboxId: string,
  ): Promise<{ synced: number }> {
    return this.templates.sync(auth.user.id, accountId, inboxId)
  }
}
