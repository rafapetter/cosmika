import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma, Role, WhatsappTemplate } from '@cosmika/db'

import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

import { MetaTemplate, WhatsappService } from './whatsapp.service'

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

@Injectable()
export class WhatsappTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
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

  private async ensureWhatsappInbox(accountId: string, inboxId: string) {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
      select: { id: true, accountId: true, channelType: true },
    })
    if (!inbox || inbox.accountId !== accountId) throw new NotFoundException()
    return inbox
  }

  /** Extract the BODY text and {{n}} placeholder count from a Meta template. */
  static parse(meta: MetaTemplate): {
    body: string
    variableCount: number
    components: NonNullable<MetaTemplate['components']>
  } {
    const bodyComp = (meta.components ?? []).find((c) => c.type === 'BODY')
    const body = bodyComp?.text ?? ''
    const matches = body.match(/\{\{\s*(\d+)\s*\}\}/g) ?? []
    // variableCount = the highest placeholder index referenced (handles gaps).
    const max = matches.reduce((acc, m) => {
      const n = Number(m.replace(/[^\d]/g, ''))
      return n > acc ? n : acc
    }, 0)
    return { body, variableCount: max, components: meta.components ?? [] }
  }

  async list(
    userId: string,
    accountId: string,
    inboxId: string,
  ): Promise<WhatsappTemplate[]> {
    await this.getMembership(userId, accountId)
    await this.ensureWhatsappInbox(accountId, inboxId)
    return this.prisma.whatsappTemplate.findMany({
      where: { inboxId },
      orderBy: [{ name: 'asc' }, { language: 'asc' }],
    })
  }

  /**
   * Pull templates from Meta and upsert them. Returns how many were synced.
   * Templates that vanished from Meta are left in place (operators rarely
   * delete; a hard reconcile can come later).
   */
  async sync(
    userId: string,
    accountId: string,
    inboxId: string,
  ): Promise<{ synced: number }> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.ensureWhatsappInbox(accountId, inboxId)

    const metaTemplates = await this.whatsapp.fetchTemplatesFromMeta(inboxId)
    for (const meta of metaTemplates) {
      const { body, variableCount, components } =
        WhatsappTemplatesService.parse(meta)
      await this.prisma.whatsappTemplate.upsert({
        where: {
          inboxId_name_language: {
            inboxId,
            name: meta.name,
            language: meta.language,
          },
        },
        create: {
          inboxId,
          name: meta.name,
          language: meta.language,
          category: meta.category,
          status: meta.status,
          body,
          variableCount,
          components: components as unknown as Prisma.InputJsonValue,
          externalId: meta.id ?? null,
        },
        update: {
          category: meta.category,
          status: meta.status,
          body,
          variableCount,
          components: components as unknown as Prisma.InputJsonValue,
          externalId: meta.id ?? null,
          syncedAt: new Date(),
        },
      })
    }
    return { synced: metaTemplates.length }
  }

  toDTO(t: WhatsappTemplate) {
    return {
      id: t.id,
      inboxId: t.inboxId,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      body: t.body,
      variableCount: t.variableCount,
      syncedAt: t.syncedAt.toISOString(),
    }
  }
}
