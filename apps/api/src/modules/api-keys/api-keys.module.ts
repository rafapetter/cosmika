import { Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { ApiKeysController, PublicApiController } from './api-keys.controller'
import { ApiKeysService } from './api-keys.service'
import { PublicApiGuard } from './public-api.guard'

@Global()
@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController, PublicApiController],
  providers: [ApiKeysService, PublicApiGuard],
  exports: [ApiKeysService, PublicApiGuard],
})
export class ApiKeysModule {}
