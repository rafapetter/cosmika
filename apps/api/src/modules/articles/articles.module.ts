import { Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { ArticlesController } from './articles.controller'
import { ArticlesService } from './articles.service'

@Global()
@Module({
  imports: [AuthModule],
  controllers: [ArticlesController],
  providers: [ArticlesService],
  exports: [ArticlesService],
})
export class ArticlesModule {}
