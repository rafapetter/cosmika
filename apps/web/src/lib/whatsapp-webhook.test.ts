import { describe, expect, it } from 'vitest'

import { whatsappWebhookUrl } from './whatsapp-webhook'

describe('whatsappWebhookUrl', () => {
  it('resolves a relative API base against the page origin', () => {
    expect(whatsappWebhookUrl('/api', 'https://app.cosmobots.io', 'inb1')).toBe(
      'https://app.cosmobots.io/api/webhooks/whatsapp/inb1',
    )
    expect(whatsappWebhookUrl('/api/', 'https://app.cosmobots.io', 'inb1')).toBe(
      'https://app.cosmobots.io/api/webhooks/whatsapp/inb1',
    )
  })

  it('keeps an absolute API base as is', () => {
    expect(whatsappWebhookUrl('https://api.example.com', 'https://app.example.com', 'inb2')).toBe(
      'https://api.example.com/webhooks/whatsapp/inb2',
    )
  })
})
