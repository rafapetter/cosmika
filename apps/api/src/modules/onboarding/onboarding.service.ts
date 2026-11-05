import { Injectable } from '@nestjs/common'
import type { OnboardingStatusDTO } from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { initialControlMode } from '../conversations/conversations.service'

/**
 * Setup progress for the in-app "first steps" checklist. Every step is derived
 * from real account state, never from a flag the user ticks, so the checklist
 * cannot claim something is done when it is not.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async status(accountId: string): Promise<OnboardingStatusDTO> {
    const [inboxes, inbound, people, onShift] = await Promise.all([
      this.prisma.inbox.findMany({
        where: { accountId },
        select: { agentBotId: true, aiAutoreplyMode: true, flowMode: true },
      }),
      this.prisma.message.findFirst({
        where: { accountId, senderType: 'CONTACT' },
        select: { id: true },
      }),
      this.prisma.accountMember.count({
        where: { accountId, isActive: true, role: { not: 'BOT' } },
      }),
      // Automatic distribution only considers agents whose schedule covers the
      // moment, so an account where nobody saved one has every handoff land
      // without an owner. One saved schedule is enough to prove the team knows
      // the screen exists.
      this.prisma.accountMember.count({
        where: {
          accountId,
          isActive: true,
          role: { not: 'BOT' },
          availabilities: { some: {} },
        },
      }),
    ])

    const steps = {
      channel: inboxes.length > 0,
      firstMessage: inbound !== null,
      // Same rule the runtime uses to hand a new conversation to the bot, so
      // "automation is on" here always matches what customers experience.
      automation: inboxes.some((i) => initialControlMode(i) === 'BOT'),
      // The account owner alone is not a team.
      team: people > 1,
      availability: onShift > 0,
    }
    const values = Object.values(steps)
    return {
      steps,
      completed: values.filter(Boolean).length,
      total: values.length,
    }
  }
}
