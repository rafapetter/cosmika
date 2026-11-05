import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { AutomationRule, Prisma, Role } from '@cosmika/db'
import {
  AutomationAction,
  AutomationCondition,
  AutomationRuleDTO,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

import { AutomationEngine } from './automation.engine'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: AutomationEngine,
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

  async list(userId: string, accountId: string): Promise<AutomationRule[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.automationRule.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async get(userId: string, accountId: string, id: string): Promise<AutomationRule> {
    await this.getMembership(userId, accountId)
    const rule = await this.prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.accountId !== accountId) throw new NotFoundException()
    return rule
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateAutomationRuleInput,
  ): Promise<AutomationRule> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    return this.prisma.automationRule.create({
      data: {
        accountId,
        name: input.name,
        description: input.description ?? null,
        triggerEvent: input.triggerEvent,
        isActive: input.isActive ?? true,
        conditions: input.conditions as unknown as Prisma.InputJsonValue,
        actions: input.actions as unknown as Prisma.InputJsonValue,
        runOncePerConversation: input.runOncePerConversation ?? true,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    input: UpdateAutomationRuleInput,
  ): Promise<AutomationRule> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.automationRule.findUnique({
      where: { id },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    const data: Prisma.AutomationRuleUpdateInput = {}
    if (input.name !== undefined) data.name = input.name
    if (input.description !== undefined) data.description = input.description
    if (input.triggerEvent !== undefined) data.triggerEvent = input.triggerEvent
    if (input.isActive !== undefined) data.isActive = input.isActive
    if (input.conditions !== undefined) {
      data.conditions = input.conditions as unknown as Prisma.InputJsonValue
    }
    if (input.actions !== undefined) {
      data.actions = input.actions as unknown as Prisma.InputJsonValue
    }
    if (input.runOncePerConversation !== undefined) {
      data.runOncePerConversation = input.runOncePerConversation
    }
    return this.prisma.automationRule.update({ where: { id }, data })
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const existing = await this.prisma.automationRule.findUnique({
      where: { id },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) throw new NotFoundException()
    await this.prisma.automationRule.delete({ where: { id } })
  }

  async dryRun(
    userId: string,
    accountId: string,
    id: string,
    conversationId: string,
  ) {
    const rule = await this.get(userId, accountId, id)
    return this.engine.dryRun(rule, conversationId)
  }

  toDTO(rule: AutomationRule): AutomationRuleDTO {
    const conditions = Array.isArray(rule.conditions)
      ? (rule.conditions as unknown as AutomationCondition[])
      : []
    const actions = Array.isArray(rule.actions)
      ? (rule.actions as unknown as AutomationAction[])
      : []
    return {
      id: rule.id,
      accountId: rule.accountId,
      name: rule.name,
      description: rule.description,
      triggerEvent: rule.triggerEvent,
      isActive: rule.isActive,
      conditions,
      actions,
      runOncePerConversation: rule.runOncePerConversation,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    }
  }
}
