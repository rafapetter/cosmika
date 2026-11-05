import { Inject, Injectable, forwardRef } from '@nestjs/common'
import type {
  AutomationRule,
  Conversation,
  Message,
  Prisma,
} from '@cosmika/db'
import type {
  AutomationAction,
  AutomationCondition,
  AutomationTriggerEvent,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'
import { WorkingHoursService } from '../working-hours/working-hours.service'
import { AssignmentService } from '../assignment/assignment.service'
import { ChannelsService } from '../channels/channels.service'

export type EvaluationContext = {
  event: AutomationTriggerEvent
  accountId: string
  conversationId: string
  // Latest inbound message, when relevant (MESSAGE_CREATED).
  latestMessage?: Pick<Message, 'id' | 'content' | 'senderType'> | null
  // Whether this is the first inbound message (used by IS_FIRST_MESSAGE condition).
  isFirstMessage?: boolean
}

export type ConditionResult = {
  field: AutomationCondition['field']
  op: AutomationCondition['op']
  matched: boolean
  detail?: string
}

export type RuleEvaluation = {
  ruleId: string
  matched: boolean
  conditionResults: ConditionResult[]
  actionsExecuted: AutomationAction[]
  error?: string
}

@Injectable()
export class AutomationEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly workingHours: WorkingHoursService,
    private readonly assignment: AssignmentService,
    // forwardRef: ChannelsService reaches WhatsappService, which imports
    // ConversationsService, which imports this engine back.
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
  ) {}

  /**
   * Fires from Conversations / Messages services. Loads all active rules for
   * the account + triggerEvent, evaluates conditions, and runs actions. Never
   * throws — errors are recorded on the AutomationRuleRun row.
   */
  async evaluate(ctx: EvaluationContext): Promise<RuleEvaluation[]> {
    const rules = await this.prisma.automationRule.findMany({
      where: {
        accountId: ctx.accountId,
        triggerEvent: ctx.event,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    if (rules.length === 0) return []

    const results: RuleEvaluation[] = []
    for (const rule of rules) {
      try {
        const r = await this.runRule(rule, ctx)
        results.push(r)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[automation] rule ${rule.id} failed:`, message)
        results.push({
          ruleId: rule.id,
          matched: false,
          conditionResults: [],
          actionsExecuted: [],
          error: message,
        })
      }
    }
    return results
  }

  /** Dry-run: evaluate conditions for a conversation but skip persistence. */
  async dryRun(
    rule: AutomationRule,
    conversationId: string,
  ): Promise<{
    matched: boolean
    conditionResults: ConditionResult[]
    wouldExecute: AutomationAction[]
  }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    })
    if (!conversation || conversation.accountId !== rule.accountId) {
      return { matched: false, conditionResults: [], wouldExecute: [] }
    }
    const latestMessage = await this.prisma.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    })
    const conditions = this.parseConditions(rule)
    const actions = this.parseActions(rule)
    const conditionResults: ConditionResult[] = []
    let matched = true
    for (const cond of conditions) {
      const r = await this.evaluateCondition(cond, conversation, latestMessage)
      conditionResults.push(r)
      if (!r.matched) matched = false
    }
    return {
      matched,
      conditionResults,
      wouldExecute: matched ? actions : [],
    }
  }

  // ─── private ─────────────────────────────────────────────────────

  private async runRule(
    rule: AutomationRule,
    ctx: EvaluationContext,
  ): Promise<RuleEvaluation> {
    // Honor runOncePerConversation BEFORE evaluating conditions.
    if (rule.runOncePerConversation) {
      const prior = await this.prisma.automationRuleRun.findUnique({
        where: {
          ruleId_conversationId: {
            ruleId: rule.id,
            conversationId: ctx.conversationId,
          },
        },
      })
      if (prior && prior.matched) {
        return {
          ruleId: rule.id,
          matched: false,
          conditionResults: [],
          actionsExecuted: [],
        }
      }
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: ctx.conversationId },
      include: { contact: true },
    })
    if (!conversation || conversation.accountId !== ctx.accountId) {
      return {
        ruleId: rule.id,
        matched: false,
        conditionResults: [],
        actionsExecuted: [],
      }
    }

    const conditions = this.parseConditions(rule)
    const actions = this.parseActions(rule)

    const conditionResults: ConditionResult[] = []
    let matched = true
    for (const cond of conditions) {
      const r = await this.evaluateCondition(
        cond,
        conversation,
        ctx.latestMessage ?? null,
        ctx,
      )
      conditionResults.push(r)
      if (!r.matched) matched = false
    }

    const actionsExecuted: AutomationAction[] = []
    let runError: string | undefined
    if (matched) {
      try {
        for (const action of actions) {
          await this.executeAction(action, conversation)
          actionsExecuted.push(action)
        }
      } catch (err) {
        runError = err instanceof Error ? err.message : String(err)
      }
    }

    // Upsert run record (covers both first-run and subsequent matches when
    // runOncePerConversation=false but we still want a single row).
    await this.prisma.automationRuleRun.upsert({
      where: {
        ruleId_conversationId: {
          ruleId: rule.id,
          conversationId: ctx.conversationId,
        },
      },
      update: {
        matched,
        ranAt: new Date(),
        result: {
          actions: actionsExecuted.map((a) => ({ kind: a.kind, value: a.value })),
          ...(runError ? { error: runError } : {}),
        } as Prisma.InputJsonValue,
      },
      create: {
        ruleId: rule.id,
        conversationId: ctx.conversationId,
        matched,
        result: {
          actions: actionsExecuted.map((a) => ({ kind: a.kind, value: a.value })),
          ...(runError ? { error: runError } : {}),
        } as Prisma.InputJsonValue,
      },
    })

    return {
      ruleId: rule.id,
      matched,
      conditionResults,
      actionsExecuted,
      ...(runError ? { error: runError } : {}),
    }
  }

  private parseConditions(rule: AutomationRule): AutomationCondition[] {
    const v = rule.conditions as unknown
    return Array.isArray(v) ? (v as AutomationCondition[]) : []
  }
  private parseActions(rule: AutomationRule): AutomationAction[] {
    const v = rule.actions as unknown
    return Array.isArray(v) ? (v as AutomationAction[]) : []
  }

  private async evaluateCondition(
    cond: AutomationCondition,
    conversation: Conversation & {
      contact: { email: string | null }
    },
    latestMessage: Pick<Message, 'content' | 'senderType'> | null,
    ctx?: EvaluationContext,
  ): Promise<ConditionResult> {
    const { field, op, value } = cond
    switch (field) {
      case 'INBOX_ID':
        return this.cmpString(field, op, conversation.inboxId, value)
      case 'PRIORITY':
        return this.cmpString(field, op, conversation.priority, value)
      case 'STATUS':
        return this.cmpString(field, op, conversation.status, value)
      case 'CONTENT_CONTAINS': {
        const haystack = (latestMessage?.content ?? '').toLowerCase()
        const needle = String(value ?? '').toLowerCase()
        const matched = op === 'contains' || op === 'equals'
          ? haystack.includes(needle)
          : !haystack.includes(needle)
        return { field, op, matched }
      }
      case 'CONTACT_EMAIL_DOMAIN': {
        const email = conversation.contact.email ?? ''
        const at = email.indexOf('@')
        const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : ''
        return this.cmpString(field, op, domain, value)
      }
      case 'TAG_INCLUDES': {
        const tags = (conversation.aiTags ?? []).map((t) => t.toLowerCase())
        const needle = String(value ?? '').toLowerCase()
        const has = tags.includes(needle)
        const matched = op === 'not_equals' ? !has : has
        return { field, op, matched }
      }
      case 'OUTSIDE_WORKING_HOURS': {
        const isOpen = await this.workingHours.isInboxOpenNow(
          conversation.accountId,
          conversation.inboxId,
        )
        const wantTrue = value === true || value === 'true'
        const matched = wantTrue ? !isOpen : isOpen
        return { field, op, matched, detail: isOpen ? 'open' : 'closed' }
      }
      case 'IS_FIRST_MESSAGE': {
        const wantTrue = value === true || value === 'true'
        const isFirst = ctx?.isFirstMessage === true
        const matched = wantTrue ? isFirst : !isFirst
        return { field, op, matched }
      }
      default:
        return { field, op, matched: false, detail: 'unknown field' }
    }
  }

  private cmpString(
    field: AutomationCondition['field'],
    op: AutomationCondition['op'],
    actual: string,
    expected: AutomationCondition['value'],
  ): ConditionResult {
    if (op === 'in' && Array.isArray(expected)) {
      return { field, op, matched: expected.includes(actual) }
    }
    if (op === 'not_equals') {
      return { field, op, matched: actual !== String(expected ?? '') }
    }
    // equals / contains both collapse to equality on enum-like fields
    return { field, op, matched: actual === String(expected ?? '') }
  }

  private async executeAction(
    action: AutomationAction,
    conversation: Conversation,
  ): Promise<void> {
    switch (action.kind) {
      case 'ASSIGN_TEAM': {
        const team = await this.prisma.team.findUnique({
          where: { id: action.value },
          select: { accountId: true },
        })
        if (!team || team.accountId !== conversation.accountId) {
          throw new Error(`Team ${action.value} not in account`)
        }
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { teamId: action.value },
        })
        // Same rule as a manual team change: an available team member takes
        // it, unless the current assignee already belongs to the team.
        if (conversation.teamId !== action.value) {
          await this.assignment.route(conversation.id, 'team_changed')
        }
        return
      }
      case 'ASSIGN_USER': {
        const member = await this.prisma.accountMember.findUnique({
          where: {
            accountId_userId: {
              accountId: conversation.accountId,
              userId: action.value,
            },
          },
        })
        if (!member || !member.isActive) {
          throw new Error(`User ${action.value} not active in account`)
        }
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { assigneeId: action.value },
        })
        return
      }
      case 'SET_PRIORITY': {
        const allowed = ['LOW', 'NORMAL', 'HIGH', 'URGENT']
        if (!allowed.includes(action.value)) {
          throw new Error(`Invalid priority ${action.value}`)
        }
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { priority: action.value as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' },
        })
        return
      }
      case 'ADD_TAG': {
        const tag = action.value.trim()
        if (!tag) return
        const tags = conversation.aiTags ?? []
        if (tags.includes(tag)) return
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { aiTags: { set: [...tags, tag] } },
        })
        return
      }
      case 'SET_STATUS': {
        const allowed = ['OPEN', 'RESOLVED', 'PENDING']
        if (!allowed.includes(action.value)) {
          throw new Error(`Invalid status ${action.value}`)
        }
        const next = action.value as 'OPEN' | 'RESOLVED' | 'PENDING'
        // A closed conversation is never reopened, by a person or by a rule
        // (Terms 4.2). A rule that would do it is skipped for this one.
        if (conversation.status === 'RESOLVED' && next !== 'RESOLVED') return
        const now = new Date()
        const patch: Prisma.ConversationUpdateInput = { status: next }
        if (next === 'RESOLVED' && conversation.status !== 'RESOLVED') {
          patch.resolvedAt = now
        }
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: patch,
        })
        await this.realtime.publish({
          type: 'ConversationStatusChanged',
          accountId: conversation.accountId,
          conversationId: conversation.id,
          status: next,
          changedAt: now.toISOString(),
        })
        return
      }
      case 'SEND_REPLY': {
        // This used to stop at the row, marked SENT: the reply showed in the
        // desk and never reached the customer. The row still goes in first;
        // its status then says what the channel really did.
        const body = action.value
        const created = await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            inboxId: conversation.inboxId,
            accountId: conversation.accountId,
            senderType: 'SYSTEM',
            content: body,
            contentType: 'TEXT',
            status: 'PENDING',
          },
        })
        const status = await this.deliverReply(conversation, body, created.id)
        // Only a row still PENDING: a delivery receipt that raced ahead of
        // us (delivered, read, failed) already holds the truer status.
        await this.prisma.message.updateMany({
          where: { id: created.id, status: 'PENDING' },
          data: { status },
        })
        await this.realtime.publish({
          type: 'MessageCreated',
          accountId: conversation.accountId,
          conversationId: conversation.id,
          inboxId: conversation.inboxId,
          messageId: created.id,
          senderType: 'SYSTEM',
          content: body,
          isPrivate: false,
          createdAt: created.createdAt.toISOString(),
        })
        return
      }
      default:
        throw new Error(`Unknown action kind ${(action as { kind: string }).kind}`)
    }
  }

  /**
   * Push a SEND_REPLY to the contact's channel through the channel adapter,
   * like every other outbound path; widget and API read the thread, which is
   * their transport. Never throws: a failed send is reported through the
   * row's status, not by failing the rule run.
   */
  private async deliverReply(
    conversation: Conversation,
    text: string,
    messageId: string,
  ): Promise<'SENT' | 'FAILED'> {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: conversation.inboxId },
      select: { channelType: true },
    })
    const adapter = this.channels.adapterFor(inbox?.channelType)
    if (!adapter) return 'SENT'
    try {
      const to = await adapter.recipientFor(conversation.id)
      if (!to) return 'FAILED'
      const { externalId } = await adapter.sendText(conversation.inboxId, to, text)
      await adapter.stampOutbound(messageId, [externalId])
      return 'SENT'
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[automation] SEND_REPLY delivery failed for ${conversation.id}:`, m)
      return 'FAILED'
    }
  }
}
