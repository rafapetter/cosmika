import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'

import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { SearchService } from './search.service'

@Controller('accounts/:accountId/search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  async global(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query('q') q: string,
  ) {
    const hits = await this.svc.global(auth.user.id, accountId, q ?? '')
    return { hits }
  }
}
