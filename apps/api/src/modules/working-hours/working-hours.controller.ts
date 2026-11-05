import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common'
import {
  CreateHolidayInput,
  HolidayDTO,
  SetWorkingHoursInput,
  WorkingHourDTO,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { WorkingHoursService } from './working-hours.service'

@Controller('accounts/:accountId')
@UseGuards(AuthGuard)
export class WorkingHoursController {
  constructor(private readonly workingHours: WorkingHoursService) {}

  @Get('inboxes/:inboxId/working-hours')
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('inboxId') inboxId: string,
  ): Promise<WorkingHourDTO[]> {
    const rows = await this.workingHours.listForInbox(
      auth.user.id,
      accountId,
      inboxId,
    )
    return rows.map((w) => this.workingHours.toWorkingHourDTO(w))
  }

  @Put('inboxes/:inboxId/working-hours')
  async set(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('inboxId') inboxId: string,
    @Body(new ZodValidationPipe(SetWorkingHoursInput))
    body: SetWorkingHoursInput,
  ): Promise<WorkingHourDTO[]> {
    const rows = await this.workingHours.setForInbox(
      auth.user.id,
      accountId,
      inboxId,
      body,
    )
    return rows.map((w) => this.workingHours.toWorkingHourDTO(w))
  }

  @Get('holidays')
  async listHolidays(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<HolidayDTO[]> {
    const rows = await this.workingHours.listHolidays(auth.user.id, accountId)
    return rows.map((h) => this.workingHours.toHolidayDTO(h))
  }

  @Post('holidays')
  async createHoliday(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateHolidayInput)) body: CreateHolidayInput,
  ): Promise<HolidayDTO> {
    const h = await this.workingHours.createHoliday(auth.user.id, accountId, body)
    return this.workingHours.toHolidayDTO(h)
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  async deleteHoliday(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.workingHours.deleteHoliday(auth.user.id, accountId, id)
  }
}
