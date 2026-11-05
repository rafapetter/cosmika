import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Label, Prisma, Role } from '@cosmika/db'
import { CreateLabelInput, UpdateLabelInput } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { ActivityService } from '../activity/activity.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class LabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private async getMembership(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }
  private assertMutator(role: Role) {
    if (!MUTATE_ROLES.includes(role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  async list(userId: string, accountId: string): Promise<Label[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.label.findMany({
      where: { accountId },
      orderBy: { title: 'asc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateLabelInput,
  ): Promise<Label> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    try {
      return await this.prisma.label.create({
        data: { accountId, title: input.title, color: input.color },
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(errBody('label_title_taken', 'Label title already in use'))
      }
      throw err
    }
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateLabelInput,
  ): Promise<Label> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.label.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    const data: Prisma.LabelUpdateInput = {}
    if (input.title !== undefined) data.title = input.title
    if (input.color !== undefined) data.color = input.color
    try {
      return await this.prisma.label.update({ where: { id }, data })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(errBody('label_title_taken', 'Label title already in use'))
      }
      throw err
    }
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.label.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    await this.prisma.label.delete({ where: { id } })
  }

  /** Apply or remove a label on a conversation. */
  async applyToConversation(
    userId: string,
    accountId: string,
    conversationId: string,
    labelId: string,
  ) {
    await this.getMembership(userId, accountId)
    const [label, conv] = await Promise.all([
      this.prisma.label.findUnique({ where: { id: labelId } }),
      this.prisma.conversation.findUnique({ where: { id: conversationId } }),
    ])
    if (!label || label.accountId !== accountId) throw new NotFoundException('Label')
    if (!conv || conv.accountId !== accountId) throw new NotFoundException('Conversation')
    // Only note a label that wasn't already on the conversation — re-applying
    // is a no-op and shouldn't add a line to the transcript.
    const already = await this.prisma.conversationLabel.findUnique({
      where: { conversationId_labelId: { conversationId, labelId } },
    })
    await this.prisma.conversationLabel.upsert({
      where: { conversationId_labelId: { conversationId, labelId } },
      create: { conversationId, labelId },
      update: {},
    })
    if (!already) {
      const actorName = await this.activity.actorName(userId)
      await this.activity.log(conv, {
        type: 'label',
        text: `Label ${label.title} added${ActivityService.by(actorName)}`,
        actorName,
        to: label.title,
      })
    }
  }

  async removeFromConversation(
    userId: string,
    accountId: string,
    conversationId: string,
    labelId: string,
  ) {
    await this.getMembership(userId, accountId)
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, accountId: true, inboxId: true },
    })
    if (!conv || conv.accountId !== accountId) throw new NotFoundException()
    const { count } = await this.prisma.conversationLabel.deleteMany({
      where: { conversationId, labelId },
    })
    if (count > 0) {
      const label = await this.prisma.label.findUnique({ where: { id: labelId } })
      const actorName = await this.activity.actorName(userId)
      await this.activity.log(conv, {
        type: 'label',
        text: `Label ${label?.title ?? 'unknown'} removed${ActivityService.by(actorName)}`,
        actorName,
        from: label?.title ?? null,
      })
    }
  }

  toDTO(l: Label) {
    return {
      id: l.id,
      accountId: l.accountId,
      title: l.title,
      color: l.color,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }
  }
}
