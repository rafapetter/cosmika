import { ChannelsService } from './channels.service'

/**
 * A real ChannelsService over test doubles, so suites that mock WhatsappService
 * keep asserting on the same `sendOutbound` / `sendMedia` spies they always
 * have: the adapter only delegates.
 */
export function channelsOver(
  whatsapp: unknown,
  attachments: unknown = {},
  telegram: unknown = {},
  inbound: unknown = {},
  meta: unknown = {},
): ChannelsService {
  return new ChannelsService(
    whatsapp as never,
    attachments as never,
    telegram as never,
    inbound as never,
    meta as never,
  )
}
