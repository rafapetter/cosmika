import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  AddParticipantInput,
  BulkConversationsInput,
  BulkConversationsResult,
  ConversationDetailDTO,
  ConversationParticipantDTO,
  ConversationSummaryDTO,
  ConversationTranscriptDTO,
  ConversationsPage,
  CreateConversationInput,
  ForwardConversationInput,
  ForwardConversationResult,
  InboundMessageInput,
  ListConversationsQuery,
  MessageDTO,
  MessagesPage,
  ReactToMessageInput,
  SendMessageInput,
  SendTemplateMessageInput,
  UpdateConversationInput,
  type ProtocolHistoryDTO,
} from '@cosmika/shared'
import { z } from 'zod'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { ConversationsService } from './conversations.service'

const MessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

@Controller('accounts/:accountId/conversations')
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly audit: AuditLogService,
  ) {}

  /** `message.sent`: an agent's reply or internal note. The content stays in
   *  the message table; the trail keeps who, when and which message. A trail
   *  write failure must not 500 a message that already went out (the agent
   *  would resend it), so it is swallowed. */
  private recordMessageSent(
    userId: string,
    accountId: string,
    conversationId: string,
    m: { id: string; isPrivate: boolean },
    template: boolean,
  ) {
    return this.audit.record({
      accountId,
      actorId: userId,
      action: 'message.sent',
      target: `conversation:${conversationId}`,
      metadata: { messageId: m.id, isPrivate: m.isPrivate, ...(template ? { template: true } : {}) },
    }).catch(() => undefined)
  }

  // ── Conversations ──

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListConversationsQuery))
    query: ListConversationsQuery,
  ): Promise<ConversationsPage> {
    const { data, nextCursor } = await this.conversations.list(
      auth.user.id,
      accountId,
      query,
    )
    return {
      data: data.map((c) => this.conversations.toSummaryDTO(c)),
      nextCursor,
    }
  }

  @Post('bulk')
  async bulk(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(BulkConversationsInput))
    body: BulkConversationsInput,
  ): Promise<BulkConversationsResult> {
    const result = await this.conversations.bulk(
      auth.user.id,
      accountId,
      body.ids,
      body.action,
    )
    // One row per bulk act (not per conversation): the trail says who did
    // it, when, and over which ids, without flooding the log.
    const bulkAction =
      body.action.type === 'STATUS' && body.action.status === 'RESOLVED'
        ? 'conversation.resolved'
        : body.action.type === 'ASSIGN'
          ? 'conversation.assigned'
          : null
    if (bulkAction && result.updated > 0) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: bulkAction,
        target: null,
        metadata: {
          bulk: true,
          conversationIds: body.ids,
          updated: result.updated,
          ...(body.action.type === 'ASSIGN' ? { assigneeId: body.action.assigneeId } : {}),
        },
      })
    }
    return result
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateConversationInput))
    body: CreateConversationInput,
  ): Promise<ConversationSummaryDTO> {
    const conversation = await this.conversations.create(
      auth.user.id,
      accountId,
      body,
    )
    return this.conversations.toSummaryDTO(conversation)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ConversationDetailDTO> {
    const { conversation, messageCount, lastMessageAt, forwardedFrom, messagingWindow } =
      await this.conversations.getDetail(auth.user.id, accountId, id)
    return this.conversations.toDetailDTO(
      conversation,
      messageCount,
      lastMessageAt,
      forwardedFrom,
      messagingWindow,
    )
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateConversationInput))
    body: UpdateConversationInput,
  ): Promise<ConversationSummaryDTO> {
    // The prior state tells a real resolve/assignment from a no-op PATCH.
    const before =
      body.status === 'RESOLVED' || body.assigneeId !== undefined
        ? (await this.conversations.assertConversationAccess(auth.user.id, accountId, id))
            .conversation
        : null
    const updated = await this.conversations.update(
      auth.user.id,
      accountId,
      id,
      body,
    )
    if (before && before.status !== 'RESOLVED' && updated.status === 'RESOLVED') {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'conversation.resolved',
        target: `conversation:${id}`,
        metadata: { displayId: updated.displayId, from: before.status },
      })
    }
    if (before && body.assigneeId !== undefined && before.assigneeId !== body.assigneeId) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'conversation.assigned',
        target: `conversation:${id}`,
        metadata: {
          displayId: updated.displayId,
          assigneeId: body.assigneeId,
          previousAssigneeId: before.assigneeId,
        },
      })
    }
    return this.conversations.toSummaryDTO(updated)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.conversations.remove(auth.user.id, accountId, id)
  }

  @Get(':id/transcript')
  async transcript(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ConversationTranscriptDTO> {
    return this.conversations.buildTranscript(auth.user.id, accountId, id)
  }

  @Get(':id/protocol-history')
  async protocolHistory(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ProtocolHistoryDTO> {
    return this.conversations.protocolHistory(auth.user.id, accountId, id)
  }

  @Post(':id/auto-assign')
  async autoAssign(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<{ assigneeId: string | null }> {
    const result = await this.conversations.autoAssign(auth.user.id, accountId, id)
    if (result.assigneeId) {
      await this.audit.record({
        accountId,
        actorId: auth.user.id,
        action: 'conversation.assigned',
        target: `conversation:${id}`,
        metadata: { assigneeId: result.assigneeId, auto: true },
      })
    }
    return result
  }

  @Post(':id/forward')
  async forward(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ForwardConversationInput))
    body: ForwardConversationInput,
  ): Promise<ForwardConversationResult> {
    const result = await this.conversations.forwardToInbox(
      auth.user.id,
      accountId,
      id,
      body,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'conversation.forward',
      target: `conversation:${id}`,
      metadata: {
        targetInboxId: body.targetInboxId,
        newConversationId: result.conversationId,
        newDisplayId: result.displayId,
        copyAssignee: body.copyAssignee ?? false,
      },
    })
    return result
  }

  // ── Participants ──

  @Post(':id/participants')
  async addParticipant(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddParticipantInput))
    body: AddParticipantInput,
  ): Promise<ConversationParticipantDTO> {
    const p = await this.conversations.addParticipant(
      auth.user.id,
      accountId,
      id,
      body,
    )
    return this.conversations.toParticipantDTO(p)
  }

  @Delete(':id/participants/:userId')
  @HttpCode(204)
  async removeParticipant(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.conversations.removeParticipant(
      auth.user.id,
      accountId,
      id,
      userId,
    )
  }

  // ── Messages ──

  @Get(':id/messages')
  async listMessages(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(MessagesQuery))
    query: z.infer<typeof MessagesQuery>,
  ): Promise<MessagesPage> {
    const { data, nextCursor } = await this.conversations.listMessages(
      auth.user.id,
      accountId,
      id,
      query.cursor,
      query.limit,
    )
    return {
      data: data.map((m) => this.conversations.toMessageDTO(m)),
      nextCursor,
    }
  }

  @Post(':id/messages')
  async sendMessage(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SendMessageInput)) body: SendMessageInput,
  ): Promise<MessageDTO> {
    const m = await this.conversations.sendAgentMessage(
      auth.user.id,
      accountId,
      id,
      body,
    )
    await this.recordMessageSent(auth.user.id, accountId, id, m, false)
    return this.conversations.toMessageDTO(m)
  }

  @Post(':id/messages/template')
  async sendTemplate(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SendTemplateMessageInput))
    body: SendTemplateMessageInput,
  ): Promise<MessageDTO> {
    const m = await this.conversations.sendTemplateMessage(
      auth.user.id,
      accountId,
      id,
      body,
    )
    await this.recordMessageSent(auth.user.id, accountId, id, m, true)
    return this.conversations.toMessageDTO(m)
  }


  @Post(':id/messages/:messageId/retry')
  async retryMessage(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageDTO> {
    const msg = await this.conversations.retryMessage(
      auth.user.id,
      accountId,
      id,
      messageId,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'message.retried',
      target: `conversation:${id}`,
      metadata: { messageId, status: msg.status },
    })
    return this.conversations.toMessageDTO(msg)
  }

  @Post(':id/messages/:messageId/reaction')
  async react(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body(new ZodValidationPipe(ReactToMessageInput)) body: ReactToMessageInput,
  ): Promise<MessageDTO> {
    const msg = await this.conversations.reactToMessage(
      auth.user.id,
      accountId,
      id,
      messageId,
      body.emoji,
    )
    return this.conversations.toMessageDTO(msg)
  }

  @Delete(':id/messages/:messageId/draft')
  @HttpCode(204)
  async discardDraft(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    await this.conversations.discardAgentDraft(
      auth.user.id,
      accountId,
      id,
      messageId,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'conversation.draft_discarded',
      target: `conversation:${id}`,
      metadata: { messageId },
    })
  }

  @Post(':id/messages/inbound')
  async createInbound(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(InboundMessageInput))
    body: InboundMessageInput,
  ): Promise<MessageDTO> {
    const m = await this.conversations.createInboundMessage(
      auth.user.id,
      accountId,
      id,
      body,
    )
    return this.conversations.toMessageDTO(m)
  }
}
