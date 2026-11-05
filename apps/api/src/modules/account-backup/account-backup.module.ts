import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { AuditLogModule } from '../audit-log/audit-log.module'

import { AccountBackupController } from './account-backup.controller'
import { AccountBackupService } from './account-backup.service'
import { DataExportController, DataExportDownloadController } from './data-export.controller'
import { DataExportService } from './data-export.service'
import { ExportTicketsService } from './export-tickets.service'

@Module({
  imports: [AuthModule, AuditLogModule],
  controllers: [AccountBackupController, DataExportController, DataExportDownloadController],
  providers: [AccountBackupService, DataExportService, ExportTicketsService],
  exports: [AccountBackupService],
})
export class AccountBackupModule {}
