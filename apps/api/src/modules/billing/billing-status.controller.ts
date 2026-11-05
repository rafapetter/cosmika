import { Controller, Get, UseGuards } from '@nestjs/common'
import type { BillingStatusDTO } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { BillingService } from './billing.service'

// Lives under /billing, which the auth guard never blocks for billing reasons:
// this is what the "subscription ended" screen reads to offer a way to pay.
@Controller('billing')
@UseGuards(AuthGuard)
export class BillingStatusController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  async status(@Auth() auth: SessionContext): Promise<BillingStatusDTO> {
    const accountId = auth.membership.accountId
    const [access, account] = await Promise.all([
      this.billing.access(accountId),
      this.prisma.account.findUnique({
        where: { id: accountId },
        select: { billingCheckoutUrl: true },
      }),
    ])
    return {
      accessAllowed: access.accessAllowed,
      paying: access.paying,
      trialExpiresAt: access.trialExpiresAt,
      // A paying account has nothing to check out; don't dangle the link.
      checkoutUrl: access.paying ? null : (account?.billingCheckoutUrl ?? null),
    }
  }
}
