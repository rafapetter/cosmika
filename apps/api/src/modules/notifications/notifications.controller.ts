import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ListNotificationsQuery,
  NotificationCounts,
  NotificationDTO,
  NotificationPreferenceDTO,
  UpdateNotificationPreferenceInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { NotificationsService } from './notifications.service'

@Controller('accounts/:accountId/notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListNotificationsQuery))
    query: ListNotificationsQuery,
  ): Promise<NotificationDTO[]> {
    const rows = await this.notifications.list(auth.user.id, accountId, query)
    // Hydrate message previews in one batch (avoids N+1).
    const messageIds = rows
      .map((r) => r.messageId)
      .filter((id): id is string => Boolean(id))
    const messages = messageIds.length
      ? await this.prisma.message.findMany({
          where: { id: { in: messageIds } },
          select: { id: true, content: true },
        })
      : []
    const previewById = new Map(
      messages.map((m) => [m.id, (m.content ?? '').slice(0, 160)]),
    )
    return rows.map((r) =>
      this.notifications.toDTO(
        r,
        r.messageId ? previewById.get(r.messageId) ?? null : null,
      ),
    )
  }

  @Get('count')
  async count(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<NotificationCounts> {
    const unread = await this.notifications.unreadCount(auth.user.id, accountId)
    return { unread }
  }

  @Get('preferences')
  async getPreferences(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<NotificationPreferenceDTO> {
    return this.notifications.getPreferences(auth.user.id, accountId)
  }

  @Patch('preferences')
  async updatePreferences(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(UpdateNotificationPreferenceInput))
    body: UpdateNotificationPreferenceInput,
  ): Promise<NotificationPreferenceDTO> {
    return this.notifications.updatePreferences(auth.user.id, accountId, body)
  }

  @Patch(':id/read')
  @HttpCode(204)
  async markRead(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.notifications.markRead(auth.user.id, accountId, id)
  }

  @Post('read-all')
  async markAllRead(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<{ updated: number }> {
    return this.notifications.markAllRead(auth.user.id, accountId)
  }
}
