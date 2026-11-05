import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type {
  AccountMember,
  AgentBot,
  Prisma,
  Role,
} from '@cosmika/db'
import {
  CreateAgentBotInput,
  UpdateAgentBotInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'
import { AiUsageService } from '../usage/ai-usage.service'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class AgentBotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

  private async getMembership(
    userId: string,
    accountId: string,
  ): Promise<AccountMember> {
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

  async list(userId: string, accountId: string): Promise<AgentBot[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.agentBot.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async get(
    userId: string,
    accountId: string,
    botId: string,
  ): Promise<AgentBot> {
    await this.getMembership(userId, accountId)
    const bot = await this.prisma.agentBot.findUnique({
      where: { id: botId },
    })
    if (!bot || bot.accountId !== accountId) throw new NotFoundException()
    return bot
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateAgentBotInput,
  ): Promise<AgentBot> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    return this.prisma.agentBot.create({
      data: {
        accountId,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        model: input.model ?? 'claude-opus-4-7',
        temperature: input.temperature ?? 0.7,
        toolsEnabled: (input.toolsEnabled ?? []) as Prisma.InputJsonValue,
        customTools: (input.customTools ?? []) as Prisma.InputJsonValue,
        fallbackToHuman: input.fallbackToHuman ?? true,
        autoSafeConfidenceThreshold: input.autoSafeConfidenceThreshold ?? 80,
        dailyBudgetUsd: input.dailyBudgetUsd ?? 10,
        knowledgeTags: normalizeTags(input.knowledgeTags ?? []),
        isActive: input.isActive ?? true,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    botId: string,
    input: UpdateAgentBotInput,
  ): Promise<AgentBot> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.agentBot.findUnique({
      where: { id: botId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    const data: Prisma.AgentBotUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(input.systemPrompt !== undefined && {
        systemPrompt: input.systemPrompt,
      }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.temperature !== undefined && {
        temperature: input.temperature,
      }),
      ...(input.toolsEnabled !== undefined && {
        toolsEnabled: input.toolsEnabled as Prisma.InputJsonValue,
      }),
      ...(input.customTools !== undefined && {
        customTools: input.customTools as Prisma.InputJsonValue,
      }),
      ...(input.fallbackToHuman !== undefined && {
        fallbackToHuman: input.fallbackToHuman,
      }),
      ...(input.autoSafeConfidenceThreshold !== undefined && {
        autoSafeConfidenceThreshold: input.autoSafeConfidenceThreshold,
      }),
      ...(input.dailyBudgetUsd !== undefined && {
        dailyBudgetUsd: input.dailyBudgetUsd,
      }),
      ...(input.knowledgeTags !== undefined && {
        knowledgeTags: normalizeTags(input.knowledgeTags),
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    }
    return this.prisma.agentBot.update({
      where: { id: botId },
      data,
    })
  }

  async remove(
    userId: string,
    accountId: string,
    botId: string,
  ): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.prisma.agentBot.findUnique({
      where: { id: botId },
      select: { id: true, accountId: true },
    })
    if (!existing || existing.accountId !== accountId) {
      throw new NotFoundException()
    }
    // Detach from inboxes + clear sessions (FK on AiAgentSession is Restrict
    // by default; cascade tool calls then sessions before deleting the bot).
    await this.prisma.$transaction(async (tx) => {
      await tx.inbox.updateMany({
        where: { agentBotId: botId },
        data: { agentBotId: null },
      })
      const sessions = await tx.aiAgentSession.findMany({
        where: { agentBotId: botId },
        select: { id: true },
      })
      if (sessions.length > 0) {
        const sessionIds = sessions.map((s) => s.id)
        await tx.agentToolCall.deleteMany({
          where: { sessionId: { in: sessionIds } },
        })
        await tx.aiAgentSession.deleteMany({
          where: { id: { in: sessionIds } },
        })
      }
      await tx.agentBot.delete({ where: { id: botId } })
    })
  }

  /** Sum cost over the last 24h across sessions for a bot. */
  async costLast24h(botId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const result = await this.prisma.aiAgentSession.aggregate({
      where: { agentBotId: botId, lastActiveAt: { gte: since } },
      _sum: { totalCostUsd: true },
    })
    const sum = result._sum.totalCostUsd
    return sum ? Number(sum) : 0
  }

  async inboxCount(botId: string): Promise<number> {
    return this.prisma.inbox.count({ where: { agentBotId: botId } })
  }

  /** Published articles the bot answers from: its tags, or the whole base. */
  async knowledgeArticleCount(bot: AgentBot): Promise<number> {
    return this.prisma.article.count({
      where: {
        accountId: bot.accountId,
        status: 'PUBLISHED',
        ...(bot.knowledgeTags.length > 0 ? { tags: { hasSome: bot.knowledgeTags } } : {}),
      },
    })
  }

  /**
   * AI spend for the account so far this billing month, across every bot.
   *
   * Read from the `AiUsageEvent` ledger, which has one row per call with its
   * own timestamp. The previous implementation summed
   * `AiAgentSession.totalCostUsd` over sessions active in the window, so a
   * conversation that had been running since March added its WHOLE lifetime
   * cost to April, and to May, and to June — the number this guard compared
   * against the account's ceiling grew without anyone spending anything.
   */
  async costThisMonth(accountId: string): Promise<number> {
    return this.aiUsage.costThisMonth(accountId)
  }

  /**
   * Whether the account has spent its monthly AI allowance. Separate from the
   * per-bot daily cap: that one absorbs a runaway loop within a day, this one
   * is the ceiling the customer is actually billed against.
   */
  async monthlyBudgetExceeded(
    accountId: string,
  ): Promise<{ exceeded: boolean; used: number; cap: number }> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { monthlyAiBudgetUsd: true },
    })
    const cap = account ? Number(account.monthlyAiBudgetUsd) : 0
    const used = await this.costThisMonth(accountId)
    // A cap of 0 means "no monthly ceiling", not "spend nothing" — otherwise
    // clearing the column would silently mute every bot on the account.
    if (cap <= 0) return { exceeded: false, used, cap }
    return { exceeded: used >= cap, used, cap }
  }

  /** Used by the orchestrator before each turn. */
  async assertBudget(bot: AgentBot): Promise<void> {
    const used = await this.costLast24h(bot.id)
    const cap = Number(bot.dailyBudgetUsd)
    if (used >= cap) {
      throw new ConflictException(errBody('ai_budget_exceeded', `Daily AI budget exceeded for bot ${bot.id}: $${used.toFixed(4)} ≥ $${cap.toFixed(2)}`))
    }
  }

  async toDTO(bot: AgentBot) {
    const [costLast24hUsd, inboxCount, knowledgeArticleCount] = await Promise.all([
      this.costLast24h(bot.id),
      this.inboxCount(bot.id),
      this.knowledgeArticleCount(bot),
    ])
    return {
      id: bot.id,
      accountId: bot.accountId,
      name: bot.name,
      description: bot.description,
      systemPrompt: bot.systemPrompt,
      model: bot.model,
      temperature: bot.temperature,
      toolsEnabled: (bot.toolsEnabled as unknown as Array<{
        name: string
        config?: Record<string, unknown>
      }>) ?? [],
      customTools:
        (bot.customTools as unknown as Array<Record<string, unknown>>) ?? [],
      fallbackToHuman: bot.fallbackToHuman,
      autoSafeConfidenceThreshold: bot.autoSafeConfidenceThreshold,
      dailyBudgetUsd: Number(bot.dailyBudgetUsd),
      knowledgeTags: bot.knowledgeTags,
      knowledgeArticleCount,
      isActive: bot.isActive,
      costLast24hUsd,
      inboxCount,
      createdAt: bot.createdAt.toISOString(),
      updatedAt: bot.updatedAt.toISOString(),
    }
  }
}

/** Trimmed, de-duplicated, order kept: tags are matched exactly against Article.tags. */
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))]
}
