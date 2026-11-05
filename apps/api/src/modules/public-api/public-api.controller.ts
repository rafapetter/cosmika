import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
  PublicContactsPage,
  PublicContactsQuery,
  PublicConversationsPage,
  PublicConversationsQuery,
  PublicMessagesPage,
  PublicMessagesQuery,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { ApiKey, ApiKeyContext, PublicApiGuard } from '../api-keys/public-api.guard'

import { PublicApiService } from './public-api.service'

/**
 * Public REST API v1, authenticated by an account API key
 * (`Authorization: Bearer cosmika_…`). Read-only. Same two prefixes as
 * `whoami` (see PublicApiController): the public URL is
 * app.cosmobots.io/api/v1/…, which reaches this process as /v1/….
 * Documented at /api/docs (openapi.ts).
 */
@Controller(['api/v1', 'v1'])
@UseGuards(PublicApiGuard)
export class PublicApiV1Controller {
  constructor(private readonly svc: PublicApiService) {}

  @Get('conversations')
  listConversations(
    @ApiKey() key: ApiKeyContext,
    @Query(new ZodValidationPipe(PublicConversationsQuery)) query: PublicConversationsQuery,
  ): Promise<PublicConversationsPage> {
    return this.svc.listConversations(key.accountId, query)
  }

  @Get('conversations/:id/messages')
  listMessages(
    @ApiKey() key: ApiKeyContext,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PublicMessagesQuery)) query: PublicMessagesQuery,
  ): Promise<PublicMessagesPage> {
    return this.svc.listMessages(key.accountId, id, query)
  }

  @Get('contacts')
  listContacts(
    @ApiKey() key: ApiKeyContext,
    @Query(new ZodValidationPipe(PublicContactsQuery)) query: PublicContactsQuery,
  ): Promise<PublicContactsPage> {
    return this.svc.listContacts(key.accountId, query)
  }
}
