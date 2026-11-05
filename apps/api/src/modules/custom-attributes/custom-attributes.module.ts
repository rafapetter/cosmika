import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'

import { CustomAttributesController } from './custom-attributes.controller'
import { CustomAttributesService } from './custom-attributes.service'

@Module({
  imports: [AuthModule],
  controllers: [CustomAttributesController],
  providers: [CustomAttributesService],
  exports: [CustomAttributesService],
})
export class CustomAttributesModule {}
