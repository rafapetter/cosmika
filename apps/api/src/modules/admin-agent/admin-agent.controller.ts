import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  AdminAgentDecideInput,
  AdminAgentSendInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { errBody } from '../../common/app-error'

import { AdminAgentService } from './admin-agent.service'

/**
 * The admin assistant. Every route asserts Administrator inside the service —
 * checked per request, not once at session creation, because a role can be
 * revoked while a session is open.
 */
@Controller('accounts/:accountId/admin-agent')
@UseGuards(AuthGuard)
export class AdminAgentController {
  constructor(private readonly svc: AdminAgentService) {}

  @Get('sessions')
  async sessions(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ) {
    const rows = await this.svc.listSessions(auth.user.id, accountId)
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      lastActiveAt: r.lastActiveAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      totalCostUsd: Number(r.totalCostUsd),
    }))
  }

  @Get('sessions/:sessionId')
  async session(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('sessionId') sessionId: string,
  ) {
    const s = await this.svc.getSession(auth.user.id, accountId, sessionId)
    return {
      id: s.id,
      title: s.title,
      totalCostUsd: Number(s.totalCostUsd),
      transcript: s.transcript,
      toolCalls: s.toolCalls.map((c) => ({
        id: c.id,
        toolName: c.toolName,
        input: c.input,
        output: c.output,
        status: c.status,
        critical: c.critical,
        createdAt: c.createdAt.toISOString(),
      })),
    }
  }

  @Post('messages')
  async send(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(AdminAgentSendInput)) body: AdminAgentSendInput,
  ) {
    if (!body.message.trim() && (body.attachments ?? []).length === 0) {
      throw new BadRequestException(errBody('message_or_attachment_required', 'message or attachment required'))
    }
    return this.svc.send(auth.user.id, accountId, body)
  }

  @Post('sessions/:sessionId/decide')
  async decide(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(AdminAgentDecideInput)) body: AdminAgentDecideInput,
  ) {
    return this.svc.decide(auth.user.id, accountId, sessionId, body.decisions)
  }
}
