import { forwardRef, Global, Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { EmailModule } from '../email/email.module'
import { WhatsappModule } from '../whatsapp/whatsapp.module'

import { CsatPublicController, CsatStatsController } from './csat.controller'
import { CsatService } from './csat.service'
import { NpsService } from './nps.service'

@Global()
@Module({
  imports: [AuthModule, forwardRef(() => WhatsappModule), EmailModule],
  controllers: [CsatPublicController, CsatStatsController],
  providers: [CsatService, NpsService],
  exports: [CsatService],
})
export class CsatModule {}
