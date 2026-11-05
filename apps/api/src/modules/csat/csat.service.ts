import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as Sentry from '@sentry/node'
import type { CsatSurvey, Prisma } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { EmailService } from '../email/email.service'
import { RealtimeService } from '../realtime/realtime.service'
import { ChannelsService } from '../channels/channels.service'
import { errBody } from '../../common/app-error'

/**
 * Ceiling on survey messages one account may send per hour.
 *
 * Today only the single-conversation resolve path sends a survey, so this
 * never fires in normal use — organic resolves nowhere near approach it. It
 * exists because three separate code paths set a conversation to RESOLVED
 * (manual, bulk, auto-resolve, automation rules) and only one of them sends.
 * That asymmetry looks like an oversight, so sooner or later someone will
 * "fix" it — and auto-resolve sweeps stale conversations in batches on a
 * schedule. The difference between a bug and an incident there is whether a
 * cap existed beforehand.
 */
const DEFAULT_HOURLY_SEND_CAP = 60

@Injectable()
export class CsatService {
  private readonly logger = new Logger(CsatService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => ChannelsService))
    private readonly channels: ChannelsService,
    private readonly emails: EmailService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The survey prompt, in the account's language.
   *
   * This is the only string this service sends to a customer, and it goes to
   * a real phone. Hardcoding English on a pt-BR support line is not a
   * cosmetic bug — it is the first thing a Brazilian customer sees after
   * their conversation ends. The API has no i18n framework, and pulling one
   * in for three strings would be more machinery than the problem deserves.
   */
  private promptText(locale: string, url: string, type: 'CSAT' | 'NPS' = 'CSAT'): string {
    if (type === 'NPS') {
      switch (locale) {
        case 'pt-BR':
          return `Obrigado por falar com a gente! De 0 a 10, quanto você recomendaria o nosso atendimento a um amigo? ${url}`
        case 'es':
          return `¡Gracias por hablar con nosotros! Del 0 al 10, ¿cuánto recomendarías nuestra atención a un amigo? ${url}`
        default:
          return `Thanks for chatting with us! From 0 to 10, how likely are you to recommend us to a friend? ${url}`
      }
    }
    switch (locale) {
      case 'pt-BR':
        return `Obrigado por falar com a gente! Como foi o atendimento? ${url}`
      case 'es':
        return `¡Gracias por hablar con nosotros! ¿Cómo estuvo la atención? ${url}`
      default:
        return `Thanks for chatting with us! How did we do? ${url}`
    }
  }

  private promptSubject(locale: string): string {
    switch (locale) {
      case 'pt-BR':
        return 'Como foi o atendimento?'
      case 'es':
        return '¿Cómo estuvo la atención?'
      default:
        return 'How did we do?'
    }
  }

  private surveyUrl(token: string): string {
    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3100'
    return `${base.replace(/\/$/, '')}/csat/${token}`
  }

  /**
   * Called when a conversation transitions to RESOLVED. Creates a survey row
   * (idempotent — unique on conversationId) if the inbox has csatEnabled set
   * in its channelConfig.
   */
  async maybeCreateForResolvedConversation(conversationId: string): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        inbox: true,
        contact: true,
        account: { select: { defaultLocale: true, surveyType: true } },
      },
    })
    if (!conv) return
    if (conv.inbox.csatEnabled !== true) return

    const existing = await this.prisma.csatSurvey.findUnique({
      where: { conversationId },
    })
    if (existing) return

    const survey = await this.prisma.csatSurvey.create({
      data: {
        accountId: conv.accountId,
        conversationId,
        inboxId: conv.inboxId,
        assignedAgentId: conv.assigneeId,
        teamId: conv.teamId,
        type: conv.account.surveyType,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    })

    // Try to push the survey link to the contact. WhatsApp is the only
    // channel we know how to deliver on today. Other channels (widget /
    // email) leave the survey accessible only via the public URL — operators
    // can share it manually if needed.
    // The row is always created — it is the record, and it costs nobody
    // anything. Only the outbound message is capped, because that is the part
    // that reaches a real phone.
    const cap = Number(
      this.config.get<string>('CSAT_HOURLY_SEND_CAP') ?? DEFAULT_HOURLY_SEND_CAP,
    )
    const sentLastHour = await this.prisma.csatSurvey.count({
      where: {
        accountId: conv.accountId,
        promptedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    })
    if (sentLastHour > cap) {
      this.logger.warn(
        `CSAT send skipped for ${conversationId}: account ${conv.accountId} has ` +
          `${sentLastHour} surveys in the last hour, over the cap of ${cap}. ` +
          `The survey row exists and is reachable by URL.`,
      )
      return
    }

    const url = this.surveyUrl(survey.token)
    const text = this.promptText(conv.account.defaultLocale, url, survey.type)

    // Channel-aware delivery (F9). Every successful delivery also mirrors
    // the prompt into the transcript so agents can see it went out.
    const adapter = this.channels.adapterFor(conv.inbox.channelType)
    if (adapter) {
      const csatTo = await adapter.recipientFor(conversationId)
      if (!csatTo) return
      try {
        const { externalId } = await adapter.sendText(conv.inboxId, csatTo, text)
        // The provider id makes delivery receipts land on this row like any
        // other outbound.
        await this.mirrorPrompt(conv, text, externalId)
      } catch (err) {
        this.logger.error(
          `CSAT ${conv.inbox.channelType} send failed for ${conversationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        Sentry.captureException(err)
      }
      return
    }

    if (conv.inbox.channelType === 'EMAIL') {
      const to = conv.contact?.email
      if (!to) return
      try {
        const sent = await this.emails.send(
          to,
          this.promptSubject(conv.account.defaultLocale),
          text,
        )
        if (sent) await this.mirrorPrompt(conv, text, null)
      } catch (err) {
        this.logger.error(
          `CSAT email send failed for ${conversationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        Sentry.captureException(err)
      }
      return
    }

    // WEB_WIDGET / API: the thread IS the transport — the in-thread message
    // is the delivery, and the realtime event makes an open widget show it
    // immediately.
    await this.mirrorPrompt(conv, text, null)
  }

  /** The transcript copy of the survey prompt (and, for widget/API, the
      delivery itself). */
  private async mirrorPrompt(
    conv: { id: string; accountId: string; inboxId: string },
    text: string,
    wamid: string | null,
  ): Promise<void> {
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        inboxId: conv.inboxId,
        accountId: conv.accountId,
        senderType: 'SYSTEM',
        content: text,
        contentType: 'TEXT',
        isPrivate: false,
        status: 'SENT',
        ...(wamid
          ? {
              externalSourceId: wamid,
              contentAttributes: { wamids: [wamid] },
            }
          : {}),
      },
    })
    await this.realtime.publish({
      type: 'MessageCreated',
      accountId: conv.accountId,
      conversationId: conv.id,
      inboxId: conv.inboxId,
      messageId: msg.id,
      senderType: 'SYSTEM',
      content: text,
      isPrivate: false,
      createdAt: msg.createdAt.toISOString(),
    })
  }

  /**
   * Look up survey by public token. Returns survey + a small public summary
   * to render on the response page.
   */
  async getByToken(token: string) {
    const survey = await this.prisma.csatSurvey.findUnique({
      where: { token },
      include: {
        account: { select: { name: true } },
        conversation: { select: { displayId: true } },
      },
    })
    if (!survey) throw new NotFoundException('Survey not found')
    return survey
  }

  async submitByToken(
    token: string,
    input: { rating: number; comment?: string },
  ): Promise<CsatSurvey> {
    const survey = await this.prisma.csatSurvey.findUnique({
      where: { token },
    })
    if (!survey) throw new NotFoundException('Survey not found')
    if (survey.respondedAt) {
      throw new BadRequestException(errBody('csat_already_submitted', 'Survey already submitted'))
    }
    if (survey.expiresAt && survey.expiresAt < new Date()) {
      throw new BadRequestException(errBody('csat_link_expired', 'Survey link has expired'))
    }
    const [min, max] = survey.type === 'NPS' ? [0, 10] : [1, 5]
    if (input.rating < min || input.rating > max) {
      throw new BadRequestException(errBody('invalid_input', `Rating must be ${min} to ${max}`))
    }
    return this.prisma.csatSurvey.update({
      where: { id: survey.id },
      data: {
        respondedAt: new Date(),
        rating: input.rating,
        comment: input.comment ?? null,
      },
    })
  }

  /**
   * Aggregate stats for an account. Filters by inbox / agent / time range.
   */
  async stats(
    userId: string,
    accountId: string,
    filter: {
      inboxId?: string
      agentId?: string
      from?: string
      to?: string
    },
  ) {
    await this.assertMember(userId, accountId)
    const where: Prisma.CsatSurveyWhereInput = {
      accountId,
      // NPS rows (0..10) live in the same table; they have their own report.
      type: 'CSAT',
      ...(filter.inboxId ? { inboxId: filter.inboxId } : {}),
      ...(filter.agentId ? { assignedAgentId: filter.agentId } : {}),
      ...(filter.from || filter.to
        ? {
            promptedAt: {
              ...(filter.from ? { gte: new Date(filter.from) } : {}),
              ...(filter.to ? { lte: new Date(filter.to) } : {}),
            },
          }
        : {}),
    }

    const [totalPrompted, responses] = await Promise.all([
      this.prisma.csatSurvey.count({ where }),
      this.prisma.csatSurvey.findMany({
        where: { ...where, respondedAt: { not: null } },
        select: {
          rating: true,
          inboxId: true,
          assignedAgentId: true,
        },
      }),
    ])

    // Resolve agent names in one query.
    const agentIds = Array.from(
      new Set(responses.map((r) => r.assignedAgentId).filter(Boolean) as string[]),
    )
    const inboxIds = Array.from(new Set(responses.map((r) => r.inboxId)))
    const [agents, inboxes] = await Promise.all([
      agentIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, fullName: true, email: true },
          })
        : Promise.resolve([]),
      inboxIds.length
        ? this.prisma.inbox.findMany({
            where: { id: { in: inboxIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ])
    const agentMap = new Map(agents.map((a) => [a.id, a]))
    const inboxMap = new Map(inboxes.map((i) => [i.id, i]))

    const byInboxMap = new Map<
      string,
      { label: string; ratings: number[] }
    >()
    const byAgentMap = new Map<
      string,
      { label: string; ratings: number[] }
    >()

    for (const r of responses) {
      if (!r.rating) continue
      const inboxLabel = inboxMap.get(r.inboxId)?.name ?? r.inboxId
      const ib = byInboxMap.get(r.inboxId) ?? {
        label: inboxLabel,
        ratings: [] as number[],
      }
      ib.ratings.push(r.rating)
      byInboxMap.set(r.inboxId, ib)

      if (r.assignedAgentId) {
        const a = agentMap.get(r.assignedAgentId)
        const label = a ? a.fullName ?? a.email : r.assignedAgentId
        const bucket = byAgentMap.get(r.assignedAgentId) ?? {
          label,
          ratings: [] as number[],
        }
        bucket.ratings.push(r.rating)
        byAgentMap.set(r.assignedAgentId, bucket)
      }
    }

    const allRatings = responses
      .map((r) => r.rating)
      .filter((r): r is number => r !== null)
    const avg = (arr: number[]) =>
      arr.length === 0
        ? null
        : Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100

    return {
      totalPrompted,
      totalResponded: responses.length,
      averageRating: avg(allRatings),
      byInbox: Array.from(byInboxMap.entries()).map(([key, v]) => ({
        key,
        label: v.label,
        responses: v.ratings.length,
        averageRating: avg(v.ratings),
      })),
      byAgent: Array.from(byAgentMap.entries()).map(([key, v]) => ({
        key,
        label: v.label,
        responses: v.ratings.length,
        averageRating: avg(v.ratings),
      })),
    }
  }

  private async assertMember(userId: string, accountId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    return m
  }

  toDTO(s: CsatSurvey) {
    return {
      id: s.id,
      accountId: s.accountId,
      conversationId: s.conversationId,
      inboxId: s.inboxId,
      token: s.token,
      assignedAgentId: s.assignedAgentId,
      promptedAt: s.promptedAt.toISOString(),
      respondedAt: s.respondedAt ? s.respondedAt.toISOString() : null,
      type: s.type,
      rating: s.rating,
      comment: s.comment,
    }
  }
}
