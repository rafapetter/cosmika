import { channelsOver } from '../channels/channels.testing'
import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutoReplyService } from './auto-reply.service'

const NOW = new Date('2026-08-06T22:00:00Z')

const INBOX = {
  id: 'inb1',
  channelType: 'WHATSAPP',
  greetingEnabled: false,
  greetingMessage: null as string | null,
  workingHoursEnabled: false,
  outOfOfficeMessage: null as string | null,
}

const CONV = {
  id: 'c1',
  inboxId: 'inb1',
  accountId: 'acc1',
  customAttributes: {},
  contact: { phoneNumber: '+5511999999999' },
  inbox: INBOX,
}

function makeDeps(convOverrides: Record<string, unknown> = {}) {
  const prisma = {
    conversation: {
      findUnique: vi.fn().mockResolvedValue({ ...CONV, ...convOverrides }),
      update: vi.fn().mockResolvedValue({}),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: 'm1', createdAt: NOW }),
    },
  }
  const realtime = { publish: vi.fn().mockResolvedValue(undefined) }
  const whatsapp = {
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'w1' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
    resolveRecipient: vi.fn().mockResolvedValue(null),
    recipientForConversation: vi.fn().mockResolvedValue('+5511999999999'),
  }
  const workingHours = { isInboxOpenNow: vi.fn().mockResolvedValue(true) }
  const svc = new AutoReplyService(
    prisma as never,
    realtime as never,
    channelsOver(whatsapp) as never,
    workingHours as never,
  )
  return { svc, prisma, realtime, whatsapp, workingHours }
}

const base = { conversationId: 'c1', accountId: 'acc1', now: NOW }

afterEach(() => vi.restoreAllMocks())

describe('AutoReplyService — greeting', () => {
  it('sends the greeting on the first inbound and pushes it to WhatsApp', async () => {
    const { svc, prisma, whatsapp, realtime } = makeDeps({
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Olá! Como podemos ajudar?' },
    })
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(prisma.message.create.mock.calls[0]![0].data).toMatchObject({
      senderType: 'AGENT_BOT',
      content: 'Olá! Como podemos ajudar?',
      status: 'SENT',
    })
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '+5511999999999', 'Olá! Como podemos ajudar?')
    expect(realtime.publish).toHaveBeenCalled()
  })

  it('stays silent on later messages, when disabled, or with no text set', async () => {
    for (const [inbox, isFirstMessage] of [
      [{ ...INBOX, greetingEnabled: true, greetingMessage: 'Olá' }, false],
      [{ ...INBOX, greetingEnabled: false, greetingMessage: 'Olá' }, true],
      [{ ...INBOX, greetingEnabled: true, greetingMessage: null }, true],
    ] as const) {
      const { svc, prisma } = makeDeps({ inbox })
      await svc.maybeAutoReply({ ...base, isFirstMessage, flowHandled: false })
      expect(prisma.message.create).not.toHaveBeenCalled()
    }
  })
})

describe('AutoReplyService — out of office', () => {
  const OOO_INBOX = {
    ...INBOX,
    workingHoursEnabled: true,
    outOfOfficeMessage: 'Estamos fora do horário de atendimento.',
  }

  it('replies when the inbox is closed', async () => {
    const { svc, prisma, workingHours } = makeDeps({ inbox: OOO_INBOX })
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    await svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
    expect(prisma.message.create.mock.calls[0]![0].data.content).toBe(
      'Estamos fora do horário de atendimento.',
    )
    // Stamps the send so repeat messages don't re-trigger it.
    expect(prisma.conversation.update.mock.calls[0]![0].data.customAttributes).toMatchObject({
      lastOutOfOfficeAt: NOW.toISOString(),
    })
  })

  it('stays silent while the inbox is open', async () => {
    const { svc, prisma, workingHours } = makeDeps({ inbox: OOO_INBOX })
    workingHours.isInboxOpenNow.mockResolvedValue(true)
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('does not repeat within the cooldown, but does on a later visit', async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    const { svc, prisma, workingHours } = makeDeps({
      inbox: OOO_INBOX,
      customAttributes: { lastOutOfOfficeAt: recent },
    })
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    await svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
    expect(prisma.message.create).not.toHaveBeenCalled()

    const old = new Date(NOW.getTime() - 13 * 60 * 60 * 1000).toISOString()
    const later = makeDeps({ inbox: OOO_INBOX, customAttributes: { lastOutOfOfficeAt: old } })
    later.workingHours.isInboxOpenNow.mockResolvedValue(false)
    await later.svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
    expect(later.prisma.message.create).toHaveBeenCalled()
  })

  it('treats a missing or corrupt stamp as "never sent"', async () => {
    for (const attrs of [{}, { lastOutOfOfficeAt: 'not-a-date' }, { lastOutOfOfficeAt: 42 }]) {
      const { svc, prisma, workingHours } = makeDeps({
        inbox: OOO_INBOX,
        customAttributes: attrs,
      })
      workingHours.isInboxOpenNow.mockResolvedValue(false)
      await svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
      expect(prisma.message.create).toHaveBeenCalled()
    }
  })

  it('preserves other custom attributes when stamping', async () => {
    const { svc, prisma, workingHours } = makeDeps({
      inbox: OOO_INBOX,
      customAttributes: { migratedFromNebulaId: '123' },
    })
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    await svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
    expect(prisma.conversation.update.mock.calls[0]![0].data.customAttributes).toMatchObject({
      migratedFromNebulaId: '123',
      lastOutOfOfficeAt: NOW.toISOString(),
    })
  })
})

describe('AutoReplyService — guards', () => {
  it('says nothing when a flow already answered this turn', async () => {
    const { svc, prisma } = makeDeps({
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Olá' },
    })
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: true })
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled()
    expect(prisma.message.create).not.toHaveBeenCalled()
  })

  it('ignores an unknown conversation or one from another account', async () => {
    const { svc, prisma } = makeDeps()
    prisma.conversation.findUnique.mockResolvedValue(null)
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(prisma.message.create).not.toHaveBeenCalled()

    const other = makeDeps({ accountId: 'someone-else' })
    await other.svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(other.prisma.message.create).not.toHaveBeenCalled()
  })

  it('skips the WhatsApp push for pull-based channels', async () => {
    const { svc, whatsapp } = makeDeps({
      inbox: { ...INBOX, channelType: 'WEB_WIDGET', greetingEnabled: true, greetingMessage: 'Oi' },
    })
    // A widget inbox has no push address; the resolver reports that as null.
    whatsapp.recipientForConversation.mockResolvedValue(null)
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('falls back to the resolved recipient when the contact has no phone', async () => {
    const { svc, whatsapp } = makeDeps({
      contact: { phoneNumber: null },
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Oi' },
    })
    whatsapp.recipientForConversation.mockResolvedValue('5511888888888')
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('inb1', '5511888888888', 'Oi')
  })

  it('gives up quietly when there is no recipient at all', async () => {
    const { svc, whatsapp, prisma } = makeDeps({
      contact: null,
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Oi' },
    })
    // The resolver owns both the channel check and the address lookup.
    whatsapp.recipientForConversation.mockResolvedValue(null)
    await svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false })
    expect(prisma.message.create).toHaveBeenCalled() // still recorded in the thread
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('a send failure never breaks inbound ingestion', async () => {
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc, whatsapp } = makeDeps({
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Oi' },
    })
    whatsapp.sendOutbound.mockRejectedValue(new Error('Meta down'))
    await expect(
      svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false }),
    ).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()

    // Errors raised OUTSIDE send() (which has its own catch) reach the outer
    // handler — both Error and non-Error shapes.
    for (const boom of [new Error('db down'), 'a string blow-up']) {
      const broken = makeDeps()
      broken.prisma.conversation.findUnique.mockRejectedValue(boom)
      await expect(
        broken.svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false }),
      ).resolves.toBeUndefined()
    }
  })

  it('handles a conversation with null customAttributes', async () => {
    const { svc, prisma, workingHours } = makeDeps({
      customAttributes: null,
      inbox: { ...INBOX, workingHoursEnabled: true, outOfOfficeMessage: 'fechado' },
    })
    workingHours.isInboxOpenNow.mockResolvedValue(false)
    await svc.maybeAutoReply({ ...base, isFirstMessage: false, flowHandled: false })
    expect(prisma.message.create).toHaveBeenCalled()
    expect(prisma.conversation.update.mock.calls[0]![0].data.customAttributes).toEqual({
      lastOutOfOfficeAt: NOW.toISOString(),
    })
  })

  it('survives a non-Error rejection from the channel push', async () => {
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { svc, whatsapp } = makeDeps({
      inbox: { ...INBOX, greetingEnabled: true, greetingMessage: 'Oi' },
    })
    whatsapp.sendOutbound.mockRejectedValue('string blow-up')
    await expect(
      svc.maybeAutoReply({ ...base, isFirstMessage: true, flowHandled: false }),
    ).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
  })

  it('defaults `now` to the current time when not supplied', async () => {
    const { svc, workingHours } = makeDeps({
      inbox: { ...INBOX, workingHoursEnabled: true, outOfOfficeMessage: 'fechado' },
    })
    await svc.maybeAutoReply({
      conversationId: 'c1',
      accountId: 'acc1',
      isFirstMessage: false,
      flowHandled: false,
    })
    expect(workingHours.isInboxOpenNow).toHaveBeenCalledWith('acc1', 'inb1', expect.any(Date))
  })
})
