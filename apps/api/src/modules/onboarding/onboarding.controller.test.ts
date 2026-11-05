import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { OnboardingController } from './onboarding.controller'

const AUTH = { user: { id: 'u1' } } as never
const STATUS = {
  steps: { channel: true, firstMessage: false, automation: false, team: false },
  completed: 1,
  total: 4,
}

function make(member: unknown) {
  const svc = { status: vi.fn().mockResolvedValue(STATUS) }
  const prisma = { accountMember: { findUnique: vi.fn().mockResolvedValue(member) } }
  return { ctrl: new OnboardingController(svc as never, prisma as never), svc }
}

describe('OnboardingController.get', () => {
  it('returns the status for an active member', async () => {
    const { ctrl, svc } = make({ isActive: true })
    await expect(ctrl.get(AUTH, 'acc1')).resolves.toEqual(STATUS)
    expect(svc.status).toHaveBeenCalledWith('acc1')
  })

  it('rejects someone who is not a member of the account', async () => {
    const { ctrl, svc } = make(null)
    await expect(ctrl.get(AUTH, 'acc1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(svc.status).not.toHaveBeenCalled()
  })

  it('rejects a deactivated member', async () => {
    const { ctrl } = make({ isActive: false })
    await expect(ctrl.get(AUTH, 'acc1')).rejects.toBeInstanceOf(ForbiddenException)
  })
})
