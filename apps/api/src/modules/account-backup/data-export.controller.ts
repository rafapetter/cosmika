import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common'
import { DataExportKind, DataExportQuery } from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { DataExportService } from './data-export.service'
import { ExportTicket, ExportTicketsService } from './export-tickets.service'

/** Settings, Export data: contacts or conversations with their messages. */
@Controller('accounts/:accountId/exports')
@UseGuards(AuthGuard)
export class DataExportController {
  constructor(
    private readonly svc: DataExportService,
    private readonly tickets: ExportTicketsService,
    private readonly audit: AuditLogService,
  ) {}

  /** Direct download for API clients that can send the bearer header. */
  @Get(':kind')
  async download(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('kind', new ZodValidationPipe(DataExportKind)) kind: DataExportKind,
    @Query(new ZodValidationPipe(DataExportQuery)) query: DataExportQuery,
  ): Promise<StreamableFile> {
    const ticket = await this.authorise(auth, accountId, kind, query)
    return this.svc.file(ticket)
  }

  /** The web app's path: a one-time link the browser downloads to disk. */
  @Post(':kind/ticket')
  async ticket(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('kind', new ZodValidationPipe(DataExportKind)) kind: DataExportKind,
    @Query(new ZodValidationPipe(DataExportQuery)) query: DataExportQuery,
  ): Promise<{ url: string }> {
    const ticket = await this.authorise(auth, accountId, kind, query)
    return { url: `/exports/download/${await this.tickets.issue(ticket)}` }
  }

  private async authorise(
    auth: SessionContext,
    accountId: string,
    kind: DataExportKind,
    query: DataExportQuery,
  ): Promise<ExportTicket> {
    await this.svc.assertCanExport(auth.user.id, accountId)
    // Audited before a byte leaves, like the full backup: the record must
    // exist even if the download is abandoned halfway.
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'data.export',
      target: `account:${accountId}`,
      metadata: { kind, format: query.format, from: query.from ?? null, to: query.to ?? null },
    })
    return { accountId, userId: auth.user.id, kind, format: query.format, from: query.from, to: query.to }
  }
}

/** Redeems a ticket from DataExportController.ticket. No session: the ticket is the credential. */
@Controller('exports/download')
export class DataExportDownloadController {
  constructor(
    private readonly svc: DataExportService,
    private readonly tickets: ExportTicketsService,
  ) {}

  @Get(':ticket')
  async download(@Param('ticket') id: string): Promise<StreamableFile> {
    const ticket = await this.tickets.redeem(id)
    if (!ticket) throw new NotFoundException('Download link expired or already used')
    // The role could have changed in the two minutes since the ticket.
    await this.svc.assertCanExport(ticket.userId, ticket.accountId)
    return this.svc.file(ticket)
  }
}
