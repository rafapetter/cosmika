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
  AccountMemberDTO,
  AccountWithMembers,
  ChangeMemberRoleInput,
  InviteMemberInput,
  UpdateAccountInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import {
  SessionContext,
  toAccountDTO,
  toMembershipDTO,
} from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'
import { errBody } from '../../common/app-error'

import { AccountsService } from './accounts.service'

@Controller('accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
  ): Promise<AccountWithMembers> {
    await this.accountsService.assertAdmin(auth.user.id, id)
    const account = await this.accountsService.getWithMembers(id)
    return {
      ...toAccountDTO(account),
      members: account.members.map((m) => toMembershipDTO(m)),
    }
  }

  // Lightweight member list for assignee pickers — any active member, not
  // just admins (agents need it to assign conversations).
  @Get(':id/members')
  async listMembers(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
  ): Promise<AccountMemberDTO[]> {
    const members = await this.accountsService.listMembers(auth.user.id, id)
    return members.map((m) => toMembershipDTO(m))
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAccountInput)) body: UpdateAccountInput,
  ) {
    await this.accountsService.assertAdmin(auth.user.id, id)
    const account = await this.accountsService.update(id, body)
    await this.audit.record({
      accountId: id,
      actorId: auth.user.id,
      action: 'account.update',
      target: `account:${id}`,
      metadata: body,
    })
    return toAccountDTO(account)
  }

  @Post(':id/members')
  async invite(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(InviteMemberInput)) body: InviteMemberInput,
  ): Promise<AccountMemberDTO> {
    await this.accountsService.assertAdmin(auth.user.id, id)
    const membership = await this.accountsService.inviteMember(id, body)
    await this.audit.record({
      accountId: id,
      actorId: auth.user.id,
      action: 'member.invite',
      target: `member:${membership.id}`,
      metadata: { email: body.email, role: body.role },
    })
    return toMembershipDTO(membership)
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.accountsService.assertAdmin(auth.user.id, id)
    if (userId === auth.user.id) {
      throw new BadRequestException(errBody('remove_self_via_leave', 'Use the leave-account flow to remove yourself'))
    }
    await this.accountsService.removeMember(id, userId)
    await this.audit.record({
      accountId: id,
      actorId: auth.user.id,
      action: 'member.remove',
      target: `user:${userId}`,
    })
  }

  @Patch(':id/members/:userId')
  async changeMemberRole(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(ChangeMemberRoleInput))
    body: ChangeMemberRoleInput,
  ): Promise<AccountMemberDTO> {
    await this.accountsService.assertAdmin(auth.user.id, id)
    const updated = await this.accountsService.changeMemberRoleWithUser(
      id,
      userId,
      body.role,
    )
    await this.audit.record({
      accountId: id,
      actorId: auth.user.id,
      action: 'member.role',
      target: `user:${userId}`,
      metadata: { role: body.role },
    })
    return toMembershipDTO(updated)
  }
}
