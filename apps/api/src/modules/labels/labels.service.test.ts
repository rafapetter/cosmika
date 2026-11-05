import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LabelsService } from './labels.service'

function makePrisma() {
  return {
    accountMember: { findUnique: vi.fn() },
    label: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    conversation: { findUnique: vi.fn() },
    conversationLabel: {
      findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
}
type Prisma = ReturnType<typeof makePrisma>
const makeActivity = () => ({
  log: vi.fn().mockResolvedValue(undefined),
  actorName: vi.fn().mockResolvedValue('Ana Agent'),
})
const makeService = (p: Prisma) => new LabelsService(p as never, makeActivity() as never)

const ADMIN = { id: 'm1', userId: 'u1', accountId: 'acc1', role: 'ADMINISTRATOR', isActive: true }
const SUPER = { ...ADMIN, role: 'SUPERVISOR' }
const AGENT = { ...ADMIN, role: 'AGENT' }

describe('LabelsService.list', () => {
  let prisma: Prisma
  beforeEach(() => { prisma = makePrisma() })

  it('403 non-member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).list('u1', 'acc1')).rejects.toThrow(ForbiddenException)
  })

  it('returns labels sorted by title for any active member', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    prisma.label.findMany.mockResolvedValue([{ title: 'A' }])
    expect(await makeService(prisma).list('u1', 'acc1')).toEqual([{ title: 'A' }])
    expect(prisma.label.findMany).toHaveBeenCalledWith({
      where: { accountId: 'acc1' },
      orderBy: { title: 'asc' },
    })
  })
})

describe('LabelsService.create', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 for AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).create('u1', 'acc1', { title: 'X', color: '#fff' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('SUPERVISOR can create', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(SUPER)
    prisma.label.create.mockResolvedValue({ id: 'l1' })
    await makeService(prisma).create('u1', 'acc1', { title: 'X', color: '#fff' })
    expect(prisma.label.create).toHaveBeenCalledWith({
      data: { accountId: 'acc1', title: 'X', color: '#fff' },
    })
  })

  it('rethrows non-P2002 prisma errors', async () => {
    prisma.label.create.mockRejectedValue(new Error('weird'))
    await expect(
      makeService(prisma).create('u1', 'acc1', { title: 'X', color: '#fff' }),
    ).rejects.toThrow('weird')
  })

  it('rethrows non-prisma errors (no .code field)', async () => {
    prisma.label.create.mockRejectedValue('not even an error object')
    await expect(
      makeService(prisma).create('u1', 'acc1', { title: 'X', color: '#fff' }),
    ).rejects.toBe('not even an error object')
  })

  it('converts P2002 (unique constraint) to 409 Conflict', async () => {
    prisma.label.create.mockRejectedValue({ code: 'P2002' })
    await expect(
      makeService(prisma).create('u1', 'acc1', { title: 'X', color: '#fff' }),
    ).rejects.toThrow(ConflictException)
  })
})

describe('LabelsService.update', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'l1', { title: 'New' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown label', async () => {
    prisma.label.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).update('u1', 'acc1', 'l1', { title: 'New' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 IDOR', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'l1', { title: 'New' }),
    ).rejects.toThrow(NotFoundException)
  })

  it('applies partial title only', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.label.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'l1', { title: 'Renamed' })
    expect(prisma.label.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { title: 'Renamed' },
    })
  })

  it('applies partial color only', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.label.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'l1', { color: '#000' })
    expect(prisma.label.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { color: '#000' },
    })
  })

  it('sends empty data when no fields provided', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.label.update.mockResolvedValue({})
    await makeService(prisma).update('u1', 'acc1', 'l1', {})
    expect(prisma.label.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: {} })
  })

  it('409 on P2002 collision', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.label.update.mockRejectedValue({ code: 'P2002' })
    await expect(
      makeService(prisma).update('u1', 'acc1', 'l1', { title: 'dupe' }),
    ).rejects.toThrow(ConflictException)
  })

  it('rethrows non-P2002 errors', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.label.update.mockRejectedValue(new Error('other'))
    await expect(
      makeService(prisma).update('u1', 'acc1', 'l1', { title: 'x' }),
    ).rejects.toThrow('other')
  })
})

describe('LabelsService.remove', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(ADMIN)
  })

  it('403 AGENT', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
    await expect(makeService(prisma).remove('u1', 'acc1', 'l1')).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('404 unknown', async () => {
    prisma.label.findUnique.mockResolvedValue(null)
    await expect(makeService(prisma).remove('u1', 'acc1', 'l1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('404 IDOR', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    await expect(makeService(prisma).remove('u1', 'acc1', 'l1')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('deletes when authorised', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(prisma).remove('u1', 'acc1', 'l1')
    expect(prisma.label.delete).toHaveBeenCalledWith({ where: { id: 'l1' } })
  })
})

describe('LabelsService.applyToConversation', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('non-member 403', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown label', async () => {
    prisma.label.findUnique.mockResolvedValue(null)
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await expect(
      makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow('Label')
  })

  it('404 label from other account', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await expect(
      makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow('Label')
  })

  it('404 unknown conversation', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.conversation.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow('Conversation')
  })

  it('404 conversation from other account', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'other-acc' })
    await expect(
      makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow('Conversation')
  })

  it('upserts ConversationLabel when both exist + belong to account', async () => {
    prisma.label.findUnique.mockResolvedValue({ accountId: 'acc1' })
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(prisma).applyToConversation('u1', 'acc1', 'cv1', 'l1')
    expect(prisma.conversationLabel.upsert).toHaveBeenCalledWith({
      where: { conversationId_labelId: { conversationId: 'cv1', labelId: 'l1' } },
      create: { conversationId: 'cv1', labelId: 'l1' },
      update: {},
    })
  })
})

describe('LabelsService.removeFromConversation', () => {
  let prisma: Prisma
  beforeEach(() => {
    prisma = makePrisma()
    prisma.accountMember.findUnique.mockResolvedValue(AGENT)
  })

  it('non-member 403', async () => {
    prisma.accountMember.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).removeFromConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow(ForbiddenException)
  })

  it('404 unknown / IDOR conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null)
    await expect(
      makeService(prisma).removeFromConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('404 conversation from other account', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'other' })
    await expect(
      makeService(prisma).removeFromConversation('u1', 'acc1', 'cv1', 'l1'),
    ).rejects.toThrow(NotFoundException)
  })

  it('deleteMany by conversationId + labelId pair', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ accountId: 'acc1' })
    await makeService(prisma).removeFromConversation('u1', 'acc1', 'cv1', 'l1')
    expect(prisma.conversationLabel.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 'cv1', labelId: 'l1' },
    })
  })
})

describe('LabelsService.toDTO', () => {
  it('maps every field with ISO timestamps', () => {
    const svc = new LabelsService(makePrisma() as never, makeActivity() as never)
    expect(
      svc.toDTO({
        id: 'l1',
        accountId: 'acc1',
        title: 'Bug',
        color: '#dc2626',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
      } as never),
    ).toEqual({
      id: 'l1',
      accountId: 'acc1',
      title: 'Bug',
      color: '#dc2626',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
  })
})


describe('LabelsService — transcript activity notes', () => {
  const CONV = { id: 'c1', accountId: 'acc1', inboxId: 'inb1' }
  const LABEL = { id: 'l1', accountId: 'acc1', title: 'Urgente' }

  function setup() {
    const prisma = makePrisma()
    const activity = {
      log: vi.fn().mockResolvedValue(undefined),
      actorName: vi.fn().mockResolvedValue('Ana Agent'),
    }
    const svc = new LabelsService(prisma as never, activity as never)
    prisma.accountMember.findUnique.mockResolvedValue({ isActive: true })
    prisma.label.findUnique.mockResolvedValue(LABEL)
    prisma.conversation.findUnique.mockResolvedValue(CONV)
    return { prisma, activity, svc }
  }

  it('notes a newly added label', async () => {
    const { activity, svc } = setup()
    await svc.applyToConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log).toHaveBeenCalledWith(
      CONV,
      expect.objectContaining({ type: 'label', text: 'Label Urgente added by Ana Agent' }),
    )
  })

  it('stays silent when the label was already applied', async () => {
    const { prisma, activity, svc } = setup()
    prisma.conversationLabel.findUnique.mockResolvedValue({ conversationId: 'c1', labelId: 'l1' })
    await svc.applyToConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log).not.toHaveBeenCalled()
  })

  it('notes a removal, and stays silent when nothing was removed', async () => {
    const { prisma, activity, svc } = setup()
    await svc.removeFromConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log).toHaveBeenCalledWith(
      CONV,
      expect.objectContaining({ type: 'label', text: 'Label Urgente removed by Ana Agent' }),
    )

    activity.log.mockClear()
    prisma.conversationLabel.deleteMany.mockResolvedValue({ count: 0 })
    await svc.removeFromConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log).not.toHaveBeenCalled()
  })

  it('falls back to "unknown" if the label row vanished mid-removal', async () => {
    const { prisma, activity, svc } = setup()
    prisma.conversationLabel.deleteMany.mockResolvedValue({ count: 1 })
    // removeFromConversation looks the label up once, after deleting.
    prisma.label.findUnique.mockResolvedValue(null)
    await svc.removeFromConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log.mock.calls[0]![1].text).toBe('Label unknown removed by Ana Agent')
  })

  it('omits the actor when the user has no name', async () => {
    const { activity, svc } = setup()
    activity.actorName.mockResolvedValue(null)
    await svc.applyToConversation('u1', 'acc1', 'c1', 'l1')
    expect(activity.log.mock.calls[0]![1].text).toBe('Label Urgente added')
  })
})
