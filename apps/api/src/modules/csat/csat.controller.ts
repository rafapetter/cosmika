import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  CsatPublicSurvey,
  CsatStats,
  CsatStatsQuery,
  NpsQuery,
  NpsStats,
  SubmitCsatInput,
  SurveySettingsDTO,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { CsatService } from './csat.service'
import { NpsService } from './nps.service'

/**
 * Public CSAT endpoints — no auth. Reachable by the contact via the survey
 * link sent on resolution. Token is the surface that protects this from
 * tampering (cuid, single-use).
 */
@Controller('csat')
export class CsatPublicController {
  constructor(private readonly svc: CsatService) {}

  // Survey URLs are bearer-equivalent: anyone holding the link can read the
  // account name + conversation number. The token is a cuid (infeasible to
  // guess) but the endpoint was unthrottled, so guessing was at least
  // unbounded. Same budget as submit (M3).
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async get(@Param('token') token: string): Promise<CsatPublicSurvey> {
    const survey = await this.svc.getByToken(token)
    return {
      type: survey.type,
      alreadyResponded: survey.respondedAt !== null,
      conversationDisplayId: survey.conversation.displayId,
      accountName: survey.account.name,
    }
  }

  @Post(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async submit(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(SubmitCsatInput)) body: SubmitCsatInput,
  ) {
    await this.svc.submitByToken(token, body)
    return { ok: true }
  }
}

/**
 * Authenticated stats endpoint — for the in-app CSAT report page.
 */
@Controller('accounts/:accountId/csat')
@UseGuards(AuthGuard)
export class CsatStatsController {
  constructor(
    private readonly svc: CsatService,
    private readonly nps: NpsService,
    private readonly audit: AuditLogService,
  ) {}

  /** Which survey (CSAT 1-5 or NPS 0-10) goes out on resolve. */
  @Get('settings')
  settings(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<SurveySettingsDTO> {
    return this.nps.getSettings(auth.user.id, accountId)
  }

  @Put('settings')
  async updateSettings(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(SurveySettingsDTO)) body: SurveySettingsDTO,
  ): Promise<SurveySettingsDTO> {
    const { surveyType, previous } = await this.nps.setSettings(auth.user.id, accountId, body.surveyType)
    if (previous !== surveyType) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'survey.type_changed',
        target: `account:${accountId}`,
        metadata: { from: previous, to: surveyType },
      })
    }
    return { surveyType }
  }

  @Get('nps')
  npsStats(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(NpsQuery)) query: NpsQuery,
  ): Promise<NpsStats> {
    return this.nps.stats(auth.user.id, accountId, query)
  }

  @Get('nps.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="nps.csv"')
  npsCsv(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(NpsQuery)) query: NpsQuery,
  ): Promise<string> {
    return this.nps.statsCsv(auth.user.id, accountId, query)
  }

  @Get('stats')
  async stats(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(CsatStatsQuery)) query: CsatStatsQuery,
  ): Promise<CsatStats> {
    return this.svc.stats(auth.user.id, accountId, query)
  }
}
