import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common'
import {
  AccountProfileDTO,
  UpsertAccountProfileInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { AccountProfileService } from './account-profile.service'

@Controller('accounts/:accountId/profile')
@UseGuards(AuthGuard)
export class AccountProfileController {
  constructor(private readonly svc: AccountProfileService) {}

  @Get()
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<AccountProfileDTO | null> {
    return this.svc.get(auth.user.id, accountId)
  }

  @Put()
  async upsert(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(UpsertAccountProfileInput))
    body: UpsertAccountProfileInput,
  ): Promise<AccountProfileDTO> {
    return this.svc.upsert(auth.user.id, accountId, body)
  }
}
