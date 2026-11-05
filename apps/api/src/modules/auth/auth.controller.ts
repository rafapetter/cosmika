import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import {
  AuthEnvelope,
  ChangePasswordInput,
  ForgotPasswordInput,
  MeResponse,
  ResetPasswordInput,
  SignInInput,
  SignUpInput,
  TotpChallengeInput,
  TotpDisableInput,
  TotpSetupResponse,
  TotpVerifyInput,
  TotpVerifyResponse,
  UpdateMeInput,
  UserDTO,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { AuditLogService } from '../audit-log/audit-log.service'
import { requestMeta } from '../audit-log/request-meta'

import { Auth, AuthGuard } from './auth.guard'
import {
  AuthService,
  SessionContext,
  toAccountDTO,
  toMembershipDTO,
  toUserDTO,
} from './auth.service'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly audit: AuditLogService,
  ) {}

  /** Security trail (PoC item 13): who signed in or out, when, from where.
   *  Never fails the auth request itself. */
  private recordAuth(
    action: 'auth.login' | 'auth.logout',
    membership: { accountId: string; userId: string },
    req: Parameters<typeof requestMeta>[0],
    extra?: Record<string, unknown>,
  ) {
    return this.audit
      .record({
        accountId: membership.accountId,
        actorId: membership.userId,
        action,
        target: `user:${membership.userId}`,
        metadata: { ...requestMeta(req), ...extra },
      })
      .catch(() => undefined)
  }

  @Post('sign-up')
  @Throttle({ default: { ttl: 60 * 60_000, limit: 5 } })
  @UsePipes(new ZodValidationPipe(SignUpInput))
  async signUp(@Body() body: SignUpInput): Promise<AuthEnvelope> {
    const { user, account, membership, session, checkout } =
      await this.authService.signUp(body)
    return {
      // Present only when a billing backend is configured; the web app sends
      // the user here to start the subscription after the trial.
      ...(checkout ? { checkout } : {}),
      session: {
        id: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
      user: toUserDTO(user),
      account: toAccountDTO(account),
      membership: toMembershipDTO({ ...membership, user }),
    }
  }

  @Post('sign-in')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UsePipes(new ZodValidationPipe(SignInInput))
  async signIn(
    @Body() body: SignInInput,
    @Req() req: Parameters<typeof requestMeta>[0],
  ): Promise<AuthEnvelope | { kind: 'totp'; challengeToken: string }> {
    const result = await this.authService.signIn(body)
    if (result.kind === 'totp') {
      return { kind: 'totp', challengeToken: result.challengeToken }
    }
    const { user, account, membership, session } = result
    await this.recordAuth('auth.login', membership, req, { method: 'password' })
    return {
      session: {
        id: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
      user: toUserDTO(user),
      account: toAccountDTO(account),
      membership: toMembershipDTO({ ...membership, user }),
    }
  }

  @Post('2fa/challenge')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UsePipes(new ZodValidationPipe(TotpChallengeInput))
  async totpChallenge(
    @Body() body: TotpChallengeInput,
    @Req() req: Parameters<typeof requestMeta>[0],
  ): Promise<AuthEnvelope> {
    const { user, account, membership, session } =
      await this.authService.redeemTotpChallenge(body)
    await this.recordAuth('auth.login', membership, req, { method: 'totp' })
    return {
      session: {
        id: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      },
      user: toUserDTO(user),
      account: toAccountDTO(account),
      membership: toMembershipDTO({ ...membership, user }),
    }
  }

  @Post('forgot-password')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60 * 60_000, limit: 5 } })
  @UsePipes(new ZodValidationPipe(ForgotPasswordInput))
  async forgotPassword(@Body() body: ForgotPasswordInput): Promise<void> {
    // Always 204 — never reveals whether the email exists.
    await this.authService.forgotPassword(body.email)
  }

  @Post('reset-password')
  @HttpCode(204)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UsePipes(new ZodValidationPipe(ResetPasswordInput))
  async resetPassword(@Body() body: ResetPasswordInput): Promise<void> {
    await this.authService.resetPassword(body)
  }

  @Post('sign-out')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async signOut(
    @Auth() auth: SessionContext,
    @Req() req: Parameters<typeof requestMeta>[0],
  ): Promise<void> {
    await this.authService.signOut(auth.sessionId)
    await this.recordAuth('auth.logout', auth.membership, req)
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Auth() auth: SessionContext): Promise<MeResponse> {
    const ctx = await this.authService.getMeContext(auth.sessionId)
    return {
      user: toUserDTO(ctx.user),
      account: toAccountDTO(ctx.account),
      membership: toMembershipDTO({ ...ctx.membership, user: ctx.user }),
    }
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  async updateMe(
    @Auth() auth: SessionContext,
    @Body(new ZodValidationPipe(UpdateMeInput)) body: UpdateMeInput,
  ): Promise<UserDTO> {
    const user = await this.authService.updateMe(auth.user.id, body)
    return toUserDTO(user)
  }

  @Post('me/password')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async changePassword(
    @Auth() auth: SessionContext,
    @Body(new ZodValidationPipe(ChangePasswordInput)) body: ChangePasswordInput,
  ): Promise<void> {
    await this.authService.changePassword(auth.user.id, body)
  }

  @Post('me/2fa/setup')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async totpSetup(@Auth() auth: SessionContext): Promise<TotpSetupResponse> {
    return this.authService.setupTotp(auth.user.id)
  }

  @Post('me/2fa/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async totpVerify(
    @Auth() auth: SessionContext,
    @Body(new ZodValidationPipe(TotpVerifyInput)) body: TotpVerifyInput,
  ): Promise<TotpVerifyResponse> {
    const { recoveryCodes } = await this.authService.verifyTotpSetup(
      auth.user.id,
      body.code,
    )
    return { enabled: true, recoveryCodes }
  }

  @Post('me/2fa/disable')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async totpDisable(
    @Auth() auth: SessionContext,
    @Body(new ZodValidationPipe(TotpDisableInput)) body: TotpDisableInput,
  ): Promise<void> {
    await this.authService.disableTotp(auth.user.id, body.code)
  }
}
