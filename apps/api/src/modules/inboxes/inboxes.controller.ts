import {
  BadRequestException,
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
  AddInboxMemberInput,
  CreateInboxInput,
  InboxDTO,
  InboxMemberDTO,
  InboxWithMembersDTO,
  UpdateInboxInput,
  UpdateWhatsappCredentialsInput,
} from '@cosmika/shared'

import { errBody } from '../../common/app-error'
import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { InboxesService } from './inboxes.service'

@Controller('accounts/:accountId/inboxes')
@UseGuards(AuthGuard)
export class InboxesController {
  constructor(
    private readonly inboxes: InboxesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<InboxDTO[]> {
    const inboxes = await this.inboxes.list(auth.user.id, accountId)
    return inboxes.map((inbox) => this.inboxes.toInboxDTO(inbox))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateInboxInput)) body: CreateInboxInput,
  ): Promise<InboxDTO> {
    // A Telegram inbox is only useful once its webhook is registered, which
    // POST /inboxes/telegram does around the insert.
    if (body.channelType === 'TELEGRAM') {
      throw new BadRequestException(
        errBody('invalid_input', 'Create Telegram inboxes with POST /accounts/:accountId/inboxes/telegram'),
      )
    }
    const inbox = await this.inboxes.create(auth.user.id, accountId, body)
    return this.inboxes.toInboxDTO(inbox)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<InboxWithMembersDTO> {
    const inbox = await this.inboxes.getWithMembers(auth.user.id, accountId, id)
    return {
      ...this.inboxes.toInboxDTO(inbox),
      members: inbox.members.map((m) => this.inboxes.toInboxMemberDTO(m)),
    }
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateInboxInput)) body: UpdateInboxInput,
  ): Promise<InboxDTO> {
    const { inbox, whatsappCredentialsChanged } = await this.inboxes.update(
      auth.user.id,
      accountId,
      id,
      body,
    )
    // A credential replaced through this route is audited exactly like one
    // replaced through the dedicated route: same action, same target, field
    // names only.
    if (whatsappCredentialsChanged.length > 0) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'inbox.whatsapp_credentials.update',
        target: `inbox:${id}`,
        metadata: { fields: whatsappCredentialsChanged },
      })
    }
    return this.inboxes.toInboxDTO(inbox)
  }

  // Admin-only credential rotation for a WhatsApp channel. The response is
  // the same redacted DTO every other inbox endpoint returns, and the audit
  // entry names the fields that changed, never their values.
  @Patch(':id/whatsapp-credentials')
  async updateWhatsappCredentials(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWhatsappCredentialsInput))
    body: UpdateWhatsappCredentialsInput,
  ): Promise<InboxDTO> {
    const { inbox, changed } = await this.inboxes.updateWhatsappCredentials(
      auth.user.id,
      accountId,
      id,
      body,
    )
    if (changed.length > 0) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'inbox.whatsapp_credentials.update',
        target: `inbox:${id}`,
        metadata: { fields: changed },
      })
    }
    return this.inboxes.toInboxDTO(inbox)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.inboxes.remove(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'inbox.delete',
      target: `inbox:${id}`,
    })
  }

  @Post(':id/members')
  async addMember(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddInboxMemberInput)) body: AddInboxMemberInput,
  ): Promise<InboxMemberDTO> {
    const member = await this.inboxes.addMember(
      auth.user.id,
      accountId,
      id,
      body,
    )
    return this.inboxes.toInboxMemberDTO(member)
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('userId') memberUserId: string,
  ): Promise<void> {
    await this.inboxes.removeMember(auth.user.id, accountId, id, memberUserId)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'inbox.member.remove',
      target: `inbox:${id}`,
      metadata: { userId: memberUserId },
    })
  }
}
