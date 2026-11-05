import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import {
  CompleteEmbeddedSignupInput,
  type EmbeddedSignupConfigDTO,
  type InboxDTO,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { InboxesService } from '../inboxes/inboxes.service'

import { WhatsappEmbeddedSignupService } from './whatsapp-embedded-signup.service'

// Embedded Signup: the "Conectar WhatsApp" button on the new channel screen.
// Both routes answer as if the feature did not exist while the flag is off or
// the account is not on the allowlist (the config says `enabled: false`, the
// completion is a 404).
@Controller('accounts/:accountId/whatsapp/embedded-signup')
@UseGuards(AuthGuard)
export class WhatsappEmbeddedSignupController {
  constructor(
    private readonly signup: WhatsappEmbeddedSignupService,
    private readonly inboxes: InboxesService,
  ) {}

  @Get('config')
  async config(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<EmbeddedSignupConfigDTO> {
    return this.signup.publicConfig(auth.user.id, accountId)
  }

  @Post()
  async complete(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CompleteEmbeddedSignupInput)) body: CompleteEmbeddedSignupInput,
  ): Promise<InboxDTO> {
    const inbox = await this.signup.complete(auth.user.id, accountId, body)
    return this.inboxes.toInboxDTO(inbox)
  }
}
