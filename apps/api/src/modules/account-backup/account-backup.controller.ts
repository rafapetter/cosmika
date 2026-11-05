import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common'

import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { AccountBackupService, BackupCounts } from './account-backup.service'

/**
 * Minimal shape of the raw Node response we need. Typed locally for the same
 * reason attachments.controller.ts does it: avoids dragging Fastify's types
 * into a file that only writes bytes.
 */
type RawReply = {
  setHeader: (k: string, v: string) => void
  write: (chunk: string) => boolean
  end: () => void
}
type FastifyReply = { raw: RawReply }

@Controller('accounts/:accountId/backup')
@UseGuards(AuthGuard)
export class AccountBackupController {
  constructor(
    private readonly svc: AccountBackupService,
    private readonly audit: AuditLogService,
  ) {}

  /** Row counts without exporting anything — cheap enough to poll before a download. */
  @Get('counts')
  async counts(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<BackupCounts> {
    await this.svc.assertAdmin(auth.user.id, accountId)
    return this.svc.counts(accountId)
  }

  /**
   * Stream the whole account as NDJSON.
   *
   * Written straight to the raw response rather than returned: the largest
   * account here is ~370k messages, and buffering that into a single body
   * would blow memory before the first byte shipped.
   */
  @Get()
  async download(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    await this.svc.assertAdmin(auth.user.id, accountId)
    const generatedAt = new Date().toISOString()

    // Audited before a byte leaves: an export is every message every customer
    // ever sent, so the record must exist even if the download is abandoned.
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'account.backup_downloaded',
      target: `account:${accountId}`,
      metadata: { generatedAt },
    })

    res.raw.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
    res.raw.setHeader(
      'content-disposition',
      `attachment; filename="cosmika-backup-${accountId}-${generatedAt.slice(0, 10)}.ndjson"`,
    )
    for await (const chunk of this.svc.stream(accountId, generatedAt)) {
      res.raw.write(chunk)
    }
    res.raw.end()
  }
}
