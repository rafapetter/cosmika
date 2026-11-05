import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  AuditLogPage,
  ListAuditLogsQuery,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

import { AuditLogService } from './audit-log.service'

@Controller('accounts/:accountId/audit-logs')
@UseGuards(AuthGuard)
export class AuditLogController {
  constructor(
    private readonly svc: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListAuditLogsQuery))
    query: ListAuditLogsQuery,
  ): Promise<AuditLogPage> {
    await this.assertAdmin(auth.user.id, accountId)
    const { items, nextCursor } = await this.svc.list(accountId, query)
    return {
      items: items.map((i) => this.svc.toDTO(i)),
      nextCursor,
    }
  }

  private async assertAdmin(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    if (m.role !== 'ADMINISTRATOR' && m.role !== 'SUPERVISOR') {
      throw new ForbiddenException(errBody('insufficient_role', 'Insufficient role'))
    }
  }
}
