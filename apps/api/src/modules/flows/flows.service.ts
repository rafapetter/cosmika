import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { Prisma } from '@cosmika/db'
import type { Flow, Role } from '@cosmika/db'
import {
  CreateFlowInput,
  type FlowCheckDTO,
  FlowDefinition,
  FlowDTO,
  FlowPreviewInput,
  FlowSummaryDTO,
  UpdateFlowInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

import { runSandboxedCode } from './flow-code-sandbox'
import { FlowEngine, type FlowRuntimeState, type FlowStepResult } from './flow-engine'
import { lintFlow } from './flow-lint'
import { collectLinkIds } from './flow-runner.service'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name)

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

  private async getOwned(accountId: string, flowId: string): Promise<Flow> {
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId } })
    if (!flow || flow.accountId !== accountId) throw new NotFoundException()
    return flow
  }

  async list(userId: string, accountId: string): Promise<Flow[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.flow.findMany({
      where: { accountId, status: { not: 'ARCHIVED' } },
      orderBy: { updatedAt: 'desc' },
    })
  }

  async get(userId: string, accountId: string, flowId: string): Promise<Flow> {
    await this.getMembership(userId, accountId)
    return this.getOwned(accountId, flowId)
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateFlowInput,
  ): Promise<Flow> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    return this.prisma.flow.create({
      data: {
        accountId,
        name: input.name,
        status: 'DRAFT',
        definition: input.definition as unknown as Prisma.InputJsonValue,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    flowId: string,
    input: UpdateFlowInput,
  ): Promise<Flow> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    await this.getOwned(accountId, flowId)
    const data: Prisma.FlowUpdateInput = {}
    if (input.name !== undefined) data.name = input.name
    if (input.definition !== undefined) {
      data.definition = input.definition as unknown as Prisma.InputJsonValue
    }
    return this.prisma.flow.update({ where: { id: flowId }, data })
  }

  /** Snapshot the current draft definition into `published` and mark PUBLISHED. */
  /**
   * Publish the draft, and tell the author what is wrong with it.
   *
   * The checks WARN, they never block. An author mid-build is entitled to
   * publish a half-wired graph, and a linter that refuses would just teach
   * people to work around it. What we will not do again is publish in silence:
   * the commercial menu carried an orphan Condition chain from its import in
   * April 2026 until a lead hit it in September, and nothing ever said so.
   */
  async publish(
    userId: string,
    accountId: string,
    flowId: string,
  ): Promise<{ flow: Flow; checks: FlowCheckDTO[] }> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    const flow = await this.getOwned(accountId, flowId)
    const published = await this.prisma.flow.update({
      where: { id: flowId },
      data: {
        published: flow.definition as Prisma.InputJsonValue,
        status: 'PUBLISHED',
      },
    })
    return { flow: published, checks: await this.checkFlow(published) }
  }

  /**
   * Lint a flow against the rest of the account's flows, so a Cosmoflow link
   * can be told apart from a broken one. Never throws: a publish that worked
   * must not fail because the report did.
   */
  private async checkFlow(flow: Flow): Promise<FlowCheckDTO[]> {
    try {
      // Always the snapshot that just went live, never the draft: the author
      // must be told about the graph customers will actually walk.
      const parsed = FlowDefinition.safeParse(flow.published)
      if (!parsed.success) return []
      const siblings = await this.prisma.flow.findMany({
        where: { accountId: flow.accountId, externalId: { not: null } },
        select: { externalId: true },
      })
      const resolvable = new Set(
        siblings.map((f) => f.externalId).filter((id): id is string => id !== null),
      )
      const self = new Set(flow.externalId ? [flow.externalId] : [])
      return lintFlow(parsed.data, resolvable, self).map((f) => ({
        code: f.code,
        groupId: f.groupId,
        groupTitle: f.groupTitle,
      }))
    } catch (err) {
      this.logger.warn(
        `flow checks skipped for ${flow.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }

  async archive(
    userId: string,
    accountId: string,
    flowId: string,
  ): Promise<void> {
    const m = await this.getMembership(userId, accountId)
    this.assertMutator(m.role)
    await this.getOwned(accountId, flowId)
    await this.prisma.flow.update({
      where: { id: flowId },
      data: { status: 'ARCHIVED' },
    })
  }

  /**
   * Stateless "test bot" run for the builder preview panel. Executes the
   * DRAFT definition through the real FlowEngine with NOOP external effects
   * (no HTTP, no LLM, no provider calls — but Code blocks DO run, in the same
   * sandbox as production) and persists nothing — the client
   * carries the runtime state between steps. Sub-flows resolve exactly like
   * the production runner (account-scoped, by externalId).
   */
  async preview(
    userId: string,
    accountId: string,
    flowId: string,
    body: FlowPreviewInput,
  ): Promise<FlowStepResult> {
    await this.getMembership(userId, accountId)
    const flow = await this.getOwned(accountId, flowId)
    const parsed = FlowDefinition.safeParse(flow.definition)
    if (!parsed.success) {
      throw new UnprocessableEntityException(errBody('flow_invalid', 'Flow definition is invalid'))
    }
    const subFlows = await this.loadSubFlows(parsed.data, accountId)
    // Code blocks DO run in preview (same sandbox as the live runner) — with a
    // no-op runCode the engine takes different branches than production and
    // the preview silently lies about flow behavior. Variable mutation is the
    // sandbox's only effect; it has no network or host access.
    // Same clock as production: date conditions read the account timezone.
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultTimezone: true, defaultLocale: true },
    })
    // An AI agent block is not called here: the test bot has no conversation
    // for it to read and a real turn costs money. It says so, in the
    // account's language, and still counts the turn, so the author can watch
    // the transfer fire at `maxAiTurns`.
    const simulated = previewAgentReply(account?.defaultLocale ?? 'pt-BR')
    const engine = new FlowEngine(
      parsed.data,
      'STRICT',
      {
        runCode: (code, vars) => runSandboxedCode(code, vars),
        agentTurn: async () => ({ kind: 'reply', text: simulated, handoff: false }),
      },
      subFlows,
    )
    const ctx = {
      contact: { name: 'Visitante (teste)', email: null, phoneNumber: null },
      timezone: account?.defaultTimezone ?? null,
    }
    if (body.state) {
      return engine.resume(
        body.state as FlowRuntimeState,
        {
          text: body.input?.text ?? '',
          interactiveReplyId: body.input?.interactiveReplyId ?? null,
        },
        ctx,
      )
    }
    return engine.start(ctx)
  }

  /** BFS the sub-flows referenced by Cosmoflow-link blocks (mirror of the runner). */
  private async loadSubFlows(
    rootDef: FlowDefinition,
    accountId: string,
  ): Promise<Map<string, FlowDefinition>> {
    const MAX_SUBFLOWS = 100
    const resolved = new Map<string, FlowDefinition>()
    const seen = new Set<string>()
    let frontier = collectLinkIds(rootDef)
    while (frontier.length > 0 && resolved.size < MAX_SUBFLOWS) {
      const wanted = frontier.filter((id) => !seen.has(id))
      wanted.forEach((id) => seen.add(id))
      if (wanted.length === 0) break
      const rows = await this.prisma.flow.findMany({
        where: {
          accountId,
          externalId: { in: wanted },
          published: { not: Prisma.JsonNull },
        },
      })
      const next: string[] = []
      for (const row of rows) {
        if (!row.externalId || resolved.has(row.externalId)) continue
        const sub = FlowDefinition.safeParse(row.published)
        if (!sub.success) continue
        resolved.set(row.externalId, sub.data)
        next.push(...collectLinkIds(row.published))
      }
      frontier = next
    }
    return resolved
  }

  toDTO(flow: Flow): FlowDTO {
    return {
      id: flow.id,
      accountId: flow.accountId,
      name: flow.name,
      status: flow.status,
      definition: FlowDefinition.parse(flow.definition),
      hasPublished: flow.published !== null,
      createdAt: flow.createdAt.toISOString(),
      updatedAt: flow.updatedAt.toISOString(),
    }
  }

  toSummaryDTO(flow: Flow): FlowSummaryDTO {
    return {
      id: flow.id,
      name: flow.name,
      status: flow.status,
      hasPublished: flow.published !== null,
      updatedAt: flow.updatedAt.toISOString(),
      externalId: flow.externalId ?? null,
    }
  }
}

/** Stand-in for an AI agent's answer in the builder's test bot. */
export function previewAgentReply(locale: string): string {
  switch (locale) {
    case 'en':
      return '🤖 (AI agent reply: not generated in the test bot)'
    case 'es':
      return '🤖 (respuesta del agente de IA: no se genera en la prueba)'
    default:
      return '🤖 (resposta do agente de IA: não é gerada no teste)'
  }
}
