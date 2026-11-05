import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Broadcast, Prisma, Role } from '@cosmika/db'
import { BroadcastAudience, CreateBroadcastInput } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { RealtimeService } from '../realtime/realtime.service'
import { WhatsappService } from '../whatsapp/whatsapp.service'
import { errBody } from '../../common/app-error'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']
// v1 processes recipients synchronously in the send request. Cap the fan-out
// so a broadcast can't run unbounded; larger audiences need a worker (future).
const MAX_RECIPIENTS = 1000

/** Substitute {{1}}..{{n}} in a template body (1-indexed). */
function renderBody(body: string, vars: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, idx: string) => {
    const v = vars[Number(idx) - 1]
    return v === undefined ? whole : v
  })
}

@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly realtime: RealtimeService,
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

  /** Build the contactInbox query for an audience on a WhatsApp inbox. */
  private recipientWhere(
    inboxId: string,
    audience: BroadcastAudience,
  ): Prisma.ContactInboxWhereInput {
    return {
      inboxId,
      contact: {
        phoneNumber: { not: null },
        ...(audience.country
          ? {
              additionalAttributes: {
                path: ['country_code'],
                equals: audience.country,
              },
            }
          : {}),
      },
    }
  }

  async previewAudience(
    userId: string,
    accountId: string,
    inboxId: string,
    audience: BroadcastAudience,
  ): Promise<{ count: number }> {
    await this.getMembership(userId, accountId)
    await this.ensureWhatsappInbox(accountId, inboxId)
    const count = await this.prisma.contactInbox.count({
      where: this.recipientWhere(inboxId, audience),
    })
    return { count }
  }

  private async ensureWhatsappInbox(accountId: string, inboxId: string) {
    const inbox = await this.prisma.inbox.findUnique({ where: { id: inboxId } })
    if (!inbox || inbox.accountId !== accountId) throw new NotFoundException()
    if (inbox.channelType !== 'WHATSAPP') {
      throw new BadRequestException(errBody('broadcast_needs_whatsapp', 'Broadcasts require a WhatsApp inbox'))
    }
    return inbox
  }

  async list(userId: string, accountId: string): Promise<Broadcast[]> {
    await this.getMembership(userId, accountId)
    return this.prisma.broadcast.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateBroadcastInput,
  ): Promise<Broadcast> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.ensureWhatsappInbox(accountId, input.inboxId)

    const template = await this.prisma.whatsappTemplate.findUnique({
      where: { id: input.templateId },
    })
    if (!template || template.inboxId !== input.inboxId) {
      throw new NotFoundException('Template not found for this inbox')
    }
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(errBody('template_not_approved', 'Template is not approved'))
    }
    if (input.variables.length !== template.variableCount) {
      throw new BadRequestException(errBody('template_variable_count', `Template expects ${template.variableCount} variable(s), got ${input.variables.length}`))
    }

    return this.prisma.broadcast.create({
      data: {
        accountId,
        inboxId: input.inboxId,
        name: input.name,
        templateId: input.templateId,
        variables: input.variables as Prisma.InputJsonValue,
        audience: input.audience as Prisma.InputJsonValue,
        status: 'DRAFT',
        createdById: userId,
      },
    })
  }

  /**
   * Fan the broadcast out to its audience. Processes recipients synchronously
   * (capped at MAX_RECIPIENTS); each becomes/reuses a conversation and gets
   * the template via the Cloud API. Aggregate counts are persisted.
   */
  async send(
    userId: string,
    accountId: string,
    broadcastId: string,
  ): Promise<Broadcast> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)

    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
    })
    if (!broadcast || broadcast.accountId !== accountId) {
      throw new NotFoundException()
    }
    if (broadcast.status !== 'DRAFT') {
      throw new BadRequestException(errBody('broadcast_already_sent', 'Broadcast has already been sent'))
    }
    const template = await this.prisma.whatsappTemplate.findUnique({
      where: { id: broadcast.templateId },
    })
    if (!template) throw new NotFoundException('Template no longer exists')

    const audience = BroadcastAudience.parse(broadcast.audience)
    const variables = (broadcast.variables as string[]) ?? []
    const rendered = renderBody(template.body, variables)

    const recipients = await this.prisma.contactInbox.findMany({
      where: this.recipientWhere(broadcast.inboxId, audience),
      include: { contact: { select: { id: true, phoneNumber: true } } },
      take: MAX_RECIPIENTS,
    })

    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'SENDING', totalRecipients: recipients.length },
    })

    let sent = 0
    let failed = 0
    for (const ci of recipients) {
      try {
        await this.deliverToRecipient(
          accountId,
          broadcast.inboxId,
          ci.id,
          ci.contactId,
          ci.contact.phoneNumber as string,
          template.name,
          template.language,
          variables,
          rendered,
        )
        sent += 1
      } catch (err) {
        failed += 1
        const m = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[broadcast ${broadcastId}] recipient ${ci.contactId} failed:`, m)
      }
    }

    return this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: failed > 0 && sent === 0 ? 'FAILED' : 'SENT',
        sentCount: sent,
        failedCount: failed,
        sentAt: new Date(),
      },
    })
  }

  /** Reuse-or-create a conversation for the contact, record the outbound
   *  template message, and push it via the Cloud API. */
  private async deliverToRecipient(
    accountId: string,
    inboxId: string,
    contactInboxId: string,
    contactId: string,
    phoneNumber: string,
    templateName: string,
    language: string,
    variables: string[],
    rendered: string,
  ): Promise<void> {
    let conversation = await this.prisma.conversation.findFirst({
      where: { accountId, inboxId, contactId, status: { not: 'RESOLVED' } },
      orderBy: { createdAt: 'desc' },
    })
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        // BROADCAST, and `billableAt` left null: a campaign nobody answers
        // costs the customer nothing on the new-conversations meter. The row
        // is stamped when the contact first replies, in
        // `ConversationsService.ingestExternalInbound`.
        data: {
          accountId,
          inboxId,
          contactId,
          contactInboxId,
          status: 'OPEN',
          origin: 'BROADCAST',
        },
      })
      await this.realtime.publish({
        type: 'ConversationCreated',
        accountId,
        conversationId: conversation.id,
        inboxId,
        contactId,
        createdAt: conversation.createdAt.toISOString(),
      })
    }
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        inboxId,
        accountId,
        senderType: 'USER',
        content: rendered,
        contentType: 'TEXT',
        contentAttributes: {
          whatsappTemplate: { name: templateName, language, variables },
          broadcast: true,
        } as Prisma.InputJsonValue,
        status: 'SENT',
        isPrivate: false,
      },
    })
    const { wamid } = await this.whatsapp.sendTemplate(
      inboxId,
      phoneNumber,
      templateName,
      language,
      variables,
    )
    await this.whatsapp.stampOutbound(msg.id, [wamid])
  }

  toDTO(b: Broadcast) {
    return {
      id: b.id,
      accountId: b.accountId,
      inboxId: b.inboxId,
      name: b.name,
      templateId: b.templateId,
      variables: (b.variables as string[]) ?? [],
      audience: BroadcastAudience.parse(b.audience),
      status: b.status,
      totalRecipients: b.totalRecipients,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      sentAt: b.sentAt?.toISOString() ?? null,
      createdAt: b.createdAt.toISOString(),
    }
  }
}
