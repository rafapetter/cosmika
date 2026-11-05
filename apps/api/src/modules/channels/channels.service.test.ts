import { describe, expect, it, vi } from 'vitest'

import { ChannelsService } from './channels.service'
import { flowMediaFor } from './flow-media'
import { MetaChannelAdapter } from '../meta-messaging/meta-channel.adapter'
import { TelegramChannelAdapter } from '../telegram/telegram-channel.adapter'
import { WhatsappChannelAdapter } from './whatsapp-channel.adapter'

function makeWhatsapp() {
  return {
    recipientForConversation: vi.fn().mockResolvedValue('+5511'),
    messagingWindowFor: vi
      .fn()
      .mockResolvedValue({ open: true, lastInboundAt: 'a', expiresAt: 'b' }),
    sendOutbound: vi.fn().mockResolvedValue({ wamid: 'w-text' }),
    sendMedia: vi.fn().mockResolvedValue({ wamid: 'w-media' }),
    sendInteractive: vi.fn().mockResolvedValue({ wamid: 'w-int' }),
    stampOutbound: vi.fn().mockResolvedValue(undefined),
  }
}

function makeAttachments() {
  return {
    resolveOutboundMedia: vi.fn().mockResolvedValue({ kind: 'link', url: 'https://s3/x' }),
  }
}

function att(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    fileType: 'IMAGE',
    mimeType: 'image/png',
    fileSize: 1000,
    fileName: 'foto.png',
    storageKey: 'k/foto.png',
    ...over,
  } as never
}

function make() {
  const whatsapp = makeWhatsapp()
  const attachments = makeAttachments()
  const svc = new ChannelsService(whatsapp as never, attachments as never, {} as never, {} as never, {} as never)
  return { svc, whatsapp, attachments }
}

describe('ChannelsService.adapterFor', () => {
  it('returns the WhatsApp adapter, built once', () => {
    const { svc } = make()
    const a = svc.adapterFor('WHATSAPP')
    expect(a).toBeInstanceOf(WhatsappChannelAdapter)
    expect(svc.adapterFor('WHATSAPP')).toBe(a)
  })

  it('returns the Telegram, Messenger and Instagram adapters', () => {
    const { svc } = make()
    expect(svc.adapterFor('TELEGRAM')).toBeInstanceOf(TelegramChannelAdapter)
    expect(svc.adapterFor('FACEBOOK')).toBeInstanceOf(MetaChannelAdapter)
    expect(svc.adapterFor('INSTAGRAM')?.channelType).toBe('INSTAGRAM')
  })

  it('pull-based and unknown channels have no adapter', () => {
    const { svc } = make()
    expect(svc.adapterFor('WEB_WIDGET')).toBeNull()
    expect(svc.adapterFor('API')).toBeNull()
    expect(svc.adapterFor(null)).toBeNull()
    expect(svc.adapterFor(undefined)).toBeNull()
  })
})

describe('ChannelsService.windowFor', () => {
  it('asks the adapter for push-based channels', async () => {
    const { svc, whatsapp } = make()
    await expect(svc.windowFor('WHATSAPP', 'c1')).resolves.toMatchObject({ open: true })
    expect(whatsapp.messagingWindowFor).toHaveBeenCalledWith('c1')
  })

  it('is null for channels with no provider window', async () => {
    const { svc } = make()
    await expect(svc.windowFor('WEB_WIDGET', 'c1')).resolves.toBeNull()
  })
})

describe('ChannelsService.deliverMessage', () => {
  const conv = { id: 'c1', inboxId: 'i1' }

  it('does nothing for a pull-based channel', async () => {
    const { svc, whatsapp } = make()
    await svc.deliverMessage(conv, 'WEB_WIDGET', 'oi', [], 'm1')
    expect(whatsapp.recipientForConversation).not.toHaveBeenCalled()
  })

  it('does nothing without a reachable recipient', async () => {
    const { svc, whatsapp } = make()
    whatsapp.recipientForConversation.mockResolvedValue(null)
    await svc.deliverMessage(conv, 'WHATSAPP', 'oi', [], 'm1')
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })

  it('sends plain text and stamps the row', async () => {
    const { svc, whatsapp } = make()
    await svc.deliverMessage(conv, 'WHATSAPP', 'oi', [], 'm1')
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('i1', '+5511', 'oi')
    expect(whatsapp.stampOutbound).toHaveBeenCalledWith('m1', ['w-text'])
  })

  it('rides the text as the caption of the first attachment that takes one', async () => {
    const { svc, whatsapp } = make()
    await svc.deliverMessage(conv, 'WHATSAPP', 'veja', [att()], 'm1')
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('i1', '+5511', {
      kind: 'image',
      source: { link: 'https://s3/x' },
      fileName: 'foto.png',
      caption: 'veja',
    })
    expect(whatsapp.stampOutbound).toHaveBeenCalledWith('m1', ['w-media'])
  })

  it('sends text on its own when only caption-less media follows', async () => {
    const { svc, whatsapp, attachments } = make()
    attachments.resolveOutboundMedia.mockResolvedValue({
      kind: 'bytes',
      buffer: Buffer.from('x'),
      mimeType: 'audio/ogg',
      fileName: 'v.ogg',
    })
    await svc.deliverMessage(
      conv,
      'WHATSAPP',
      'ouça',
      [att({ fileType: 'AUDIO', mimeType: 'audio/ogg', fileName: null })],
      undefined,
    )
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('i1', '+5511', 'ouça')
    expect(whatsapp.sendMedia).toHaveBeenCalledWith('i1', '+5511', {
      kind: 'audio',
      source: { buffer: Buffer.from('x'), mimeType: 'audio/ogg', fileName: 'v.ogg' },
    })
    expect(whatsapp.stampOutbound).not.toHaveBeenCalled()
  })

  it('sends a body past the caption limit as its own text', async () => {
    const { svc, whatsapp } = make()
    const long = 'x'.repeat(2000)
    await svc.deliverMessage(conv, 'WHATSAPP', long, [att()], 'm1')
    expect(whatsapp.sendOutbound).toHaveBeenCalledWith('i1', '+5511', long)
    expect(whatsapp.sendMedia.mock.calls[0]![2]).not.toHaveProperty('caption')
  })

  it('refuses a file over every ceiling before sending anything', async () => {
    const { svc, whatsapp } = make()
    await expect(
      svc.deliverMessage(conv, 'WHATSAPP', 'oi', [att({ fileType: 'FILE', fileSize: 200 * 1024 * 1024 })]),
    ).rejects.toThrow(/WhatsApp accepts at most/)
    await expect(
      svc.deliverMessage(conv, 'WHATSAPP', 'oi', [
        att({ fileType: 'FILE', fileName: null, fileSize: 200 * 1024 * 1024 }),
      ]),
    ).rejects.toThrow(/attachment a1/)
    expect(whatsapp.sendOutbound).not.toHaveBeenCalled()
  })
})

describe('WhatsappChannelAdapter', () => {
  it('delegates every send and maps wamid to externalId', async () => {
    const whatsapp = makeWhatsapp()
    const a = new WhatsappChannelAdapter(whatsapp as never)
    await expect(a.recipientFor('c1')).resolves.toBe('+5511')
    await expect(a.sendText('i1', '+5511', 'oi')).resolves.toEqual({ externalId: 'w-text' })
    await expect(
      a.sendMedia('i1', '+5511', { kind: 'document', source: { link: 'u' } }),
    ).resolves.toEqual({ externalId: 'w-media' })
    await expect(
      a.sendInteractive('i1', '+5511', { kind: 'buttons', body: 'b', buttons: [] } as never),
    ).resolves.toEqual({ externalId: 'w-int' })
    await a.stampOutbound('m1', ['x'])
    expect(whatsapp.stampOutbound).toHaveBeenCalledWith('m1', ['x'])
    expect(a.mediaMaxBytes('image')).toBe(5 * 1024 * 1024)
    expect(a.mediaKindFor('IMAGE', 'image/svg+xml')).toBe('document')
    expect(a.captionFits('audio')).toBe(false)
    expect(a.captionFits('image')).toBe(true)
  })
})

describe('flowMediaFor', () => {
  it('reads the mime and file name off the URL', () => {
    expect(flowMediaFor({ mediaType: 'FILE', url: 'https://x/docs/Boleto%20Anuidade.pdf?sig=1' })).toEqual({
      fileType: 'FILE',
      mimeType: 'application/pdf',
      fileName: 'Boleto Anuidade.pdf',
    })
    expect(flowMediaFor({ mediaType: 'AUDIO', url: 'https://x/a.OGG' }).mimeType).toBe('audio/ogg')
  })

  it("falls back to the author's declared type when the URL has no extension", () => {
    expect(flowMediaFor({ mediaType: 'IMAGE', url: 'https://cdn/x/abc' })).toEqual({
      fileType: 'IMAGE',
      mimeType: 'image/jpeg',
      fileName: 'abc',
    })
    expect(flowMediaFor({ mediaType: 'VIDEO', url: 'https://cdn/' })).toMatchObject({
      mimeType: 'video/mp4',
      fileName: null,
    })
    expect(flowMediaFor({ mediaType: 'FILE', url: 'https://cdn/x/abc' }).mimeType).toBeNull()
  })

  it('copes with a relative or malformed URL', () => {
    expect(flowMediaFor({ mediaType: 'AUDIO', url: '/media/v.mp3#t=1' })).toMatchObject({
      mimeType: 'audio/mpeg',
      fileName: 'v.mp3',
    })
    expect(flowMediaFor({ mediaType: 'FILE', url: 'x/%E0%A4%A.pdf' }).fileName).toBe('%E0%A4%A.pdf')
  })
})
