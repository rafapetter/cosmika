import { z } from 'zod'

export const TotpSetupResponse = z.object({
  /** Base32-encoded secret. Show in case user can't scan the QR. */
  secret: z.string(),
  /** otpauth:// URL for QR rendering. */
  otpauthUrl: z.string(),
})
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>

export const TotpVerifyInput = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
})
export type TotpVerifyInput = z.infer<typeof TotpVerifyInput>

export const TotpVerifyResponse = z.object({
  enabled: z.boolean(),
  /** Plaintext recovery codes — returned once. Lost if user closes the tab. */
  recoveryCodes: z.array(z.string()),
})
export type TotpVerifyResponse = z.infer<typeof TotpVerifyResponse>

export const TotpDisableInput = z.object({
  /** Either a current TOTP code or one of the recovery codes. */
  code: z.string().min(1).max(40),
})
export type TotpDisableInput = z.infer<typeof TotpDisableInput>

export const TotpChallengeInput = z.object({
  challengeToken: z.string(),
  code: z.string().min(6).max(40),
})
export type TotpChallengeInput = z.infer<typeof TotpChallengeInput>

/**
 * `/auth/sign-in` returns one of two shapes:
 *   - `{ kind: 'session', ...AuthEnvelope }` — normal flow, no 2FA.
 *   - `{ kind: 'totp', challengeToken }` — user has 2FA enabled; client must
 *     POST /auth/2fa/challenge with the code to receive a session.
 */
export const SignInTotpChallenge = z.object({
  kind: z.literal('totp'),
  challengeToken: z.string(),
})
export type SignInTotpChallenge = z.infer<typeof SignInTotpChallenge>
