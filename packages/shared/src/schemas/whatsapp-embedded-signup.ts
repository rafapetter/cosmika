import { z } from 'zod'

// WhatsApp Embedded Signup (v4), where a customer connects their own WhatsApp
// Business Account to our Tech Provider app from inside Cosmika instead of
// pasting credentials from a Meta app of their own. Off unless the API runs
// with WHATSAPP_EMBEDDED_SIGNUP_ENABLED=1, and then only for the accounts in
// WHATSAPP_EMBEDDED_SIGNUP_ACCOUNT_IDS; see docs/whatsapp-embedded-signup.md.

// How a WhatsApp channel came to exist. Stored on the channel config by the
// server only: no create or update input accepts it, so a channel cannot be
// made to look onboarded (and receive our app's WABA events) by a client.
export const WhatsappOnboarding = z.enum(['embedded_signup', 'coexistence'])
export type WhatsappOnboarding = z.infer<typeof WhatsappOnboarding>

// The `event` of a WA_EMBEDDED_SIGNUP message that means the customer got to
// the end. FINISH_ONLY_WABA has no phone number yet, so it cannot become a
// channel; the screen asks the customer to add one and run the flow again.
export const EmbeddedSignupFinishEvent = z.enum([
  'FINISH',
  'FINISH_ONLY_WABA',
  'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
])
export type EmbeddedSignupFinishEvent = z.infer<typeof EmbeddedSignupFinishEvent>

// What the screen needs to open the Meta popup. `enabled: false` hides the
// button; the other fields are only present when it is true.
export const EmbeddedSignupConfigDTO = z.object({
  enabled: z.boolean(),
  appId: z.string().optional(),
  configId: z.string().optional(),
  graphApiVersion: z.string().optional(),
})
export type EmbeddedSignupConfigDTO = z.infer<typeof EmbeddedSignupConfigDTO>

// Graph ids are numeric strings. Checking the shape keeps anything else out
// of the URLs the server builds from them.
const GraphId = z.string().regex(/^\d{1,32}$/, 'must be a numeric Meta id')

export const CompleteEmbeddedSignupInput = z
  .object({
    // The exchangeable code from FB.login. Lives 30 seconds.
    code: z.string().min(10).max(2048),
    event: EmbeddedSignupFinishEvent,
    wabaId: GraphId,
    phoneNumberId: GraphId.optional(),
    businessId: GraphId.optional(),
    // Channel name. Defaults to the number's verified name when omitted.
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
export type CompleteEmbeddedSignupInput = z.infer<typeof CompleteEmbeddedSignupInput>
