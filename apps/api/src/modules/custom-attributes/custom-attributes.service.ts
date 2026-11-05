import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { CustomAttribute, Prisma } from '@cosmika/db'
import {
  CreateCustomAttributeInput,
  UpdateCustomAttributeInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

@Injectable()
export class CustomAttributesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  private async assertAdmin(userId: string, accountId: string) {
    const m = await this.assertMember(userId, accountId)
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  async list(
    userId: string,
    accountId: string,
    target?: 'CONTACT' | 'CONVERSATION',
  ): Promise<CustomAttribute[]> {
    await this.assertMember(userId, accountId)
    return this.prisma.customAttribute.findMany({
      where: { accountId, ...(target ? { target } : {}) },
      orderBy: [{ target: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateCustomAttributeInput,
  ): Promise<CustomAttribute> {
    await this.assertAdmin(userId, accountId)
    const dupe = await this.prisma.customAttribute.findUnique({
      where: {
        accountId_target_key: {
          accountId,
          target: input.target,
          key: input.key,
        },
      },
    })
    if (dupe) {
      throw new ConflictException(errBody('attribute_key_taken', `Key "${input.key}" already exists`))
    }
    return this.prisma.customAttribute.create({
      data: {
        accountId,
        target: input.target,
        key: input.key,
        label: input.label,
        type: input.type,
        options: (input.options ?? null) as Prisma.InputJsonValue,
        position: input.position ?? 0,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateCustomAttributeInput,
  ): Promise<CustomAttribute> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.customAttribute.findUnique({
      where: { id },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    const data: Prisma.CustomAttributeUpdateInput = {}
    if (input.label !== undefined) data.label = input.label
    if (input.type !== undefined) data.type = input.type
    if (input.options !== undefined) {
      data.options =
        input.options === null
          ? (null as unknown as Prisma.InputJsonValue)
          : (input.options as unknown as Prisma.InputJsonValue)
    }
    if (input.position !== undefined) data.position = input.position
    return this.prisma.customAttribute.update({ where: { id }, data })
  }

  async remove(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<void> {
    await this.assertAdmin(userId, accountId)
    const existing = await this.prisma.customAttribute.findUnique({
      where: { id },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    await this.prisma.customAttribute.delete({ where: { id } })
  }

  toDTO(row: CustomAttribute) {
    return {
      id: row.id,
      accountId: row.accountId,
      target: row.target,
      key: row.key,
      label: row.label,
      type: row.type,
      options: (row.options ?? null) as
        | { value: string; label: string }[]
        | null,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
    }
  }
}
