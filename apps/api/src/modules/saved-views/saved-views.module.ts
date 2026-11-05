import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { SavedViewsController } from './saved-views.controller'
import { SavedViewsService } from './saved-views.service'

@Module({
  imports: [AuthModule],
  controllers: [SavedViewsController],
  providers: [SavedViewsService],
  exports: [SavedViewsService],
})
export class SavedViewsModule {}
