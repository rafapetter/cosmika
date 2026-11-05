import { describe, expect, it, vi } from 'vitest'

import { AuthController } from './auth.controller'

const membership = { id: 'm1', accountId: 'acc1', userId: 'u1', role: 'AGENT' }
const envelopeParts = {
  user: { id: 'u1', email: 'a@b.c', fullName: 'A', locale: 'pt-BR', createdAt: new Date() },
  account: { id: 'acc1', name: 'X', locale: 'pt-BR', timezone: 'America/Sao_Paulo', createdAt: new Date() },
  membership,
  session: { id: 's1', token: 't', expiresAt: new Date() },
}
// req.ip is what Fastify resolved through the trusted proxy (trust-proxy.ts).
const req = { ip: '200.1.1.1', headers: { 'x-forwarded-for': '200.1.1.1', 'user-agent': 'UA' } }

function setup() {
  const authService = {
    signIn: vi.fn(),
    redeemTotpChallenge: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
  }
  const audit = { record: vi.fn().mockResolvedValue({}) }
  return { ctl: new AuthController(authService as never, audit as never), authService, audit }
}

describe('AuthController audit trail', () => {
  it('records auth.login with ip and user agent on a password sign-in', async () => {
    const s = setup()
    s.authService.signIn.mockResolvedValue({ kind: 'ok', ...envelopeParts })
    await s.ctl.signIn({ email: 'a@b.c', password: 'x' } as never, req)
    expect(s.audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'auth.login',
      target: 'user:u1',
      metadata: { ip: '200.1.1.1', userAgent: 'UA', method: 'password' },
    })
  })

  it('records nothing while the second factor is still pending', async () => {
    const s = setup()
    s.authService.signIn.mockResolvedValue({ kind: 'totp', challengeToken: 'c' })
    await s.ctl.signIn({} as never, req)
    expect(s.audit.record).not.toHaveBeenCalled()
  })

  it('records auth.login after the 2FA challenge', async () => {
    const s = setup()
    s.authService.redeemTotpChallenge.mockResolvedValue(envelopeParts)
    await s.ctl.totpChallenge({} as never, req)
    expect(s.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', metadata: expect.objectContaining({ method: 'totp' }) }),
    )
  })

  it('records auth.logout and survives an audit failure', async () => {
    const s = setup()
    s.audit.record.mockRejectedValue(new Error('db down'))
    await expect(
      s.ctl.signOut({ sessionId: 's1', user: { id: 'u1' }, membership } as never, req),
    ).resolves.toBeUndefined()
    expect(s.authService.signOut).toHaveBeenCalledWith('s1')
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout' }))
  })
})
