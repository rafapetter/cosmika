import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  BreakdownQuery,
  BreakdownResponse,
  LeaderboardQuery,
  LeaderboardResponse,
  OverviewQuery,
  OverviewResponse,
  TimeseriesQuery,
  TimeseriesResponse,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { ReportsService } from './reports.service'

@Controller('accounts/:accountId/reports')
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  async overview(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(OverviewQuery)) query: OverviewQuery,
  ): Promise<OverviewResponse> {
    return this.reports.overview(auth.user.id, accountId, query)
  }

  @Get('timeseries')
  async timeseries(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(TimeseriesQuery)) query: TimeseriesQuery,
  ): Promise<TimeseriesResponse> {
    return this.reports.timeseries(auth.user.id, accountId, query)
  }

  @Get('agent-leaderboard')
  async leaderboard(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(LeaderboardQuery)) query: LeaderboardQuery,
  ): Promise<LeaderboardResponse> {
    return this.reports.leaderboard(auth.user.id, accountId, query)
  }

  @Get('breakdown')
  async breakdown(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(BreakdownQuery)) query: BreakdownQuery,
  ): Promise<BreakdownResponse> {
    return this.reports.breakdown(auth.user.id, accountId, query)
  }

  @Get('breakdown.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="breakdown.csv"')
  async breakdownCsv(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(BreakdownQuery)) query: BreakdownQuery,
  ): Promise<string> {
    return this.reports.breakdownCsv(auth.user.id, accountId, query)
  }
}
