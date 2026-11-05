import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  ApiKeyDTO,
  ApiKeyWithSecret,
  CreateApiKeyInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { ApiKeysService } from './api-keys.service'
import { ApiKey, ApiKeyContext, PublicApiGuard } from './public-api.guard'

@Controller('accounts/:accountId/api-keys')
@UseGuards(AuthGuard)
export class ApiKeysController {
  constructor(
    private readonly svc: ApiKeysService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<ApiKeyDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId)
    return rows.map((r) => this.svc.toDTO(r))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateApiKeyInput)) body: CreateApiKeyInput,
  ): Promise<ApiKeyWithSecret> {
    const { row, token } = await this.svc.create(
      auth.user.id,
      accountId,
      body.name,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'api_key.create',
      target: `api_key:${row.id}`,
      metadata: { name: row.name, prefix: row.prefix },
    })
    return { ...this.svc.toDTO(row), secret: token }
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.revoke(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'api_key.revoke',
      target: `api_key:${id}`,
    })
  }
}

/**
 * Programmatic public API. All endpoints under /api/v1/ require an API key.
 * Whoami is the canonical "is this key valid?" probe.
 */
// Two prefixes: behind Caddy `/api/*` is stripped, so the public URL
// app.cosmobots.io/api/v1/... arrives here as /v1/...; direct calls to the
// API port (and keys already handed out) keep using /api/v1/....
@Controller(['api/v1', 'v1'])
@UseGuards(PublicApiGuard)
export class PublicApiController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('whoami')
  async whoami(@ApiKey() ctx: ApiKeyContext) {
    const account = await this.prisma.account.findUnique({
      where: { id: ctx.accountId },
      select: { id: true, slug: true, name: true, plan: true, status: true },
    })
    return { account }
  }
}
