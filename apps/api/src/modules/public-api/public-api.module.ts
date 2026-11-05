import { Module } from '@nestjs/common'

import { PublicApiDocsController } from './docs.controller'
import { PublicApiV1Controller } from './public-api.controller'
import { PublicApiService } from './public-api.service'

// PublicApiGuard and ApiKeysService come from the global ApiKeysModule.
@Module({
  controllers: [PublicApiV1Controller, PublicApiDocsController],
  providers: [PublicApiService],
})
export class PublicApiModule {}
