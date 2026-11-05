import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ListTicketsQuery,
  SupportTicketDTO,
  SupportTicketDetailDTO,
  UpdateTicketInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { SupportTicketsService } from './support-tickets.service'

/**
 * Read + triage surface for tickets raised by a flow's Ticket blocks. There's
 * deliberately no create endpoint: tickets come from a conversation, so making
 * one by hand would produce a record with no thread behind it.
 */
@Controller('accounts/:accountId/tickets')
@UseGuards(AuthGuard)
export class SupportTicketsController {
  constructor(
    private readonly svc: SupportTicketsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListTicketsQuery)) query: ListTicketsQuery,
  ): Promise<SupportTicketDTO[]> {
    await this.svc.assertMember(auth.user.id, accountId)
    const rows = await this.svc.listForAccount(accountId, query)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Get(':ticketId')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<SupportTicketDetailDTO> {
    await this.svc.assertMember(auth.user.id, accountId)
    const row = await this.svc.getForAccount(accountId, ticketId)
    if (!row) throw new NotFoundException()
    return {
      ...this.svc.toDTO(row),
      events: row.events.map((e) => ({
        id: e.id,
        body: e.body,
        createdAt: e.createdAt.toISOString(),
      })),
    }
  }

  @Patch(':ticketId')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(UpdateTicketInput)) body: UpdateTicketInput,
  ): Promise<SupportTicketDTO> {
    await this.svc.assertMutator(auth.user.id, accountId)
    const row = await this.svc.updateForAccount(accountId, ticketId, body)
    if (!row) throw new NotFoundException()
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'ticket.updated',
      target: `ticket:${row.id}`,
      metadata: { status: row.status, priority: row.priority },
    })
    return this.svc.toDTO(row)
  }
}
