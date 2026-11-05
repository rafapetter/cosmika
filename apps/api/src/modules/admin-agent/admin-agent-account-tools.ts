import { Injectable } from '@nestjs/common'
import {
  AddInboxMemberInput,
  AddTeamMemberInput,
  CreateArticleInput,
  CreateAutomationRuleInput,
  CreateBroadcastInput,
  CreateHolidayInput,
  CreateInboxInput,
  CreateSlaPolicyInput,
  CreateTeamInput,
  InviteMemberInput,
  SetWorkingHoursInput,
  UpdateArticleInput,
  UpdateAutomationRuleInput,
  UpdateCannedResponseInput,
  UpdateConversationInput,
  UpdateInboxInput,
  UpdateLabelInput,
  UpdateSlaPolicyInput,
  UpdateTeamInput,
  CreateAgentBotInput,
} from '@cosmika/shared'
import type { ZodTypeAny } from 'zod'

import { PrismaService } from '../../prisma/prisma.service'
import { AccountsService } from '../accounts/accounts.service'
import { AgentBotsService } from '../ai/agent-bots.service'
import { ArticlesService } from '../articles/articles.service'
import { AutomationService } from '../automation/automation.service'
import { BroadcastsService } from '../broadcasts/broadcasts.service'
import { CannedResponsesService } from '../canned-responses/canned-responses.service'
import { ConversationsService } from '../conversations/conversations.service'
import { InboxesService } from '../inboxes/inboxes.service'
import { LabelsService } from '../labels/labels.service'
import { SlaService } from '../sla/sla.service'
import { SupportTicketsService } from '../support-tickets/support-tickets.service'
import { TeamsService } from '../teams/teams.service'
import { WorkingHoursService } from '../working-hours/working-hours.service'

import type { AdminToolContext, AdminToolDef, AdminToolResult } from './admin-agent-tools'

/**
 * Everything else an administrator can do in their account, for the admin
 * assistant: inboxes and hours, teams, members, automations, knowledge base,
 * SLA, conversations and tickets, broadcasts, labels, canned responses, bots.
 *
 * Every tool calls the SAME service the settings screens call, as the
 * administrator who invoked the assistant. So role checks, validation, the
 * audit trail and side effects (article embeddings, realtime events, the
 * last-administrator guard) are the product's own, not a second copy.
 *
 * Deliberately absent (Rafael, 2026-09-10): webhooks and API keys. The same
 * reach through a side door is closed too: API inboxes are created without a
 * webhook URL, inbox updates cannot touch channel config, and bots are
 * created without custom (HTTP) tools. Channels that need credentials
 * (WhatsApp, e-mail) are set up on the settings screen: the assistant never
 * sees or receives a secret.
 */
@Injectable()
export class AdminAgentAccountTools {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inboxes: InboxesService,
    private readonly hours: WorkingHoursService,
    private readonly teams: TeamsService,
    private readonly accounts: AccountsService,
    private readonly automations: AutomationService,
    private readonly articles: ArticlesService,
    private readonly sla: SlaService,
    private readonly conversations: ConversationsService,
    private readonly tickets: SupportTicketsService,
    private readonly labels: LabelsService,
    private readonly canned: CannedResponsesService,
    private readonly broadcasts: BroadcastsService,
    private readonly bots: AgentBotsService,
  ) {}

  all(): AdminToolDef[] {
    return [
      // inboxes and hours
      this.tool('create_inbox', "Create a web-widget or API inbox. WhatsApp and e-mail inboxes need credentials, so they are set up on the Inboxes settings screen, so say that instead. API inboxes are created without a webhook URL.", {
        name: str(), channelType: { type: 'string', enum: ['WEB_WIDGET', 'API'] },
        websiteName: str('Widget only: the site name shown in the widget.'), websiteUrl: str(), primaryColor: str('#rrggbb'),
        greetingMessage: str(), outOfOfficeMessage: str(), csatEnabled: bool(),
      }, ['name', 'channelType'], true, async (i, c) => {
        if (i.channelType !== 'WEB_WIDGET' && i.channelType !== 'API') {
          return { error: 'only web-widget and API inboxes can be created here; WhatsApp and e-mail need credentials, so they are set up on the Inboxes settings screen' }
        }
        const channelConfig = i.channelType === 'WEB_WIDGET'
          ? pick({ websiteName: i.websiteName ?? i.name, websiteUrl: i.websiteUrl, primaryColor: i.primaryColor })
          : {}
        const input = parse(CreateInboxInput, { ...pick({ name: i.name, channelType: i.channelType, greetingMessage: i.greetingMessage, outOfOfficeMessage: i.outOfOfficeMessage, csatEnabled: i.csatEnabled }), greetingEnabled: Boolean(i.greetingMessage), channelConfig })
        const inbox = await this.inboxes.create(c.userId, c.accountId, input as never)
        return { created: inbox.id, name: inbox.name, channelType: inbox.channelType }
      }),
      this.tool('update_inbox', "Change an inbox's name, greeting, out-of-office message, auto-resolve time, CSAT survey, SLA policy or attached AI bot. Channel credentials and webhooks are not editable here.", {
        inboxId: str(), name: str(), greetingEnabled: bool(), greetingMessage: str(), outOfOfficeMessage: str(),
        autoResolveMinutes: int('Minutes without a message before a conversation closes on its own: 60 to 10080 (1 hour to 7 days). A contact who writes after that starts a new conversation.'), csatEnabled: bool(), slaPolicyId: nullableStr(), agentBotId: nullableStr(),
      }, ['inboxId'], true, async (i, c) => {
        // An explicit list, not "everything else": channelConfig is where
        // credentials and the webhook URL live, and must never pass through.
        const input = parse(UpdateInboxInput, pick({
          name: i.name, greetingEnabled: i.greetingEnabled, greetingMessage: i.greetingMessage,
          outOfOfficeMessage: i.outOfOfficeMessage, autoResolveMinutes: i.autoResolveMinutes,
          csatEnabled: i.csatEnabled, slaPolicyId: i.slaPolicyId, agentBotId: i.agentBotId,
        }))
        const inboxId = i.inboxId
        const { inbox } = await this.inboxes.update(c.userId, c.accountId, String(inboxId), input as never)
        return { updated: inbox.id, name: inbox.name }
      }),
      this.tool('add_inbox_member', 'Give a member access to an inbox (user ids from list_members).', { inboxId: str(), userId: str() }, ['inboxId', 'userId'], true, async (i, c) => {
        await this.inboxes.addMember(c.userId, c.accountId, String(i.inboxId), parse(AddInboxMemberInput, { userId: i.userId }) as never)
        return { inbox: i.inboxId, added: i.userId }
      }),
      this.tool('remove_inbox_member', "Remove a member's access to an inbox.", { inboxId: str(), userId: str() }, ['inboxId', 'userId'], true, async (i, c) => {
        await this.inboxes.removeMember(c.userId, c.accountId, String(i.inboxId), String(i.userId))
        return { inbox: i.inboxId, removed: i.userId }
      }),
      this.tool('get_working_hours', "An inbox's weekly working hours and the account's holidays.", { inboxId: str() }, ['inboxId'], false, async (i, c) => {
        const [week, holidays] = await Promise.all([
          this.hours.listForInbox(c.userId, c.accountId, String(i.inboxId)),
          this.hours.listHolidays(c.userId, c.accountId),
        ])
        return { inbox: i.inboxId, hours: week, holidays }
      }),
      this.tool('set_working_hours', "Replace an inbox's weekly working hours, one entry per day. dayOfWeek 0 = Sunday to 6 = Saturday; opening and closing as hour (0-23) and minute (0-59); closedAllDay true for a day off.", {
        inboxId: str(),
        hours: { type: 'array', maxItems: 7, items: { type: 'object', properties: { dayOfWeek: int('0-6'), closedAllDay: bool(), openHour: int('0-23'), openMinute: int('0-59'), closeHour: int('0-23'), closeMinute: int('0-59') }, required: ['dayOfWeek'] } },
      }, ['inboxId', 'hours'], true, async (i, c) => {
        const rows = await this.hours.setForInbox(c.userId, c.accountId, String(i.inboxId), parse(SetWorkingHoursInput, { hours: i.hours }) as never)
        return { inbox: i.inboxId, days: rows.length }
      }),
      this.tool('add_holiday', 'Add an account-wide holiday (date YYYY-MM-DD); inboxes treat it as closed.', { name: str(), date: str('YYYY-MM-DD') }, ['name', 'date'], true, async (i, c) => {
        const h = await this.hours.createHoliday(c.userId, c.accountId, parse(CreateHolidayInput, { name: i.name, date: i.date }) as never)
        return { created: h.id, name: h.name }
      }),
      this.tool('delete_holiday', 'Remove a holiday (ids from get_working_hours).', { holidayId: str() }, ['holidayId'], true, async (i, c) => {
        await this.hours.deleteHoliday(c.userId, c.accountId, String(i.holidayId))
        return { deleted: i.holidayId }
      }),

      // teams
      this.tool('create_team', 'Create a team, to group members by area or escalation level.', { name: str(), description: str() }, ['name'], true, async (i, c) => {
        const t = await this.teams.create(c.userId, c.accountId, parse(CreateTeamInput, pick({ name: i.name, description: i.description })) as never)
        return { created: t.id, name: t.name }
      }),
      this.tool('update_team', "Rename a team or change its description.", { teamId: str(), name: str(), description: nullableStr() }, ['teamId'], true, async (i, c) => {
        const t = await this.teams.update(c.userId, c.accountId, String(i.teamId), parse(UpdateTeamInput, pick({ name: i.name, description: i.description })) as never)
        return { updated: t.id, name: t.name }
      }),
      this.tool('delete_team', 'Delete a team. Conversations assigned to it are unassigned from the team.', { teamId: str() }, ['teamId'], true, async (i, c) => {
        await this.teams.remove(c.userId, c.accountId, String(i.teamId))
        return { deleted: i.teamId }
      }),
      this.tool('add_team_member', 'Add a member to a team (user ids from list_members).', { teamId: str(), userId: str() }, ['teamId', 'userId'], true, async (i, c) => {
        await this.teams.addMember(c.userId, c.accountId, String(i.teamId), parse(AddTeamMemberInput, { userId: i.userId }) as never)
        return { team: i.teamId, added: i.userId }
      }),
      this.tool('remove_team_member', 'Remove a member from a team.', { teamId: str(), userId: str() }, ['teamId', 'userId'], true, async (i, c) => {
        await this.teams.removeMember(c.userId, c.accountId, String(i.teamId), String(i.userId))
        return { team: i.teamId, removed: i.userId }
      }),

      // members: always approved, whatever the account setting (access to the account)
      this.tool('invite_member', 'Invite someone to the account by e-mail with a role. They receive an e-mail to set their password. Always needs the administrator\'s approval.', {
        email: str(), fullName: str(), role: { type: 'string', enum: ['ADMINISTRATOR', 'SUPERVISOR', 'AGENT'] },
      }, ['email', 'role'], true, async (i, c) => {
        const m = await this.accounts.inviteMember(c.accountId, parse(InviteMemberInput, pick({ email: i.email, fullName: i.fullName, role: i.role })) as never)
        return { invited: m.user.email, role: m.role }
      }, true),
      this.tool('deactivate_member', 'Remove a member from the account (their history stays). The last administrator cannot be removed. Always needs approval.', { userId: str() }, ['userId'], true, async (i, c) => {
        await this.accounts.removeMember(c.accountId, String(i.userId))
        return { deactivated: i.userId }
      }, true),

      // automations
      this.tool('list_automations', 'Every automation rule with its trigger, conditions, actions and whether it is active.', {}, [], false, async (_i, c) => {
        const rules = await this.automations.list(c.userId, c.accountId)
        return { automations: rules.map((r) => ({ id: r.id, name: r.name, isActive: r.isActive, triggerEvent: r.triggerEvent, conditions: r.conditions, actions: r.actions })) }
      }),
      this.tool('create_automation', 'Create an automation rule. triggerEvent: CONVERSATION_CREATED | MESSAGE_CREATED | CONVERSATION_UPDATED. Conditions {field, op, value} on INBOX_ID, PRIORITY, STATUS, CONTENT_CONTAINS, CONTACT_EMAIL_DOMAIN, TAG_INCLUDES, OUTSIDE_WORKING_HOURS, IS_FIRST_MESSAGE; ops equals | not_equals | in | contains | is_true. Actions {kind, value}: ASSIGN_TEAM (teamId), ASSIGN_USER (userId), SET_PRIORITY (LOW|NORMAL|HIGH|URGENT), ADD_TAG, SET_STATUS (OPEN|PENDING|RESOLVED), SEND_REPLY (message; this one reaches customers).', {
        name: str(), description: str(), triggerEvent: str(), isActive: bool(),
        conditions: { type: 'array', items: { type: 'object' } }, actions: { type: 'array', items: { type: 'object' } }, runOncePerConversation: bool(),
      }, ['name', 'triggerEvent', 'actions'], true, async (i, c) => {
        const r = await this.automations.create(c.userId, c.accountId, parse(CreateAutomationRuleInput, pick(i)) as never)
        return { created: r.id, name: r.name, isActive: r.isActive }
      }),
      this.tool('update_automation', 'Change an automation rule, including switching it on or off (isActive). Fields as in create_automation.', {
        automationId: str(), name: str(), description: nullableStr(), triggerEvent: str(), isActive: bool(),
        conditions: { type: 'array', items: { type: 'object' } }, actions: { type: 'array', items: { type: 'object' } }, runOncePerConversation: bool(),
      }, ['automationId'], true, async (i, c) => {
        const { automationId, ...rest } = i
        const r = await this.automations.update(c.userId, c.accountId, String(automationId), parse(UpdateAutomationRuleInput, pick(rest)) as never)
        return { updated: r.id, name: r.name, isActive: r.isActive }
      }),
      this.tool('delete_automation', 'Delete an automation rule.', { automationId: str() }, ['automationId'], true, async (i, c) => {
        await this.automations.remove(c.userId, c.accountId, String(i.automationId))
        return { deleted: i.automationId }
      }),

      // knowledge base
      this.tool('get_article', "A knowledge-base article's full text, to read before editing it.", { articleId: str() }, ['articleId'], false, async (i, c) => {
        const a = await this.articles.get(c.userId, c.accountId, String(i.articleId))
        return { id: a.id, title: a.title, slug: a.slug, status: a.status, tags: a.tags, content: a.content }
      }),
      this.tool('create_article', 'Write a knowledge-base article in Markdown. status PUBLISHED makes the AI agent use it to answer customers; DRAFT keeps it hidden. slug: lowercase letters, digits and hyphens.', {
        title: str(), slug: str(), content: str('Markdown'), status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] }, tags: { type: 'array', items: { type: 'string' } },
      }, ['title', 'slug', 'content'], true, async (i, c) => {
        const a = await this.articles.create(c.userId, c.accountId, parse(CreateArticleInput, pick(i)) as never)
        return { created: a.id, title: a.title, status: a.status }
      }),
      this.tool('update_article', 'Edit a knowledge-base article (send only what changes), or publish / unpublish it with status.', {
        articleId: str(), title: str(), slug: str(), content: str(), status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] }, tags: { type: 'array', items: { type: 'string' } },
      }, ['articleId'], true, async (i, c) => {
        const { articleId, ...rest } = i
        const a = await this.articles.update(c.userId, c.accountId, String(articleId), parse(UpdateArticleInput, pick(rest)) as never)
        return { updated: a.id, title: a.title, status: a.status }
      }),
      this.tool('delete_article', 'Delete a knowledge-base article.', { articleId: str() }, ['articleId'], true, async (i, c) => {
        await this.articles.remove(c.userId, c.accountId, String(i.articleId))
        return { deleted: i.articleId }
      }),

      // SLA
      this.tool('list_sla_policies', 'Every SLA policy with its first-response and resolution targets per priority (minutes).', {}, [], false, async (_i, c) => {
        return { policies: await this.sla.list(c.userId, c.accountId) }
      }),
      this.tool('create_sla_policy', 'Create an SLA policy: targets in minutes for first response and resolution, per priority (Low, Normal, High, Urgent). Attach it to an inbox with update_inbox.slaPolicyId.', slaFields(false), ['name'], true, async (i, c) => {
        const p = await this.sla.create(c.userId, c.accountId, parse(CreateSlaPolicyInput, pick(i)) as never)
        return { created: p.id, name: p.name }
      }),
      this.tool('update_sla_policy', 'Change an SLA policy (send only what changes).', slaFields(true), ['slaPolicyId'], true, async (i, c) => {
        const { slaPolicyId, ...rest } = i
        const p = await this.sla.update(c.userId, c.accountId, String(slaPolicyId), parse(UpdateSlaPolicyInput, pick(rest)) as never)
        return { updated: p.id, name: p.name }
      }),
      this.tool('delete_sla_policy', 'Delete an SLA policy.', { slaPolicyId: str() }, ['slaPolicyId'], true, async (i, c) => {
        await this.sla.remove(c.userId, c.accountId, String(i.slaPolicyId))
        return { deleted: i.slaPolicyId }
      }),

      // conversations and tickets
      this.tool('update_conversation', 'Act on a conversation: status (OPEN | PENDING | RESOLVED), priority (LOW | NORMAL | HIGH | URGENT), assignee (userId, or null to unassign) and team. Identify it by id or by its number (e.g. 8732). A RESOLVED conversation is closed for good: it cannot go back to OPEN or PENDING, and reaching that contact again means a new conversation.', {
        conversation: str('Conversation id or number'), status: str(), priority: str(), assigneeId: nullableStr(), teamId: nullableStr(),
      }, ['conversation'], true, async (i, c) => {
        const id = await this.conversationId(c.accountId, String(i.conversation))
        const conv = await this.conversations.update(c.userId, c.accountId, id, parse(UpdateConversationInput, pick({
          status: i.status, priority: i.priority, assigneeId: i.assigneeId, teamId: i.teamId,
        })) as never)
        return { conversation: conv.displayId, status: conv.status, priority: conv.priority, assigneeId: conv.assigneeId, teamId: conv.teamId }
      }),
      this.tool('label_conversation', 'Add or remove a label on a conversation (label ids from list_labels).', {
        conversation: str('Conversation id or number'), labelId: str(), remove: bool('true to remove instead of add'),
      }, ['conversation', 'labelId'], true, async (i, c) => {
        const id = await this.conversationId(c.accountId, String(i.conversation))
        if (i.remove === true) await this.labels.removeFromConversation(c.userId, c.accountId, id, String(i.labelId))
        else await this.labels.applyToConversation(c.userId, c.accountId, id, String(i.labelId))
        return { conversation: i.conversation, label: i.labelId, action: i.remove === true ? 'removed' : 'added' }
      }),
      this.tool('update_ticket', "Change a support ticket's status, priority or category (ticket ids from list_tickets).", {
        ticketId: str(), status: str(), priority: str(), category: nullableStr(),
      }, ['ticketId'], true, async (i, c) => {
        const t = await this.tickets.updateForAccount(c.accountId, String(i.ticketId), pick({ status: i.status, priority: i.priority, category: i.category }) as never)
        if (!t) return { error: `no ticket "${String(i.ticketId)}" in this account` }
        return { ticket: t.number, status: t.status, priority: t.priority }
      }),

      // broadcasts: sending always needs approval (mass message, costs money)
      this.tool('list_broadcast_templates', 'Approved WhatsApp templates an inbox can broadcast, with their variables.', { inboxId: str() }, ['inboxId'], false, async (i, c) => {
        const rows = await this.prisma.whatsappTemplate.findMany({
          where: { inboxId: String(i.inboxId), status: 'APPROVED', inbox: { accountId: c.accountId } },
          select: { id: true, name: true, language: true, category: true, body: true },
          orderBy: { name: 'asc' },
        })
        return { templates: rows }
      }),
      this.tool('create_broadcast', 'Prepare a WhatsApp broadcast (not sent yet) and see how many contacts it would reach. Audience: optional country code (e.g. BR). Send it with send_broadcast.', {
        name: str(), inboxId: str(), templateId: str(), variables: { type: 'array', items: { type: 'string' } }, country: str('ISO code, e.g. BR'),
      }, ['name', 'inboxId', 'templateId'], true, async (i, c) => {
        const input = parse(CreateBroadcastInput, pick({ name: i.name, inboxId: i.inboxId, templateId: i.templateId, variables: i.variables, audience: pick({ country: i.country }) })) as { inboxId: string; audience: Record<string, unknown> }
        const b = await this.broadcasts.create(c.userId, c.accountId, input as never)
        const reach = await this.broadcasts.previewAudience(c.userId, c.accountId, input.inboxId, input.audience as never)
        return { created: b.id, name: b.name, wouldReach: reach.count, sent: false }
      }),
      this.tool('send_broadcast', 'Send a prepared broadcast to its whole audience. THIS MESSAGES REAL CUSTOMERS AND COSTS MONEY per message. Always needs approval.', { broadcastId: str() }, ['broadcastId'], true, async (i, c) => {
        const b = await this.broadcasts.send(c.userId, c.accountId, String(i.broadcastId))
        return { broadcast: b.id, status: b.status }
      }, true),

      // labels and canned responses
      this.tool('update_label', "Rename a label or change its color.", { labelId: str(), title: str(), color: str('#rrggbb') }, ['labelId'], true, async (i, c) => {
        const l = await this.labels.update(c.userId, c.accountId, String(i.labelId), parse(UpdateLabelInput, pick({ title: i.title, color: i.color })) as never)
        return { updated: l.id, title: l.title }
      }),
      this.tool('delete_label', 'Delete a label (it is removed from conversations that had it).', { labelId: str() }, ['labelId'], true, async (i, c) => {
        await this.labels.remove(c.userId, c.accountId, String(i.labelId))
        return { deleted: i.labelId }
      }),
      this.tool('update_canned_response', "Change a canned response's shortcode or text.", { cannedResponseId: str(), shortcode: str(), content: str() }, ['cannedResponseId'], true, async (i, c) => {
        const r = await this.canned.update(c.userId, c.accountId, String(i.cannedResponseId), parse(UpdateCannedResponseInput, pick({ shortcode: i.shortcode, content: i.content })) as never)
        return { updated: r.id, shortcode: r.shortcode }
      }),
      this.tool('delete_canned_response', 'Delete a canned response.', { cannedResponseId: str() }, ['cannedResponseId'], true, async (i, c) => {
        await this.canned.remove(c.userId, c.accountId, String(i.cannedResponseId))
        return { deleted: i.cannedResponseId }
      }),

      // bots
      this.tool('create_agent_bot', 'Create an AI agent bot with its instructions (systemPrompt). Attach it to an inbox with update_inbox.agentBotId. Custom HTTP tools are not available here.', {
        name: str(), description: str(), systemPrompt: str(), model: { type: 'string', enum: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5.6-luna', 'deepseek/deepseek-v4.1-flash'] }, temperature: num('0 to 1'), fallbackToHuman: bool(), isActive: bool(),
      }, ['name', 'systemPrompt'], true, async (i, c) => {
        // Explicit fields: customTools are HTTP calls, i.e. webhooks by
        // another name, and stay off the assistant's reach.
        const b = await this.bots.create(c.userId, c.accountId, parse(CreateAgentBotInput, pick({
          name: i.name, description: i.description, systemPrompt: i.systemPrompt, model: i.model,
          temperature: i.temperature, fallbackToHuman: i.fallbackToHuman, isActive: i.isActive,
        })) as never)
        return { created: b.id, name: b.name, model: b.model }
      }),
    ]
  }

  byName(name: string): AdminToolDef | undefined {
    return this.all().find((t) => t.name === name)
  }

  /** A conversation by id or by the number people see (#8732). */
  private async conversationId(accountId: string, ref: string): Promise<string> {
    const n = Number(ref.replace(/^#/, ''))
    const conv = await this.prisma.conversation.findFirst({
      where: Number.isInteger(n) && n > 0 ? { accountId, displayId: n } : { accountId, id: ref },
      select: { id: true },
    })
    if (!conv) throw new Error(`no conversation "${ref}" in this account`)
    return conv.id
  }

  private tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    critical: boolean,
    run: (input: Record<string, unknown>, ctx: AdminToolContext) => Promise<Record<string, unknown>>,
    alwaysApprove = false,
  ): AdminToolDef {
    return {
      name,
      description,
      input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
      critical,
      ...(alwaysApprove ? { alwaysApprove: true } : {}),
      handler: async (input, ctx): Promise<AdminToolResult> => {
        const started = Date.now()
        const output = await run(input, ctx)
        return { output, durationMs: Date.now() - started }
      },
    }
  }
}

// ─── schema shorthands ─────────────────────────────────────────────────

const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const nullableStr = () => ({ type: ['string', 'null'] })
const bool = (description?: string) => ({ type: 'boolean', ...(description ? { description } : {}) })
const int = (description?: string) => ({ type: 'integer', ...(description ? { description } : {}) })
const num = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) })

function slaFields(update: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = update ? { slaPolicyId: str() } : {}
  out.name = str()
  for (const kind of ['firstResponse', 'resolution']) {
    for (const p of ['Low', 'Normal', 'High', 'Urgent']) out[`${kind}${p}Minutes`] = int()
  }
  return out
}

/** Drop undefined keys, so optional fields the model left out stay unset. */
function pick(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

/**
 * Validate with the schema the settings screen uses. A bad input becomes an
 * error the model can read and fix, not a crash.
 */
function parse(schema: ZodTypeAny, value: unknown): unknown {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  throw new Error(
    `invalid input: ${r.error.issues.slice(0, 4).map((x) => `${x.path.join('.') || 'input'}: ${x.message}`).join('; ')}`,
  )
}
