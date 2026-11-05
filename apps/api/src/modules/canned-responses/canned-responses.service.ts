import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { CannedResponse, Prisma, Role } from '@cosmika/db'
import {
  CreateCannedResponseInput,
  UpdateCannedResponseInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class CannedResponsesService {
  constructor(private readonly prisma: PrismaService) {}

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

  async list(userId: string, accountId: string): Promise<CannedResponse[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.cannedResponse.findMany({
      where: { accountId },
      orderBy: { shortcode: 'asc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateCannedResponseInput,
  ): Promise<CannedResponse> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    try {
      return await this.prisma.cannedResponse.create({
        data: {
          accountId,
          shortcode: input.shortcode.toLowerCase(),
          content: input.content,
        },
      })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(errBody('shortcode_taken', 'Shortcode already exists'))
      }
      throw err
    }
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateCannedResponseInput,
  ): Promise<CannedResponse> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.cannedResponse.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    const data: Prisma.CannedResponseUpdateInput = {}
    if (input.shortcode !== undefined) data.shortcode = input.shortcode.toLowerCase()
    if (input.content !== undefined) data.content = input.content
    try {
      return await this.prisma.cannedResponse.update({ where: { id }, data })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(errBody('shortcode_taken', 'Shortcode already exists'))
      }
      throw err
    }
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.cannedResponse.findUnique({ where: { id } })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    await this.prisma.cannedResponse.delete({ where: { id } })
  }

  toDTO(c: CannedResponse) {
    return {
      id: c.id,
      accountId: c.accountId,
      shortcode: c.shortcode,
      content: c.content,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }
  }
}
