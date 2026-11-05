// AccountProfileService: who may read and write the welcome-flow answers,
// what a partial save does to the answers it did not mention, and which of
// the two end-state timestamps a save is allowed to set.
//
// The failure modes that matter here are an agent reading the account's
// commercial answers, a later screen wiping an earlier one, and a save from
// Settings quietly reopening a profile that was already finished (which would
// put the account back in the funnel as "abandoned").
import { ForbiddenException } from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccountProfileService, toAccountProfileDTO } from './account-profile.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    accountProfile: { findUnique: vi.fn(), upsert: vi.fn() },
  }
}
type Prisma = ReturnType<typeof makePrisma>

function makeAudit() {
  return { record: vi.fn().mockResolvedValue({}) }
}

function makeService(p: Prisma, audit = makeAudit()) {
  return { svc: new AccountProfileService(p as never, audit as never), audit }
}

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const AGENT = { ...ADMIN, role: 'AGENT' }

const ROW = {
  id: 'p1',
  accountId: 'acc1',
  businessIndustry: 'healthcare',
  companySize: 'upTo15',
  businessDescription: 'Clínica odontológica',
  supportToday: 'internalTeam',
  channelsToday: ['whatsapp', 'email'],
  conversationVolume: 'upTo500',
  intendedFeatures: ['humanSupport', 'aiAgent'],
  expectedVolume: 'upTo1500',
  expectedAiShare: 'aboutHalf',
  version: 1,
  startedAt: new Date('2026-09-18T10:00:00Z'),
  lastStep: 'intent',
  completedAt: null as Date | null,
  skippedAt: null as Date | null,
  filledByUserId: 'u1',
  extra: null,
  createdAt: new Date('2026-09-18T10:00:00Z'),
  updatedAt: new Date('2026-09-18T10:05:00Z'),
}

let prisma: Prisma
beforeEach(() => {
  prisma = makePrisma()
})

describe('AccountProfileService.assertAdmin', () => {
  it('refuses a non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    await expect(svc.assertAdmin('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('refuses a member who was deactivated', async () => {
    prisma.accountMember.findUnique.mockResolvedValue({ ...ADMIN, isActive: false })
    const { svc } = makeService(prisma)
    await expect(svc.assertAdmin('u1', 'acc1')).rejects.toThrow('Not a member')
  })

  it('refuses an agent: these are answers about the business', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.assertAdmin('u1', 'acc1')).rejects.toThrow(
      'Administrator role required',
    )
  })

  it('lets an active administrator through', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    const { svc } = makeService(prisma)
    await expect(svc.assertAdmin('u1', 'acc1')).resolves.toBeUndefined()
  })
})

describe('AccountProfileService.get', () => {
  beforeEach(() => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('returns null when the account never started the flow', async () => {
    prisma.accountProfile.findUnique.mockResolvedValue(null)
    const { svc } = makeService(prisma)
    expect(await svc.get('u1', 'acc1')).toBeNull()
  })

  it('returns the answers plus the flow state, dates as ISO strings', async () => {
    prisma.accountProfile.findUnique.mockResolvedValue(ROW)
    const { svc } = makeService(prisma)
    const dto = await svc.get('u1', 'acc1')
    expect(dto).toEqual({
      accountId: 'acc1',
      businessIndustry: 'healthcare',
      companySize: 'upTo15',
      businessDescription: 'Clínica odontológica',
      supportToday: 'internalTeam',
      channelsToday: ['whatsapp', 'email'],
      conversationVolume: 'upTo500',
      intendedFeatures: ['humanSupport', 'aiAgent'],
      expectedVolume: 'upTo1500',
      expectedAiShare: 'aboutHalf',
      version: 1,
      lastStep: 'intent',
      startedAt: '2026-09-18T10:00:00.000Z',
      completedAt: null,
      skippedAt: null,
    })
  })

  it('never leaks the internal columns', async () => {
    prisma.accountProfile.findUnique.mockResolvedValue(ROW)
    const { svc } = makeService(prisma)
    const dto = (await svc.get('u1', 'acc1')) as unknown as Record<string, unknown>
    expect(Object.keys(dto)).not.toContain('filledByUserId')
    expect(Object.keys(dto)).not.toContain('extra')
    expect(Object.keys(dto)).not.toContain('id')
  })

  it('refuses before it reads anything', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc } = makeService(prisma)
    await expect(svc.get('u1', 'acc1')).rejects.toThrow(ForbiddenException)
    expect(prisma.accountProfile.findUnique).not.toHaveBeenCalled()
  })
})

describe('AccountProfileService.upsert', () => {
  beforeEach(() => {
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
    prisma.accountProfile.upsert.mockResolvedValue(ROW)
  })

  it('refuses an agent before it writes anything', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    const { svc, audit } = makeService(prisma)
    await expect(svc.upsert('u1', 'acc1', {})).rejects.toThrow(ForbiddenException)
    expect(prisma.accountProfile.upsert).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('writes only the fields the screen asked about', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', {
      businessIndustry: 'retail',
      companySize: 'solo',
      lastStep: 'company',
    })
    const call = prisma.accountProfile.upsert.mock.calls[0]![0]
    expect(call.where).toEqual({ accountId: 'acc1' })
    expect(call.update).toEqual({
      filledByUserId: 'u1',
      businessIndustry: 'retail',
      companySize: 'solo',
      lastStep: 'company',
    })
    expect(call.create).toEqual({
      accountId: 'acc1',
      filledByUserId: 'u1',
      businessIndustry: 'retail',
      companySize: 'solo',
      lastStep: 'company',
    })
  })

  it('carries every answer field through when a screen sends them', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', {
      businessDescription: 'Vendemos café',
      supportToday: 'myself',
      channelsToday: ['whatsapp'],
      conversationVolume: 'upTo50',
      intendedFeatures: ['flows'],
      expectedVolume: 'upTo500',
      expectedAiShare: 'minimal',
    })
    expect(prisma.accountProfile.upsert.mock.calls[0]![0].update).toEqual({
      filledByUserId: 'u1',
      businessDescription: 'Vendemos café',
      supportToday: 'myself',
      channelsToday: ['whatsapp'],
      conversationVolume: 'upTo50',
      intendedFeatures: ['flows'],
      expectedVolume: 'upTo500',
      expectedAiShare: 'minimal',
    })
  })

  it('clears an answer when the field is sent as null', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { businessIndustry: null, expectedAiShare: null })
    expect(prisma.accountProfile.upsert.mock.calls[0]![0].update).toEqual({
      filledByUserId: 'u1',
      businessIndustry: null,
      expectedAiShare: null,
    })
  })

  it('an empty body touches nothing but who saved it', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', {})
    expect(prisma.accountProfile.upsert.mock.calls[0]![0].update).toEqual({
      filledByUserId: 'u1',
    })
  })

  it('completing stamps completedAt and nothing else', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { state: 'completed', lastStep: 'done' })
    const update = prisma.accountProfile.upsert.mock.calls[0]![0].update
    expect(update.completedAt).toBeInstanceOf(Date)
    expect(update.skippedAt).toBeUndefined()
  })

  it('skipping stamps skippedAt and nothing else', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { state: 'skipped', lastStep: 'company' })
    const update = prisma.accountProfile.upsert.mock.calls[0]![0].update
    expect(update.skippedAt).toBeInstanceOf(Date)
    expect(update.completedAt).toBeUndefined()
  })

  it('an in-progress save never touches either end timestamp', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { state: 'in_progress', lastStep: 'business' })
    const update = prisma.accountProfile.upsert.mock.calls[0]![0].update
    expect(update.completedAt).toBeUndefined()
    expect(update.skippedAt).toBeUndefined()
  })

  it('a later edit from Settings cannot unfinish a finished profile', async () => {
    const { svc } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { businessIndustry: 'education' })
    const update = prisma.accountProfile.upsert.mock.calls[0]![0].update
    expect(update).not.toHaveProperty('completedAt')
    expect(update).not.toHaveProperty('skippedAt')
  })

  it('audits each screen without copying the answers into the log', async () => {
    const { svc, audit } = makeService(prisma)
    await svc.upsert('u1', 'acc1', {
      businessIndustry: 'finance',
      lastStep: 'company',
    })
    expect(audit.record).toHaveBeenCalledWith({
      accountId: 'acc1',
      actorId: 'u1',
      action: 'account_profile.saved',
      target: 'account:acc1',
      metadata: { lastStep: 'company' },
    })
  })

  it('audits the end of the flow under its own action', async () => {
    const { svc, audit } = makeService(prisma)
    await svc.upsert('u1', 'acc1', { state: 'completed', lastStep: 'done' })
    expect(audit.record.mock.calls[0]![0].action).toBe('onboarding_flow.completed')

    await svc.upsert('u1', 'acc1', { state: 'skipped' })
    expect(audit.record.mock.calls[1]![0]).toMatchObject({
      action: 'onboarding_flow.skipped',
      metadata: { lastStep: null },
    })
  })

  it('returns the saved profile as a DTO', async () => {
    const { svc } = makeService(prisma)
    const dto = await svc.upsert('u1', 'acc1', { lastStep: 'intent' })
    expect(dto.accountId).toBe('acc1')
    expect(dto.startedAt).toBe('2026-09-18T10:00:00.000Z')
  })
})

describe('toAccountProfileDTO', () => {
  it('serialises the end timestamps when they are set', () => {
    const dto = toAccountProfileDTO({
      ...ROW,
      completedAt: new Date('2026-09-18T11:00:00Z'),
      skippedAt: new Date('2026-09-18T12:00:00Z'),
    } as never)
    expect(dto.completedAt).toBe('2026-09-18T11:00:00.000Z')
    expect(dto.skippedAt).toBe('2026-09-18T12:00:00.000Z')
  })
})
