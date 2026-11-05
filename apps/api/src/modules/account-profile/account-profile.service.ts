import { ForbiddenException, Injectable } from '@nestjs/common'
import type { AccountProfile } from '@cosmika/db'
import type {
  AccountProfileDTO,
  UpsertAccountProfileInput,
} from '@cosmika/shared'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'
import { AuditLogService } from '../audit-log/audit-log.service'

/**
 * The commercial profile collected by the welcome flow.
 *
 * Its own module rather than part of `onboarding`, which is the first-steps
 * checklist and has the opposite contract: every step there is derived from
 * real account state and never from a flag. This one is answers people typed,
 * which is exactly a flag, so mixing them would cost the checklist the
 * property that makes it trustworthy.
 */
@Injectable()
export class AccountProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Administrators only, on read as well as write. These are answers about
   * the business and its plans; an agent has no reason to see them, and the
   * flow is only ever offered to administrators anyway.
   */
  async assertAdmin(userId: string, accountId: string): Promise<void> {
    const m = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!m || !m.isActive) {
      throw new ForbiddenException(
        errBody('not_a_member', 'Not a member of this account'),
      )
    }
    if (m.role !== 'ADMINISTRATOR') {
      throw new ForbiddenException(
        errBody('admin_required', 'Administrator role required'),
      )
    }
  }

  async get(userId: string, accountId: string): Promise<AccountProfileDTO | null> {
    await this.assertAdmin(userId, accountId)
    const row = await this.prisma.accountProfile.findUnique({
      where: { accountId },
    })
    return row ? toAccountProfileDTO(row) : null
  }

  /**
   * One upsert per screen. Partial by design: a screen sends what it asked
   * about and nothing else, so somebody who gives up on screen three still
   * leaves screens one and two behind.
   */
  async upsert(
    userId: string,
    accountId: string,
    input: UpsertAccountProfileInput,
  ): Promise<AccountProfileDTO> {
    await this.assertAdmin(userId, accountId)

    const answers = {
      ...(input.businessIndustry !== undefined && {
        businessIndustry: input.businessIndustry,
      }),
      ...(input.companySize !== undefined && { companySize: input.companySize }),
      ...(input.businessDescription !== undefined && {
        businessDescription: input.businessDescription,
      }),
      ...(input.supportToday !== undefined && { supportToday: input.supportToday }),
      ...(input.channelsToday !== undefined && {
        channelsToday: input.channelsToday,
      }),
      ...(input.conversationVolume !== undefined && {
        conversationVolume: input.conversationVolume,
      }),
      ...(input.intendedFeatures !== undefined && {
        intendedFeatures: input.intendedFeatures,
      }),
      ...(input.expectedVolume !== undefined && {
        expectedVolume: input.expectedVolume,
      }),
      ...(input.expectedAiShare !== undefined && {
        expectedAiShare: input.expectedAiShare,
      }),
      ...(input.lastStep !== undefined && { lastStep: input.lastStep }),
    }

    // `state` is the only thing that writes the two timestamps, and it only
    // ever sets them. Re-opening a finished profile from Settings must not
    // silently put the account back in the funnel as "abandoned".
    const now = new Date()
    const state = {
      ...(input.state === 'completed' && { completedAt: now }),
      ...(input.state === 'skipped' && { skippedAt: now }),
    }

    const row = await this.prisma.accountProfile.upsert({
      where: { accountId },
      create: { accountId, filledByUserId: userId, ...answers, ...state },
      update: { filledByUserId: userId, ...answers, ...state },
    })

    // Answers are not copied into the audit metadata: they are already in the
    // table, and AuditLog is pruned at 90 days, so a copy there would be both
    // redundant and shorter-lived than the original.
    await this.audit.record({
      accountId,
      actorId: userId,
      action:
        input.state === 'completed'
          ? 'onboarding_flow.completed'
          : input.state === 'skipped'
            ? 'onboarding_flow.skipped'
            : 'account_profile.saved',
      target: `account:${accountId}`,
      metadata: { lastStep: input.lastStep ?? null },
    })

    return toAccountProfileDTO(row)
  }
}

export const toAccountProfileDTO = (p: AccountProfile): AccountProfileDTO =>
  ({
    accountId: p.accountId,
    businessIndustry: p.businessIndustry,
    companySize: p.companySize,
    businessDescription: p.businessDescription,
    supportToday: p.supportToday,
    channelsToday: p.channelsToday,
    conversationVolume: p.conversationVolume,
    intendedFeatures: p.intendedFeatures,
    expectedVolume: p.expectedVolume,
    expectedAiShare: p.expectedAiShare,
    version: p.version,
    lastStep: p.lastStep,
    startedAt: p.startedAt.toISOString(),
    completedAt: p.completedAt ? p.completedAt.toISOString() : null,
    skippedAt: p.skippedAt ? p.skippedAt.toISOString() : null,
  }) as AccountProfileDTO
