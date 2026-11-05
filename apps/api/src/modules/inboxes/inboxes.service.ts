import { randomBytes } from 'node:crypto'

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type {
  AccountMember,
  Inbox,
  InboxMember,
  Prisma,
  Role,
  User,
} from '@cosmika/db'
import {
  AddInboxMemberInput,
  CreateInboxInput,
  type DeviationPolicy,
  EmailConfig,
  UpdateInboxInput,
  UpdateWhatsappCredentialsInput,
  WHATSAPP_CREDENTIAL_FIELDS,
  WHATSAPP_STORED_SECRET_FIELDS,
  TELEGRAM_SECRET_FIELDS,
  TelegramConfig,
  META_PAGE_SECRET_FIELDS,
  WebWidgetConfig,
  WhatsappConfig,
  type WhatsappCredentialField,
  type WhatsappSecretsStatus,
} from '@cosmika/shared'
import { type TypeOf, type ZodTypeAny } from 'zod'

import {
  decryptSecretsIn,
  encryptSecretsIn,
} from '../../common/secret-crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { errBody } from '../../common/app-error'

// Wraps schema.safeParse so a Zod failure surfaces as a structured 400.
// We use Zod's own result-object API instead of try/catch + `instanceof
// ZodError` because the latter falls over when the schema (defined in
// @cosmika/shared) and this consumer resolve `zod` through two slightly
// different module paths under pnpm — `instanceof` returns false even
// though both sides hold ZodError instances. The result-object check is
// identity-free.
function safeParse<S extends ZodTypeAny>(schema: S, value: unknown): TypeOf<S> {
  const result = schema.safeParse(value)
  if (result.success) return result.data as TypeOf<S>
  throw new BadRequestException({
    message: 'Invalid channel config',
    issues: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  })
}

export type InboxWithMembers = Inbox & {
  members: Array<InboxMember & { user: User }>
}

const MUTATE_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

// Channel credentials are narrower than the rest of the channel settings: a
// supervisor can rename an inbox or attach a bot, but only an administrator
// can point it at a different WhatsApp number or rotate its secrets.
const CREDENTIAL_ROLES: Role[] = ['ADMINISTRATOR']

export type WhatsappCredentialsUpdate = {
  inbox: Inbox
  /** Names of the fields whose stored value changed. Never the values. */
  changed: WhatsappCredentialField[]
}

export type InboxUpdate = {
  inbox: Inbox
  /**
   * Names of the WhatsApp credential fields this PATCH replaced, for the
   * caller's audit entry. Empty for every other kind of change.
   */
  whatsappCredentialsChanged: WhatsappCredentialField[]
}

@Injectable()
export class InboxesService {
  private readonly logger = new Logger(InboxesService.name)

  constructor(private readonly prisma: PrismaService) {}

  private async getMembership(
    userId: string,
    accountId: string,
  ): Promise<AccountMember> {
    const membership = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId } },
    })
    if (!membership || !membership.isActive) {
      throw new ForbiddenException(errBody('not_a_member', 'Not a member of this account'))
    }
    return membership
  }

  private assertMutator(role: Role) {
    if (!MUTATE_ROLES.includes(role)) {
      throw new ForbiddenException(errBody('supervisor_required', 'Administrator or Supervisor role required'))
    }
  }

  private assertCredentialMutator(role: Role) {
    if (!CREDENTIAL_ROLES.includes(role)) {
      throw new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    }
  }

  private async assertInboxVisible(
    userId: string,
    membership: AccountMember,
    inboxId: string,
  ): Promise<Inbox> {
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
    })
    if (!inbox || inbox.accountId !== membership.accountId) {
      throw new NotFoundException()
    }
    if (MUTATE_ROLES.includes(membership.role)) return inbox
    // Agents can only see inboxes they're a member of.
    const inboxMember = await this.prisma.inboxMember.findUnique({
      where: { inboxId_userId: { inboxId, userId } },
    })
    if (!inboxMember) throw new NotFoundException()
    return inbox
  }

  private buildForwardingAddress(accountSlug: string): string {
    const suffix = randomBytes(4).toString('hex')
    return `inbox-${accountSlug}-${suffix}@cosmika.app`
  }

  private normalizeChannelConfig(
    input: CreateInboxInput,
    account: { slug: string },
  ): Record<string, unknown> {
    switch (input.channelType) {
      case 'WEB_WIDGET':
        return {
          ...safeParse(WebWidgetConfig, input.channelConfig),
          // Public-route slug for /widget/:hash/* endpoints. Rotatable later.
          widgetHash: randomBytes(16).toString('hex'),
        }
      case 'EMAIL': {
        const parsed = safeParse(EmailConfig, input.channelConfig)
        return {
          ...parsed,
          forwardingAddress:
            parsed.forwardingAddress ??
            this.buildForwardingAddress(account.slug),
        }
      }
      case 'WHATSAPP':
        // Secrets are wrapped before they ever reach the column. See
        // common/secret-crypto.ts; without a key this is a no-op and the
        // channel is stored exactly as it was before encryption existed.
        return encryptSecretsIn(
          { ...safeParse(WhatsappConfig, input.channelConfig) },
          WHATSAPP_STORED_SECRET_FIELDS,
        )
      case 'TELEGRAM':
        // Only the BotFather token is typed in. The secret Telegram echoes on
        // every webhook call is ours, generated here; the bot's username is
        // filled in by TelegramService once the webhook is registered.
        return encryptSecretsIn(
          {
            botToken: safeParse(TelegramConfig, input.channelConfig).botToken,
            webhookSecret: randomBytes(24).toString('hex'),
          },
          TELEGRAM_SECRET_FIELDS,
        )
      case 'API':
        return { ...input.channelConfig }
    }
  }

  private redactConfig(
    channelType: Inbox['channelType'],
    raw: Prisma.JsonValue,
  ): Record<string, unknown> {
    const obj = { ...this.configObject(raw) }
    if (channelType === 'WHATSAPP') {
      for (const field of WHATSAPP_STORED_SECRET_FIELDS) delete obj[field]
    }
    if (channelType === 'TELEGRAM') {
      for (const field of TELEGRAM_SECRET_FIELDS) delete obj[field]
    }
    if (channelType === 'FACEBOOK' || channelType === 'INSTAGRAM') {
      for (const field of META_PAGE_SECRET_FIELDS) delete obj[field]
    }
    return obj
  }

  private whatsappSecretsStatus(
    channelType: Inbox['channelType'],
    raw: Prisma.JsonValue,
  ): WhatsappSecretsStatus | null {
    if (channelType !== 'WHATSAPP') return null
    const obj = this.configObject(raw)
    return {
      accessToken: this.isSet(obj.accessToken),
      appSecret: this.isSet(obj.appSecret),
      webhookVerifyToken: this.isSet(obj.webhookVerifyToken),
    }
  }

  private configObject(raw: Prisma.JsonValue): Record<string, unknown> {
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  }

  private isSet(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0
  }

  toInboxDTO(inbox: Inbox) {
    return {
      id: inbox.id,
      accountId: inbox.accountId,
      name: inbox.name,
      channelType: inbox.channelType,
      channelConfig: this.redactConfig(inbox.channelType, inbox.channelConfig),
      greetingEnabled: inbox.greetingEnabled,
      greetingMessage: inbox.greetingMessage,
      outOfOfficeMessage: inbox.outOfOfficeMessage,
      closingMessage: inbox.closingMessage,
      aiAutoreplyMode: inbox.aiAutoreplyMode,
      autoResolveMinutes: inbox.autoResolveMinutes,
      agentBotId: inbox.agentBotId,
      csatEnabled: inbox.csatEnabled,
      slaPolicyId: inbox.slaPolicyId,
      defaultFlowId: inbox.defaultFlowId,
      flowMode: inbox.flowMode,
      deviationPolicy: inbox.deviationPolicy as DeviationPolicy,
      maxDeviations: inbox.maxDeviations,
      whatsappSecrets: this.whatsappSecretsStatus(
        inbox.channelType,
        inbox.channelConfig,
      ),
      createdAt: inbox.createdAt.toISOString(),
      updatedAt: inbox.updatedAt.toISOString(),
    }
  }

  toInboxMemberDTO(member: InboxMember & { user: User }) {
    return {
      id: member.id,
      userId: member.userId,
      user: {
        id: member.user.id,
        email: member.user.email,
        fullName: member.user.fullName,
      },
      createdAt: member.createdAt.toISOString(),
    }
  }

  async list(userId: string, accountId: string): Promise<Inbox[]> {
    const membership = await this.getMembership(userId, accountId)
    if (MUTATE_ROLES.includes(membership.role)) {
      return this.prisma.inbox.findMany({
        where: { accountId },
        orderBy: { createdAt: 'asc' },
      })
    }
    return this.prisma.inbox.findMany({
      where: { accountId, members: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
    })
  }

  async getWithMembers(
    userId: string,
    accountId: string,
    inboxId: string,
  ): Promise<InboxWithMembers> {
    const membership = await this.getMembership(userId, accountId)
    await this.assertInboxVisible(userId, membership, inboxId)
    const inbox = await this.prisma.inbox.findUnique({
      where: { id: inboxId },
      include: {
        members: {
          include: { user: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!inbox) throw new NotFoundException()
    return inbox
  }

  async create(
    userId: string,
    accountId: string,
    input: CreateInboxInput,
  ): Promise<Inbox> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)

    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, slug: true },
    })
    if (!account) throw new NotFoundException()

    const channelConfig = this.normalizeChannelConfig(input, account)

    // Optional attach-at-create. Validate the bot exists and belongs to the
    // same account before we use it — same guard as the PATCH path. The
    // FK is set as a scalar (matches the Unchecked create flavour used for
    // the rest of the inbox fields).
    let agentBotId: string | undefined
    if (input.agentBotId) {
      const bot = await this.prisma.agentBot.findUnique({
        where: { id: input.agentBotId },
        select: { id: true, accountId: true },
      })
      if (!bot || bot.accountId !== accountId) {
        throw new NotFoundException('Agent bot not found')
      }
      agentBotId = bot.id
    }

    return this.prisma.inbox.create({
      data: {
        accountId,
        name: input.name,
        channelType: input.channelType,
        channelConfig: channelConfig as Prisma.InputJsonValue,
        greetingEnabled: input.greetingEnabled ?? false,
        greetingMessage: input.greetingMessage,
        outOfOfficeMessage: input.outOfOfficeMessage,
        aiAutoreplyMode: input.aiAutoreplyMode ?? 'DRAFT',
        autoResolveMinutes: input.autoResolveMinutes ?? 10080,
        csatEnabled: input.csatEnabled ?? false,
        ...(agentBotId && { agentBotId }),
      },
    })
  }

  /**
   * Insert a Messenger or Instagram inbox whose config the Meta module already
   * checked with Graph (page id, token, linked Instagram account). Same role
   * gate as create(); the Page token is encrypted before it is stored.
   */
  async createMetaInbox(
    userId: string,
    accountId: string,
    input: {
      name: string
      channelType: 'FACEBOOK' | 'INSTAGRAM'
      channelConfig: Record<string, unknown>
    },
  ): Promise<Inbox> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    return this.prisma.inbox.create({
      data: {
        accountId,
        name: input.name,
        channelType: input.channelType,
        channelConfig: encryptSecretsIn(
          input.channelConfig,
          META_PAGE_SECRET_FIELDS,
        ) as Prisma.InputJsonValue,
        aiAutoreplyMode: 'DRAFT',
        autoResolveMinutes: 10080,
      },
    })
  }

  async update(
    userId: string,
    accountId: string,
    inboxId: string,
    input: UpdateInboxInput,
  ): Promise<InboxUpdate> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    const existing = await this.assertInboxVisible(userId, membership, inboxId)

    const data: Prisma.InboxUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.greetingEnabled !== undefined && {
        greetingEnabled: input.greetingEnabled,
      }),
      ...(input.greetingMessage !== undefined && {
        greetingMessage: input.greetingMessage,
      }),
      ...(input.outOfOfficeMessage !== undefined && {
        outOfOfficeMessage: input.outOfOfficeMessage,
      }),
      // Blank is "off", stored as null so the resolve path has one test.
      ...(input.closingMessage !== undefined && {
        closingMessage: input.closingMessage?.trim() || null,
      }),
      ...(input.aiAutoreplyMode !== undefined && {
        aiAutoreplyMode: input.aiAutoreplyMode,
      }),
      ...(input.autoResolveMinutes !== undefined && {
        autoResolveMinutes: input.autoResolveMinutes,
      }),
      ...(input.csatEnabled !== undefined && {
        csatEnabled: input.csatEnabled,
      }),
      ...(input.slaPolicyId !== undefined && {
        slaPolicy:
          input.slaPolicyId === null
            ? { disconnect: true }
            : { connect: { id: input.slaPolicyId } },
      }),
      ...(input.flowMode !== undefined && { flowMode: input.flowMode }),
      ...(input.deviationPolicy !== undefined && {
        deviationPolicy: input.deviationPolicy,
      }),
      ...(input.maxDeviations !== undefined && {
        maxDeviations: input.maxDeviations,
      }),
    }

    if (input.defaultFlowId !== undefined) {
      if (input.defaultFlowId === null) {
        data.defaultFlow = { disconnect: true }
      } else {
        const flow = await this.prisma.flow.findUnique({
          where: { id: input.defaultFlowId },
          select: { id: true, accountId: true },
        })
        if (!flow || flow.accountId !== membership.accountId) {
          throw new NotFoundException('Flow not found')
        }
        data.defaultFlow = { connect: { id: input.defaultFlowId } }
      }
    }

    if (input.agentBotId !== undefined) {
      if (input.agentBotId === null) {
        data.agentBot = { disconnect: true }
      } else {
        const bot = await this.prisma.agentBot.findUnique({
          where: { id: input.agentBotId },
          select: { id: true, accountId: true },
        })
        if (!bot || bot.accountId !== membership.accountId) {
          throw new NotFoundException('Agent bot not found')
        }
        data.agentBot = { connect: { id: input.agentBotId } }
      }
    }

    if (input.channelConfig !== undefined) {
      // WhatsApp credentials used to be refused outright here, which also
      // refused every other reason to PATCH the channel config of a WhatsApp
      // inbox. They are allowed again, through exactly the same code as the
      // dedicated endpoint: the closed allow-list, blank-means-keep, the
      // administrator check and the field-names-only audit entry. Nothing
      // about this path is more permissive than PATCH .../whatsapp-credentials:
      // it is that path, reached by a different URL.
      if (existing.channelType === 'WHATSAPP') {
        const credentials = safeParse(
          UpdateWhatsappCredentialsInput,
          input.channelConfig,
        )
        // A field the caller left blank is "keep", so it does not count as
        // touching a credential and does not demand the higher role.
        const touchesCredentials = WHATSAPP_CREDENTIAL_FIELDS.some(
          (field) => credentials[field] !== undefined,
        )
        if (touchesCredentials) this.assertCredentialMutator(membership.role)
        const { inbox, changed } = await this.applyWhatsappCredentials(
          existing,
          credentials,
          data,
        )
        return { inbox, whatsappCredentialsChanged: changed }
      }
      const merged = this.mergeChannelConfig(
        existing.channelType,
        existing.channelConfig,
        input.channelConfig,
      )
      data.channelConfig = merged as Prisma.InputJsonValue
    }

    const inbox = await this.prisma.inbox.update({
      where: { id: inboxId },
      data,
    })
    return { inbox, whatsappCredentialsChanged: [] }
  }

  async updateWhatsappCredentials(
    userId: string,
    accountId: string,
    inboxId: string,
    input: UpdateWhatsappCredentialsInput,
  ): Promise<WhatsappCredentialsUpdate> {
    const membership = await this.getMembership(userId, accountId)
    this.assertCredentialMutator(membership.role)
    const existing = await this.assertInboxVisible(userId, membership, inboxId)
    if (existing.channelType !== 'WHATSAPP') {
      throw new BadRequestException(errBody('inbox_not_whatsapp', 'Inbox is not a WhatsApp channel'))
    }
    return this.applyWhatsappCredentials(existing, input)
  }

  /**
   * The one place a WhatsApp channel's credentials are written.
   *
   * Callers do their own authorization first (administrator, both on the
   * dedicated endpoint and on the general PATCH) and hand over an input that
   * has already been through UpdateWhatsappCredentialsInput, which is strict
   * and turns a blank string into "keep". Everything after that is shared:
   * the closed allow-list copy, the change list, revalidation, the
   * duplicate-number guard, encryption at rest and the leak-proof error
   * handling. The two routes cannot drift apart.
   *
   * `extraData` lets the general PATCH write the rest of its changes in the
   * same statement instead of a second round trip.
   */
  private async applyWhatsappCredentials(
    existing: Inbox,
    input: UpdateWhatsappCredentialsInput,
    extraData: Prisma.InboxUpdateInput = {},
  ): Promise<WhatsappCredentialsUpdate> {
    const stored = this.configObject(existing.channelConfig)
    // Compare in plaintext. Ciphertext is different on every write (random
    // IV), so comparing stored bytes would report "changed" for a secret the
    // operator re-typed identically, and the audit entry would lie.
    const current = decryptSecretsIn(stored, WHATSAPP_STORED_SECRET_FIELDS)
    // Start from what is stored and copy the allowed fields by name. A field
    // that is absent (or was blank, which the schema turns into absent)
    // keeps its stored value.
    const nextPlain: Record<string, unknown> = { ...current }
    const changed: WhatsappCredentialField[] = []
    for (const field of WHATSAPP_CREDENTIAL_FIELDS) {
      const value = input[field]
      if (value === undefined || value === current[field]) continue
      nextPlain[field] = value
      changed.push(field)
    }

    // Build what goes in the column from what is ALREADY in the column, so a
    // secret nobody touched keeps its exact stored bytes: re-encrypting it
    // would pick a new IV and make every save look like a change. Then wrap:
    // a field that came from the input is plaintext and gets wrapped, and one
    // that predates encryption gets wrapped too, which is the lazy upgrade.
    const nextStored: Record<string, unknown> = { ...stored }
    for (const field of changed) nextStored[field] = nextPlain[field]
    const next = encryptSecretsIn(nextStored, WHATSAPP_STORED_SECRET_FIELDS)
    const rewrite = JSON.stringify(next) !== JSON.stringify(stored)
    const hasExtra = Object.keys(extraData).length > 0
    if (!rewrite && !hasExtra) return { inbox: existing, changed }

    const parsed = WhatsappConfig.safeParse(nextPlain)
    if (!parsed.success) {
      // The input already passed its own schema, so this is a stored config
      // missing a required field. Zod issue messages name the rule, never
      // the rejected value, so they are safe to return.
      throw new BadRequestException({
        message: 'Invalid WhatsApp credentials',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
    }

    // A second WhatsApp channel on the same number in this account would make
    // both accept the same webhook deliveries (the phone_number_id guard only
    // drops OTHER numbers), duplicating every conversation.
    if (changed.includes('phoneNumberId')) {
      const clash = await this.prisma.inbox.findFirst({
        where: {
          accountId: existing.accountId,
          channelType: 'WHATSAPP',
          id: { not: existing.id },
          channelConfig: { path: ['phoneNumberId'], equals: parsed.data.phoneNumberId },
        },
        select: { id: true },
      })
      if (clash) {
        throw new ConflictException(errBody('whatsapp_phone_in_use', 'Another WhatsApp channel in this account already uses this phone number ID'))
      }
    }

    try {
      const inbox = await this.prisma.inbox.update({
        where: { id: existing.id },
        // Keep keys the schema does not know about (none today) instead of
        // silently dropping them; the credential keys come from `next`.
        data: { ...extraData, channelConfig: next as Prisma.InputJsonValue },
      })
      return { inbox, changed }
    } catch (err) {
      // A Prisma error message can echo the query arguments, which here are
      // the secrets. Log the error class only and answer with a fixed text.
      this.logger.error(
        `whatsapp credentials update failed for inbox ${existing.id}: ${
          err instanceof Error ? err.name : 'unknown error'
        }`,
      )
      throw new InternalServerErrorException(errBody('whatsapp_credentials_save_failed', 'Could not save WhatsApp credentials'))
    }
  }

  private mergeChannelConfig(
    channelType: Exclude<Inbox['channelType'], 'WHATSAPP'>,
    current: Prisma.JsonValue,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const base =
      current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {}
    const merged = { ...base, ...incoming }
    // Re-validate the merged shape against the channel-specific schema.
    switch (channelType) {
      case 'WEB_WIDGET':
        return { ...safeParse(WebWidgetConfig, merged) }
      case 'EMAIL':
        return { ...safeParse(EmailConfig, merged) }
      case 'API':
        return merged
      case 'TELEGRAM':
      case 'FACEBOOK':
      case 'INSTAGRAM':
        // Nothing here is edited by hand: the token is checked against the
        // provider and the rest is written by its module. Keep what is
        // stored rather than let a generic PATCH overwrite a secret.
        return { ...base }
    }
  }

  async remove(userId: string, accountId: string, inboxId: string): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.assertInboxVisible(userId, membership, inboxId)
    // Refuse with a clear 409 if any conversation still references this
    // inbox — without this guard Prisma's FK rejection surfaces as a generic
    // 500 with no actionable message for the operator.
    const conversationCount = await this.prisma.conversation.count({
      where: { inboxId },
    })
    if (conversationCount > 0) {
      throw new ConflictException(errBody('inbox_has_conversations', `Inbox has ${conversationCount} conversation${conversationCount === 1 ? '' : 's'} attached. Move or delete them before removing the channel.`))
    }
    await this.prisma.inbox.delete({ where: { id: inboxId } })
  }

  async addMember(
    userId: string,
    accountId: string,
    inboxId: string,
    input: AddInboxMemberInput,
  ): Promise<InboxMember & { user: User }> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.assertInboxVisible(userId, membership, inboxId)

    const target = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId: input.userId } },
    })
    if (!target || !target.isActive) {
      throw new NotFoundException('User is not a member of this account')
    }

    const existing = await this.prisma.inboxMember.findUnique({
      where: { inboxId_userId: { inboxId, userId: input.userId } },
    })
    if (existing) {
      throw new ConflictException(errBody('already_inbox_member', 'User is already a member of this inbox'))
    }

    return this.prisma.inboxMember.create({
      data: { inboxId, userId: input.userId },
      include: { user: true },
    })
  }

  async removeMember(
    userId: string,
    accountId: string,
    inboxId: string,
    memberUserId: string,
  ): Promise<void> {
    const membership = await this.getMembership(userId, accountId)
    this.assertMutator(membership.role)
    await this.assertInboxVisible(userId, membership, inboxId)
    const existing = await this.prisma.inboxMember.findUnique({
      where: { inboxId_userId: { inboxId, userId: memberUserId } },
    })
    if (!existing) throw new NotFoundException()
    await this.prisma.inboxMember.delete({
      where: { inboxId_userId: { inboxId, userId: memberUserId } },
    })
  }
}
