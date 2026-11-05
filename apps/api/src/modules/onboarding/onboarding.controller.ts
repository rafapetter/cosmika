import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { errBody } from '../../common/app-error'

import { OnboardingService } from './onboarding.service'

@Controller('accounts/:accountId/onboarding')
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(
    private readonly svc: OnboardingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId: auth.user.id } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return this.svc.status(accountId)
  }
}
