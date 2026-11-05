import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'

import { PrismaService } from '../../prisma/prisma.service'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { errBody } from '../../common/app-error'
import { EmailService } from '../email/email.service'

import { AI_ALLOWANCE } from './plan-limits'
import { UsageService } from './usage.service'

/** Roles allowed to see and change what the account is billed. */
const BILLING_ROLES = ['ADMINISTRATOR', 'SUPERVISOR']

@Controller('accounts/:accountId/usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(
    private readonly svc: UsageService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  @Get()
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ) {
    const m = await this.member(accountId, auth.user.id)
    const usage = await this.svc.evaluate(accountId)
    return {
      plan: usage.plan,
      caps: {
        newConversationsPerMonth: capValue(usage.caps.newConversationsPerMonth),
        totalConversations: capValue(usage.caps.totalConversations),
        contacts: capValue(usage.caps.contacts),
        overageFraction:
          usage.caps.overageFraction === Number.POSITIVE_INFINITY
            ? null
            : usage.caps.overageFraction,
      },
      newConversationsThisMonth: usage.newConversationsThisMonth,
      totalConversations: usage.totalConversations,
      contacts: usage.contacts,
      meters: usage.meters,
      state: usage.state,
      warning: usage.warning,
      estimatedPlanOverageBrl: usage.estimatedPlanOverageBrl,
      ai: usage.ai,
      // Only a billing role may change the ceiling; an agent sees the numbers
      // but gets no form.
      canManageBilling: BILLING_ROLES.includes(m.role),
      // The stored-conversation pool is metered and shown, and deliberately
      // not billed until customers can shrink it (decision 1). The UI says so
      // rather than leaving a meter whose consequence nobody can explain.
      totalConversationsBilled: false,
    }
  }

  /**
   * Set (or clear) the account's own monthly ceiling on AI overage, in BRL.
   *
   * The customer's one lever over AI cost. `null` clears it, which is the
   * default and what the terms promise: no ceiling unless you ask for one.
   * Only meaningful on a plan that has AI overage at all; on Rocket the AI
   * stops at the allowance and there is nothing to cap.
   */
  @Patch('ai-cap')
  async setAiCap(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body() body: { capBrl?: number | null },
  ) {
    const m = await this.member(accountId, auth.user.id)
    if (!BILLING_ROLES.includes(m.role)) {
      throw new ForbiddenException(
        errBody('supervisor_required', 'Only an administrator or supervisor can change billing'),
      )
    }

    const raw = body?.capBrl
    let capBrl: number | null = null
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        throw new BadRequestException(
          errBody('invalid_input', 'capBrl must be a non-negative number or null'),
        )
      }
      capBrl = Math.round(raw * 100) / 100
    }

    const before = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { aiOverageCapBrl: true, plan: true },
    })
    if (!before) {
      throw new ForbiddenException(errBody('account_not_found', 'Account not found'))
    }

    await this.prisma.account.update({
      where: { id: accountId },
      data: { aiOverageCapBrl: capBrl },
    })
    // Audited: this is a promise about an invoice, so who set it and when has
    // to be answerable months later.
    await this.prisma.auditLog.create({
      data: {
        accountId,
        actorId: auth.user.id,
        action: 'account.ai_overage_cap.update',
        target: `account:${accountId}`,
        metadata: {
          from:
            before.aiOverageCapBrl === null ? null : Number(before.aiOverageCapBrl),
          to: capBrl,
        },
      },
    })
    const price = AI_ALLOWANCE[before.plan].overagePriceBrl
    return {
      capBrl,
      /** Extra conversations that ceiling pays for, for the UI's hint. */
      capConversations:
        capBrl === null || price === null || price <= 0
          ? null
          : Math.floor(capBrl / price),
    }
  }

  /**
   * "Solicitar upgrade": tell whoever handles billing that this account wants
   * a bigger plan (phase 6a).
   *
   * Deliberately a message to a human and not a plan change. Changing a plan
   * means a pro-rata charge and a new Asaas subscription, which only
   * cosmo-admin can do correctly; a button in the product that silently
   * changed what someone pays would be the worst possible version of this
   * feature. The automatic path is phase 6b, after there is volume to justify
   * it (decision 15).
   */
  @Post('upgrade-request')
  async requestUpgrade(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ) {
    const m = await this.member(accountId, auth.user.id)
    if (!BILLING_ROLES.includes(m.role)) {
      throw new ForbiddenException(
        errBody('supervisor_required', 'Only an administrator or supervisor can request an upgrade'),
      )
    }
    const usage = await this.svc.evaluate(accountId)
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { name: true },
    })
    // Whoever sells this install's plans. Unset (a self-hosted install with
    // no plans to sell): the request is recorded, nobody is e-mailed.
    const to = process.env.COSMIKA_BILLING_NOTIFY_EMAIL?.trim() || null
    const sent = to === null ? false : await this.email.send(
      to,
      `Pedido de upgrade: ${account?.name ?? accountId}`,
      [
        `Conta: ${account?.name ?? accountId} (${accountId})`,
        `Plano atual: ${usage.plan}`,
        `Pedido por: ${auth.user.email}`,
        '',
        `Novas conversas no mês: ${usage.newConversationsThisMonth}`,
        `Total de conversas: ${usage.totalConversations}`,
        `Contatos: ${usage.contacts}`,
        `Conversas atendidas pela IA: ${usage.ai.conversations}` +
          (usage.ai.included === null ? '' : ` de ${usage.ai.included}`),
        `Excedente estimado de plano: R$ ${usage.estimatedPlanOverageBrl.toFixed(2)}`,
      ].join('\n'),
    )
    await this.prisma.auditLog.create({
      data: {
        accountId,
        actorId: auth.user.id,
        action: 'account.upgrade.requested',
        target: `account:${accountId}`,
        metadata: { plan: usage.plan, state: usage.state, emailed: sent },
      },
    })
    return { requested: true, emailed: sent }
  }

  private async member(accountId: string, userId: string) {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return m
  }
}

function capValue(n: number): number | null {
  return Number.isFinite(n) ? n : null
}
