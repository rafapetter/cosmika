import {
  ForbiddenException,
  Injectable,
  NotFoundException,
 BadRequestException } from '@nestjs/common'
import type { Prisma, SavedView } from '@cosmika/db'
import {
  CreateSavedViewInput,
  SavedViewEntity,
  UpdateSavedViewInput,
  payloadIssues,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  async list(
    userId: string,
    accountId: string,
    // Defaulted so every pre-existing caller (the conversations sidebar)
    // keeps seeing exactly what it saw before contact views existed.
    entity: SavedViewEntity = 'CONVERSATIONS',
  ): Promise<SavedView[]> {
    await this.assertMember(userId, accountId)
    return this.prisma.savedView.findMany({
      where: { accountId, userId, entity },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateSavedViewInput,
  ): Promise<SavedView> {
    await this.assertMember(userId, accountId)
    return this.prisma.savedView.create({
      data: {
        accountId,
        userId,
        name: input.name,
        icon: input.icon ?? null,
        entity: input.entity ?? 'CONVERSATIONS',
        filters: input.filters as Prisma.InputJsonValue,
        position: input.position ?? 0,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateSavedViewInput,
  ): Promise<SavedView> {
    await this.assertMember(userId, accountId)
    const existing = await this.prisma.savedView.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId || existing.userId !== userId) {
      throw new NotFoundException()
    }
    const data: Prisma.SavedViewUpdateInput = {}
    if (input.name !== undefined) data.name = input.name
    if (input.icon !== undefined) data.icon = input.icon
    if (input.filters !== undefined) {
      // The schema can't validate a filters-only patch (it doesn't know the
      // stored entity); we do, so we validate here against it.
      const issue = payloadIssues(existing.entity as SavedViewEntity, input.filters)
      if (issue) throw new BadRequestException(errBody('invalid_filters', `invalid filters: ${issue}`))
      data.filters = input.filters as Prisma.InputJsonValue
    }
    if (input.position !== undefined) data.position = input.position
    return this.prisma.savedView.update({ where: { id }, data })
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    await this.assertMember(userId, accountId)
    const existing = await this.prisma.savedView.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId || existing.userId !== userId) {
      throw new NotFoundException()
    }
    await this.prisma.savedView.delete({ where: { id } })
  }

  toDTO(v: SavedView) {
    return {
      id: v.id,
      accountId: v.accountId,
      userId: v.userId,
      name: v.name,
      icon: v.icon,
      entity: v.entity,
      filters: (v.filters ?? {}) as Record<string, unknown>,
      position: v.position,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }
  }
}
