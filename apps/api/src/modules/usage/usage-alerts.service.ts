import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import * as Sentry from '@sentry/node'

import { PrismaService } from '../../prisma/prisma.service'
import { EmailService } from '../email/email.service'

import { billingMonthOf } from './billing-month'
import { UsageService, type UsageEvaluation } from './usage.service'

/** The alerts, worst first. Only the first one that applies is sent. */
export const ALERT_KINDS = [
  'ai_cap',
  'ai_100',
  'plan_100',
  'ai_80',
  'plan_90',
] as const

export type AlertKind = (typeof ALERT_KINDS)[number]

/**
 * Which alert an account has earned right now, or null for none.
 *
 * Only the highest one that applies is returned, which is how Nebula behaves:
 * an account that crosses 90% and 100% in the same hour gets one email about
 * the thing that actually changed, not two.
 */
export function alertFor(usage: UsageEvaluation): AlertKind | null {
  const ai = usage.ai
  const aiCounted = ai.included !== null
  // The customer's own ceiling is spent: they asked to be stopped here, so
  // this outranks everything else.
  if (
    ai.capBrl !== null &&
    ai.overagePriceBrl !== null &&
    ai.overConversations >= Math.floor(ai.capBrl / ai.overagePriceBrl)
  ) {
    return 'ai_cap'
  }
  if (aiCounted && ai.conversations >= (ai.included as number)) return 'ai_100'
  if (usage.meters.some((m) => m.absoluteLimit !== null && m.used >= m.absoluteLimit)) {
    return 'plan_100'
  }
  if (aiCounted && ai.conversations >= (ai.included as number) * 0.8) return 'ai_80'
  if (usage.warning.length > 0) return 'plan_90'
  return null
}

/**
 * Hourly sweep that emails an account's administrators when a meter crosses a
 * published threshold (90% of a plan limit; 80% and 100% of the AI allowance;
 * the customer's own AI ceiling).
 *
 * Idempotence is a `UsageAlert` row with a unique (account, month, kind), so
 * a retry, a second instance of the API, or a restart mid-sweep cannot send
 * the same warning twice. Nebula keeps this in a JSON blob on the account and
 * has to read-modify-write it; a unique index just refuses the duplicate.
 */
@Injectable()
export class UsageAlertsService {
  private readonly logger = new Logger(UsageAlertsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly email: EmailService,
  ) {}

  /**
   * Run the sweep over accounts that could plausibly be near a limit.
   *
   * Returns what it sent, for the tests and the logs. Never throws: one
   * account with a broken row must not stop the other accounts' alerts.
   */
  async sweep(now: Date = new Date()): Promise<Array<{ accountId: string; kind: AlertKind }>> {
    const month = billingMonthOf(now)
    const accounts = await this.prisma.account.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, defaultLocale: true },
    })
    const sent: Array<{ accountId: string; kind: AlertKind }> = []
    for (const account of accounts) {
      try {
        const usage = await this.usage.evaluate(account.id)
        const kind = alertFor(usage)
        if (!kind) continue
        const already = await this.prisma.usageAlert.findUnique({
          where: {
            accountId_month_kind: { accountId: account.id, month, kind },
          },
          select: { id: true },
        })
        if (already) continue
        // The row goes in BEFORE the email. A crash between the two costs one
        // warning; the reverse costs the customer a mailbox full of them.
        await this.prisma.usageAlert.create({
          data: {
            accountId: account.id,
            month,
            kind,
            metadata: {
              state: usage.state,
              aiConversations: usage.ai.conversations,
              aiIncluded: usage.ai.included,
            },
          },
        })
        await this.notify(account, kind, usage)
        sent.push({ accountId: account.id, kind })
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        this.logger.error(`usage alert failed for account ${account.id}: ${m}`)
        Sentry.captureException(err)
      }
    }
    return sent
  }

  /** Email every administrator and owner of the account. */
  private async notify(
    account: { id: string; name: string; defaultLocale: string },
    kind: AlertKind,
    usage: UsageEvaluation,
  ): Promise<void> {
    const admins = await this.prisma.accountMember.findMany({
      where: {
        accountId: account.id,
        isActive: true,
        role: { in: ['ADMINISTRATOR', 'SUPERVISOR'] },
      },
      select: { user: { select: { email: true } } },
    })
    if (admins.length === 0) {
      this.logger.warn(`account ${account.id} hit ${kind} with no administrator to tell`)
      return
    }
    const { subject, body } = alertEmail(kind, account.name, usage, account.defaultLocale)
    for (const a of admins) {
      await this.email.send(a.user.email, subject, body)
    }
  }

  /**
   * On the hour. The thresholds are about giving a customer time to react, so
   * hourly is plenty and it keeps the query volume trivial.
   */
  @Cron('5 * * * *')
  async hourly(): Promise<void> {
    try {
      const sent = await this.sweep()
      if (sent.length > 0) {
        this.logger.log(`usage alerts sent: ${sent.length}`)
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      this.logger.error(`usage alert sweep failed: ${m}`)
      Sentry.captureException(err)
    }
  }
}

/**
 * The email text.
 *
 * Written for the person paying the bill, in the account's language, with no
 * internal identifiers and no jargon: what happened, what it means for them,
 * and where to look. Never says anything is blocked, because nothing is.
 */
export function alertEmail(
  kind: AlertKind,
  accountName: string,
  usage: UsageEvaluation,
  locale: string,
): { subject: string; body: string } {
  const pt = locale.startsWith('pt')
  const es = locale.startsWith('es')
  const link = 'Configurações > Faturamento'
  const linkEs = 'Configuración > Facturación'
  const linkEn = 'Settings > Billing'

  if (kind === 'plan_90') {
    if (pt) {
      return {
        subject: `${accountName}: uso perto do limite do plano`,
        body:
          `Sua conta chegou a 90% de um dos limites do plano.\n\n` +
          `Nenhuma conversa é bloqueada. O que passar do limite entra como ` +
          `excedente na fatura do mês seguinte.\n\n` +
          `Veja os números em ${link}.`,
      }
    }
    if (es) {
      return {
        subject: `${accountName}: uso cerca del límite del plan`,
        body:
          `Tu cuenta llegó al 90% de uno de los límites del plan.\n\n` +
          `Ninguna conversación se bloquea. Lo que pase del límite se cobra ` +
          `como excedente en la factura del mes siguiente.\n\n` +
          `Consulta los números en ${linkEs}.`,
      }
    }
    return {
      subject: `${accountName}: usage near your plan limit`,
      body:
        `Your account reached 90% of one of its plan limits.\n\n` +
        `No conversation is blocked. Anything above the limit is billed as ` +
        `overage on next month's invoice.\n\n` +
        `See the numbers in ${linkEn}.`,
    }
  }

  if (kind === 'plan_100') {
    if (pt) {
      return {
        subject: `${accountName}: limite do plano atingido`,
        body:
          `Sua conta passou do limite do plano.\n\n` +
          `Nenhuma conversa é bloqueada, e o excedente do mês está estimado ` +
          `em R$ ${usage.estimatedPlanOverageBrl.toFixed(2)}. Um plano maior ` +
          `sai mais barato que o excedente a partir desse ponto.\n\n` +
          `Peça o upgrade em ${link}.`,
      }
    }
    if (es) {
      return {
        subject: `${accountName}: límite del plan alcanzado`,
        body:
          `Tu cuenta pasó el límite del plan.\n\n` +
          `Ninguna conversación se bloquea y el excedente del mes se estima ` +
          `en R$ ${usage.estimatedPlanOverageBrl.toFixed(2)}. Un plan mayor ` +
          `cuesta menos que el excedente a partir de aquí.\n\n` +
          `Solicita el upgrade en ${linkEs}.`,
      }
    }
    return {
      subject: `${accountName}: plan limit reached`,
      body:
        `Your account went past its plan limit.\n\n` +
        `No conversation is blocked, and this month's overage is estimated at ` +
        `R$ ${usage.estimatedPlanOverageBrl.toFixed(2)}. Past this point a ` +
        `larger plan costs less than the overage.\n\n` +
        `Request the upgrade in ${linkEn}.`,
    }
  }

  const used = usage.ai.conversations
  const included = usage.ai.included ?? 0

  if (kind === 'ai_80') {
    if (pt) {
      return {
        subject: `${accountName}: 80% da franquia de IA`,
        body:
          `A IA já atendeu ${used} das ${included} conversas incluídas no ` +
          `seu plano neste mês.\n\n` +
          `Acompanhe em ${link}.`,
      }
    }
    if (es) {
      return {
        subject: `${accountName}: 80% de la franquicia de IA`,
        body:
          `La IA ya atendió ${used} de las ${included} conversaciones ` +
          `incluidas en tu plan este mes.\n\n` +
          `Sigue el uso en ${linkEs}.`,
      }
    }
    return {
      subject: `${accountName}: 80% of your AI allowance`,
      body:
        `The AI has answered ${used} of the ${included} conversations ` +
        `included in your plan this month.\n\n` +
        `Follow it in ${linkEn}.`,
    }
  }

  if (kind === 'ai_100') {
    const hasOverage = usage.ai.overagePriceBrl !== null
    if (pt) {
      return {
        subject: `${accountName}: franquia de IA do mês esgotada`,
        body: hasOverage
          ? `A IA atendeu as ${included} conversas incluídas no seu plano ` +
            `neste mês. As próximas continuam sendo atendidas e entram como ` +
            `excedente na fatura do mês seguinte.\n\n` +
            `Você pode definir um teto mensal em reais em ${link}.`
          : `A IA atendeu as ${included} conversas incluídas no seu plano ` +
            `neste mês. As próximas conversas passam direto para a sua ` +
            `equipe até o mês virar.\n\n` +
            `Para ter mais conversas com IA, veja o upgrade em ${link}.`,
      }
    }
    if (es) {
      return {
        subject: `${accountName}: franquicia de IA agotada`,
        body: hasOverage
          ? `La IA atendió las ${included} conversaciones incluidas en tu ` +
            `plan este mes. Las siguientes se siguen atendiendo y se cobran ` +
            `como excedente en la factura del mes siguiente.\n\n` +
            `Puedes definir un techo mensual en reales en ${linkEs}.`
          : `La IA atendió las ${included} conversaciones incluidas en tu ` +
            `plan este mes. Las siguientes pasan directamente a tu equipo ` +
            `hasta el próximo mes.\n\n` +
            `Para tener más conversaciones con IA, mira el upgrade en ${linkEs}.`,
      }
    }
    return {
      subject: `${accountName}: AI allowance used up`,
      body: hasOverage
        ? `The AI answered the ${included} conversations included in your ` +
          `plan this month. The next ones are still answered and billed as ` +
          `overage on next month's invoice.\n\n` +
          `You can set a monthly ceiling in BRL in ${linkEn}.`
        : `The AI answered the ${included} conversations included in your ` +
          `plan this month. New conversations go straight to your team until ` +
          `the month turns over.\n\n` +
          `For more AI conversations, see the upgrade in ${linkEn}.`,
    }
  }

  // ai_cap
  const cap = usage.ai.capBrl ?? 0
  if (pt) {
    return {
      subject: `${accountName}: teto de IA do mês atingido`,
      body:
        `O teto de R$ ${cap.toFixed(2)} que você definiu para o excedente de ` +
        `IA foi atingido. As próximas conversas passam para a sua equipe até ` +
        `o mês virar.\n\n` +
        `Para mudar o teto, vá em ${link}.`,
    }
  }
  if (es) {
    return {
      subject: `${accountName}: techo de IA alcanzado`,
      body:
        `Se alcanzó el techo de R$ ${cap.toFixed(2)} que definiste para el ` +
        `excedente de IA. Las próximas conversaciones pasan a tu equipo ` +
        `hasta el próximo mes.\n\n` +
        `Para cambiar el techo, ve a ${linkEs}.`,
    }
  }
  return {
    subject: `${accountName}: AI ceiling reached`,
    body:
      `The R$ ${cap.toFixed(2)} ceiling you set for AI overage has been ` +
      `reached. New conversations go to your team until the month turns ` +
      `over.\n\n` +
      `To change the ceiling, go to ${linkEn}.`,
  }
}
