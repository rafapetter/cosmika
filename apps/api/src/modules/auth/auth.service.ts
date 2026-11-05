import { createHash, randomBytes } from 'node:crypto'

import {
  Logger,
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Account, AccountMember, Prisma, Session, User } from '@cosmika/db'
import * as argon2 from 'argon2'

import { PrismaService } from '../../prisma/prisma.service'
import { BillingService, type SignupCheckout } from '../billing/billing.service'
import { EmailService } from '../email/email.service'
import { errBody } from '../../common/app-error'

import {
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from './totp'

const SESSION_TOKEN_BYTES = 32

export type SessionContext = {
  sessionId: string
  user: User
  membership: AccountMember
}

/** Enough of an address to correlate a sweep in logs, not enough to leak the
 *  user list to whoever reads them: `ma***@example.com`. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@')
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly billing: BillingService,
  ) {}

  private sessionTtlMs(): number {
    const days = Number(this.config.get('SESSION_TTL_DAYS') ?? 30)
    return days * 24 * 60 * 60 * 1000
  }

  private generateToken(): string {
    return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48)
  }

  private async uniqueSlug(base: string): Promise<string> {
    const root = this.slugify(base) || 'account'
    let candidate = root
    let attempt = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = await this.prisma.account.findUnique({
        where: { slug: candidate },
        select: { id: true },
      })
      if (!exists) return candidate
      attempt += 1
      const suffix = randomBytes(3).toString('hex')
      candidate = `${root}-${suffix}`
      if (attempt > 5) return `${root}-${Date.now().toString(36)}`
    }
  }

  async signUp(input: {
    email: string
    password: string
    fullName: string
    accountName: string
    inviteCode?: string
  }): Promise<{
    account: Account
    user: User
    membership: AccountMember
    session: Session
    checkout: SignupCheckout | null
  }> {
    // Beta gate: when COSMIKA_SIGNUP_INVITE_CODE is set, public signup
    // requires the matching code (there is no billing behind signup yet).
    const invite = this.config.get<string>('COSMIKA_SIGNUP_INVITE_CODE')
    if (invite && input.inviteCode !== invite) {
      throw new ForbiddenException(errBody('invite_code_required', 'Signup requires a valid invite code'))
    }
    const existing = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      select: { id: true },
    })
    if (existing) {
      // Signup inherently discloses whether an address is taken — the form
      // must refuse a duplicate account. The mitigation is the 5/hour
      // per-IP throttle on this route plus this log line, so a sweep is
      // visible rather than silent (M1). Removing the disclosure entirely
      // needs an email-verification flow; tracked in security-review.md.
      this.logger.warn(
        `signup rejected: address already registered (${maskEmail(input.email)})`,
      )
      throw new ConflictException(errBody('email_taken', 'Email already registered'))
    }

    const passwordHash = await argon2.hash(input.password)
    const slug = await this.uniqueSlug(input.accountName)

    const result = await this.prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          name: input.accountName,
          slug,
          status: 'ACTIVE',
          // Every new signup is ROCKET, which is the plan cosmo-admin bills
          // it on and the plan the checkout link it gets is priced at.
          // Creating the account as EXPLORER meant the product enforced
          // 50-conversation caps on a customer paying for 500, and the
          // month-end meter reported a plan that did not exist on any
          // invoice. EXPLORER stays in the enum for the accounts already on
          // it; nothing is created on it any more (decision 4).
          plan: 'ROCKET',
        },
      })

      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          fullName: input.fullName,
          locale: account.defaultLocale,
        },
      })

      const membership = await tx.accountMember.create({
        data: {
          accountId: account.id,
          userId: user.id,
          role: 'ADMINISTRATOR',
        },
      })

      return { account, user, membership }
    })

    const session = await this.createSession(result.user.id)
    // Ask cosmo-admin (the price authority) for this account's checkout link.
    // Never send a price, and never fail signup if billing is unavailable:
    // the account exists and a link can be issued later.
    const checkout = await this.billing.createSignupCheckout({
      accountId: result.account.id,
      accountName: result.account.name,
    })
    if (checkout) {
      // Kept for the "subscription ended" screen. Best effort, like the call
      // above: losing it only means that screen offers the finance contact.
      await this.prisma.account
        .update({
          where: { id: result.account.id },
          data: { billingCheckoutUrl: checkout.paymentLinkUrl },
        })
        .catch((err: unknown) => {
          this.logger.error(
            `could not keep checkout link for ${result.account.id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
    }
    return { ...result, session, checkout }
  }

  async signIn(input: { email: string; password: string }): Promise<
    | {
        kind: 'session'
        user: User
        account: Account
        membership: AccountMember
        session: Session
      }
    | { kind: 'totp'; challengeToken: string }
  > {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    })
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException(errBody('invalid_credentials', 'Invalid credentials'))
    }
    const ok = await argon2.verify(user.passwordHash, input.password)
    if (!ok) {
      throw new UnauthorizedException(errBody('invalid_credentials', 'Invalid credentials'))
    }

    if (user.totpEnabled) {
      // Issue a short-lived challenge token. We store it as a Session with a
      // 5-minute expiry; redemption swaps it for a real session. The DB
      // stores `chal_<sha256(plaintext)>`; only the plaintext goes to client.
      const plaintext = this.generateToken()
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await this.prisma.session.create({
        data: {
          userId: user.id,
          token: `chal_${this.hashToken(plaintext)}`,
          expiresAt,
        },
      })
      return { kind: 'totp', challengeToken: plaintext }
    }

    const ctx = await this.completeSignIn(user)
    return { kind: 'session', ...ctx }
  }

  private async completeSignIn(user: User): Promise<{
    user: User
    account: Account
    membership: AccountMember
    session: Session
  }> {
    const membership = await this.prisma.accountMember.findFirst({
      where: { userId: user.id, isActive: true },
      include: { account: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!membership) {
      throw new UnauthorizedException(errBody('no_membership', 'No active account membership'))
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastSignInAt: new Date() },
    })

    const session = await this.createSession(user.id)
    return { user, account: membership.account, membership, session }
  }

  /**
   * Exchange a TOTP challenge token + 6-digit code (or a recovery code) for
   * a real session. Consumes the challenge on success or expiry.
   */
  async redeemTotpChallenge(input: {
    challengeToken: string
    code: string
  }): Promise<{
    user: User
    account: Account
    membership: AccountMember
    session: Session
  }> {
    const challenge = await this.prisma.session.findUnique({
      where: { token: `chal_${this.hashToken(input.challengeToken)}` },
      include: { user: true },
    })
    if (!challenge) throw new UnauthorizedException(errBody('invalid_challenge', 'Invalid challenge'))
    if (challenge.expiresAt < new Date()) {
      await this.prisma.session.delete({ where: { id: challenge.id } })
      throw new UnauthorizedException(errBody('challenge_expired', 'Challenge expired'))
    }
    const user = challenge.user
    if (!user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException()
    }
    const totpOk = verifyTotp(user.totpSecret, input.code)
    let consumedRecoveryHash: string | null = null
    const storedRecovery = (user.totpRecoveryCodes as string[] | null) ?? []
    if (!totpOk) {
      // Maybe a recovery code?
      const hash = createHash('sha256').update(input.code).digest('hex')
      const idx = storedRecovery.indexOf(hash)
      if (idx === -1) {
        // Wrong code: bump attempts, delete after 5 to lock the challenge.
        const next = challenge.totpAttempts + 1
        if (next >= 5) {
          await this.prisma.session.delete({ where: { id: challenge.id } })
        } else {
          await this.prisma.session.update({
            where: { id: challenge.id },
            data: { totpAttempts: next },
          })
        }
        throw new UnauthorizedException(errBody('invalid_code', 'Invalid code'))
      }
      // We just found `hash` in storedRecovery at index `idx` so it's
      // guaranteed to be a defined string. No need for a `?? null` guard.
      consumedRecoveryHash = hash
    }
    // Consume the challenge.
    await this.prisma.session.delete({ where: { id: challenge.id } })
    // If a recovery code was used, mark it spent. storedRecovery is the same
    // array we just searched, so it can't be null here either.
    if (consumedRecoveryHash) {
      const remaining = storedRecovery.filter((h) => h !== consumedRecoveryHash)
      await this.prisma.user.update({
        where: { id: user.id },
        data: { totpRecoveryCodes: remaining },
      })
    }
    return this.completeSignIn(user)
  }

  // ─── 2FA setup/disable ──────────────────────────────────────────

  async setupTotp(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new UnauthorizedException()
    const secret = generateTotpSecret()
    // Store provisionally; verification is required to flip totpEnabled=true.
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: secret, totpEnabled: false },
    })
    return {
      secret,
      otpauthUrl: otpauthUrl({
        secret,
        issuer: 'Cosmika',
        account: user.email,
      }),
    }
  }

  async verifyTotpSetup(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.totpSecret) throw new BadRequestException(errBody('totp_setup_missing', 'Setup not started'))
    if (user.totpEnabled) throw new ConflictException(errBody('totp_already_enabled', 'Already enabled'))
    if (!verifyTotp(user.totpSecret, code)) {
      throw new BadRequestException(errBody('totp_code_mismatch', 'Code does not match'))
    }
    const codes = generateRecoveryCodes()
    const hashed = codes.map((c) =>
      createHash('sha256').update(c).digest('hex'),
    )
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpEnabled: true,
        totpRecoveryCodes: hashed as Prisma.InputJsonValue,
      },
    })
    return { recoveryCodes: codes }
  }

  async disableTotp(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException(errBody('totp_not_enabled', '2FA is not enabled'))
    }
    const totpOk = verifyTotp(user.totpSecret, code)
    let recoveryOk = false
    if (!totpOk) {
      const stored = (user.totpRecoveryCodes as string[] | null) ?? []
      const hash = createHash('sha256').update(code).digest('hex')
      recoveryOk = stored.includes(hash)
    }
    if (!totpOk && !recoveryOk) {
      throw new BadRequestException(errBody('totp_code_mismatch', 'Code does not match'))
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: Prisma.JsonNull },
    })
  }

  async signOut(sessionId: string) {
    await this.prisma.session.deleteMany({ where: { id: sessionId } })
  }

  /**
   * Hash for storage. The plaintext is returned to the caller; the row keeps
   * only the hash. If the DB is compromised, the live session tokens aren't
   * usable as bearer tokens — an attacker would need to brute-force them.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  async createSession(userId: string): Promise<Session> {
    const plaintext = this.generateToken()
    const expiresAt = new Date(Date.now() + this.sessionTtlMs())
    const row = await this.prisma.session.create({
      data: {
        userId,
        token: this.hashToken(plaintext),
        expiresAt,
      },
    })
    // Returned row carries the plaintext in `.token` so callers can hand it
    // to the client. The DB column holds the hash.
    return { ...row, token: plaintext }
  }

  async sessionFromToken(token: string): Promise<SessionContext | null> {
    // chal_-prefixed tokens are 2FA challenges, not real sessions. Reject so
    // the auth guard can't be tricked into accepting a half-authenticated user.
    if (token.startsWith('chal_')) return null
    const session = await this.prisma.session.findUnique({
      where: { token: this.hashToken(token) },
      include: {
        user: {
          include: {
            memberships: {
              where: { isActive: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    })
    if (!session) return null
    if (session.expiresAt < new Date()) {
      await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined)
      return null
    }
    const membership = session.user.memberships[0]
    if (!membership) return null
    return {
      sessionId: session.id,
      user: session.user,
      membership,
    }
  }

  async updateMe(
    userId: string,
    input: {
      fullName?: string
      avatarUrl?: string | null
      locale?: 'pt-BR' | 'es' | 'en'
      phone?: string | null
    },
  ): Promise<User> {
    const data: Prisma.UserUpdateInput = {}
    if (input.fullName !== undefined) data.fullName = input.fullName
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl
    if (input.locale !== undefined) data.locale = input.locale
    if (input.phone !== undefined) data.phone = input.phone
    return this.prisma.user.update({ where: { id: userId }, data })
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    })
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException()
    }
    const ok = await argon2.verify(user.passwordHash, input.currentPassword)
    if (!ok) {
      throw new BadRequestException(errBody('current_password_wrong', 'Current password is incorrect'))
    }
    const passwordHash = await argon2.hash(input.newPassword)
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    })
  }

  // ─── password reset (forgot / reset) ──────────────────────────────────
  //
  // One-time tokens live in the Session table with a `reset_` prefix on the
  // STORED hash — the same trick 2FA challenges use with `chal_`. The auth
  // guard hashes the presented bearer token without a prefix, so neither kind
  // of row can ever authenticate a request.

  private resetTokenTtlMs(): number {
    return 60 * 60 * 1000 // 1 hour
  }

  private inviteTokenTtlMs(): number {
    return 7 * 24 * 60 * 60 * 1000 // 7 days: an invite waits for someone to notice it
  }

  /**
   * Always resolves without revealing whether the email exists. SSO-only
   * users are skipped for the same reason. A user with no password AND no SSO
   * is someone who was invited and never set one: they are exactly who needs
   * this link, and skipping them left invitees locked out for good.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user || (!user.passwordHash && user.ssoProvider)) return
    const plaintext = this.generateToken()
    await this.prisma.session.create({
      data: {
        userId: user.id,
        token: `reset_${this.hashToken(plaintext)}`,
        expiresAt: new Date(Date.now() + this.resetTokenTtlMs()),
      },
    })
    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3100'
    const link = `${base}/reset-password?token=${plaintext}`
    await this.email.send(
      user.email,
      'Redefinir sua senha na Cosmika',
      `Olá${user.fullName ? ` ${user.fullName}` : ''},\n\n` +
        `Recebemos um pedido para redefinir a senha da sua conta Cosmika.\n` +
        `O link abaixo vale por 1 hora:\n\n${link}\n\n` +
        `Se você não pediu isso, ignore este e-mail. Nada muda na sua conta.\n`,
    )
  }

  /**
   * Tell someone they were added to a workspace.
   *
   * Inviting used to create a user with no password and send nothing, so the
   * invitee had no way in. Now a new user gets a link to set a password (the
   * same one-time token a reset uses, valid for 7 days), and someone who
   * already has a password gets a sign-in link. Returns whether it was sent.
   */
  async sendInvitation(userId: string, accountName: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return false
    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? 'http://localhost:3100'
    const hello = `Olá${user.fullName ? ` ${user.fullName}` : ''},\n\n`
    if (user.passwordHash || user.ssoProvider) {
      return this.email.send(
        user.email,
        `Você foi adicionado a ${accountName} no Cosmika`,
        hello +
          `Você agora faz parte de ${accountName} no Cosmika.\n` +
          `Entre com o seu login de sempre:\n\n${base}/sign-in\n`,
      )
    }
    const plaintext = this.generateToken()
    await this.prisma.session.create({
      data: {
        userId: user.id,
        token: `reset_${this.hashToken(plaintext)}`,
        expiresAt: new Date(Date.now() + this.inviteTokenTtlMs()),
      },
    })
    return this.email.send(
      user.email,
      `Convite para ${accountName} no Cosmika`,
      hello +
        `Você foi convidado para ${accountName} no Cosmika.\n` +
        `Defina sua senha pelo link abaixo, que vale por 7 dias:\n\n` +
        `${base}/reset-password?token=${plaintext}\n\n` +
        `Se o link expirar, use "Esqueci minha senha" na tela de entrada.\n`,
    )
  }

  async resetPassword(input: { token: string; password: string }): Promise<void> {
    const row = await this.prisma.session.findUnique({
      where: { token: `reset_${this.hashToken(input.token)}` },
    })
    if (!row) throw new UnauthorizedException(errBody('reset_link_invalid', 'Invalid or expired reset link'))
    if (row.expiresAt < new Date()) {
      await this.prisma.session.delete({ where: { id: row.id } }).catch(() => undefined)
      throw new UnauthorizedException(errBody('reset_link_invalid', 'Invalid or expired reset link'))
    }
    const passwordHash = await argon2.hash(input.password)
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      // Revoke everything: live sessions, other reset tokens, 2FA challenges.
      this.prisma.session.deleteMany({ where: { userId: row.userId } }),
    ])
  }

  async getMeContext(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          include: {
            memberships: {
              where: { isActive: true },
              include: { account: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    })
    if (!session) throw new UnauthorizedException()
    const membership = session.user.memberships[0]
    if (!membership) throw new UnauthorizedException()
    return {
      user: session.user,
      membership,
      account: membership.account,
    }
  }
}

export const toUserDTO = (u: User) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  avatarUrl: u.avatarUrl,
  locale: u.locale,
  phone: u.phone,
  totpEnabled: u.totpEnabled,
  createdAt: u.createdAt.toISOString(),
})

// Some accounts come from the Nebula migration with a numeric (Chatwoot-style)
// language enum stored in defaultLocale (e.g. "16" = pt-BR). The web app's
// next-intl resolver expects the Cosmika enum values only — fall back to
// 'pt-BR' on anything else so legacy rows render sensibly.
const VALID_LOCALES = ['pt-BR', 'es', 'en'] as const
type ValidLocale = (typeof VALID_LOCALES)[number]
const NEBULA_NUMERIC_TO_LOCALE: Record<string, ValidLocale> = {
  '0': 'en',
  '9': 'pt-BR', // Nebula's "pt" → Cosmika supports pt-BR only
  '12': 'es',
  '16': 'pt-BR',
}
function normalizeLocale(raw: string | null | undefined): ValidLocale {
  if (raw && (VALID_LOCALES as readonly string[]).includes(raw)) {
    return raw as ValidLocale
  }
  if (raw && raw in NEBULA_NUMERIC_TO_LOCALE) {
    return NEBULA_NUMERIC_TO_LOCALE[raw]!
  }
  return 'pt-BR'
}

export const toAccountDTO = (a: Account) => ({
  id: a.id,
  slug: a.slug,
  name: a.name,
  domain: a.domain,
  status: a.status,
  plan: a.plan,
  defaultLocale: normalizeLocale(a.defaultLocale),
  defaultTimezone: a.defaultTimezone,
  adminAgentRequiresApproval: a.adminAgentRequiresApproval,
  teamScopedVisibility: a.teamScopedVisibility,
  createdAt: a.createdAt.toISOString(),
})

export const toMembershipDTO = (
  m: Prisma.AccountMemberGetPayload<{ include: { user: true } }>,
) => ({
  id: m.id,
  accountId: m.accountId,
  userId: m.userId,
  role: m.role,
  isActive: m.isActive,
  user: toUserDTO(m.user),
})
