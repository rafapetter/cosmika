import { z } from 'zod'

import { DeviationPolicy, FlowMode } from './flow'

export const ChannelType = z.enum([
  'WHATSAPP',
  'WEB_WIDGET',
  'EMAIL',
  'API',
  'TELEGRAM',
  'FACEBOOK',
  'INSTAGRAM',
])
export type ChannelType = z.infer<typeof ChannelType>

export const AiAutoreplyMode = z.enum(['DRAFT', 'AUTO_SAFE', 'AUTO_FULL'])
export type AiAutoreplyMode = z.infer<typeof AiAutoreplyMode>

// Channel-specific config schemas.

// A field the widget asks the visitor to fill in before starting a chat.
export const WidgetPreChatField = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, underscore only'),
  label: z.string().min(1).max(80),
  // 'phone' becomes the contact's phone number, which is how a website
  // visitor and the same person on WhatsApp end up as one contact.
  type: z.enum(['text', 'email', 'phone']),
  required: z.boolean(),
})
export type WidgetPreChatField = z.infer<typeof WidgetPreChatField>

export const WebWidgetConfig = z.object({
  websiteName: z.string().min(1),
  websiteUrl: z.string().url().optional(),
  primaryColor: z
    .string()
    .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'must be #rgb or #rrggbb')
    .optional(),
  welcomeMessage: z.string().max(500).optional(),
  launcherText: z.string().max(60).optional(),
  preChatFields: z.array(WidgetPreChatField).max(10).optional(),
})
export type WebWidgetConfig = z.infer<typeof WebWidgetConfig>

// Public, secret-free widget config served to the embed/host page.
export const WidgetPublicConfig = z.object({
  title: z.string(),
  primaryColor: z.string().nullable(),
  welcomeMessage: z.string().nullable(),
  launcherText: z.string().nullable(),
  preChatFields: z.array(WidgetPreChatField),
})
export type WidgetPublicConfig = z.infer<typeof WidgetPublicConfig>

export const EmailConfig = z.object({
  // forwardingAddress is read-only on responses; clients should not set it.
  forwardingAddress: z.string().email().optional(),
  replyToAddress: z.string().email().optional(),
  signature: z.string().max(2000).optional(),
})
export type EmailConfig = z.infer<typeof EmailConfig>

export const WhatsappConfig = z.object({
  phoneNumberId: z.string().min(1),
  businessAccountId: z.string().min(1),
  // accessToken / appSecret / webhookVerifyToken are write-only — never echoed back.
  accessToken: z.string().min(10).optional(),
  appSecret: z.string().min(10).optional(),
  webhookVerifyToken: z.string().min(1).optional(),
})
export type WhatsappConfig = z.infer<typeof WhatsappConfig>

// Every field an administrator may replace on an existing WhatsApp channel.
// Exactly the keys WhatsappConfig accepts at create time, no more: the
// service copies these by name, never by spreading the body.
export const WHATSAPP_CREDENTIAL_FIELDS = [
  'phoneNumberId',
  'businessAccountId',
  'accessToken',
  'appSecret',
  'webhookVerifyToken',
] as const
export type WhatsappCredentialField = (typeof WHATSAPP_CREDENTIAL_FIELDS)[number]

// The write-only subset: accepted on input, never returned by any endpoint.
export const WHATSAPP_SECRET_FIELDS = [
  'accessToken',
  'appSecret',
  'webhookVerifyToken',
] as const satisfies readonly WhatsappCredentialField[]
export type WhatsappSecretField = (typeof WHATSAPP_SECRET_FIELDS)[number]

// Everything on a stored WhatsApp channel config that is encrypted at rest and
// never returned: the secrets above plus `registrationPin`, the two-step
// verification PIN Embedded Signup sets when it registers a number. The server
// generates and keeps the PIN and no input accepts it, which is why it is not
// a credential field an administrator can type.
export const WHATSAPP_STORED_SECRET_FIELDS = [
  ...WHATSAPP_SECRET_FIELDS,
  'registrationPin',
] as const

// A blank or whitespace-only value means "keep what is stored", so a form that
// submits every field cannot wipe a secret it never displayed.
function keepWhenBlank<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, schema.optional())
}

export const UpdateWhatsappCredentialsInput = z
  .object({
    phoneNumberId: keepWhenBlank(z.string().min(1)),
    businessAccountId: keepWhenBlank(z.string().min(1)),
    accessToken: keepWhenBlank(z.string().min(10)),
    appSecret: keepWhenBlank(z.string().min(10)),
    webhookVerifyToken: keepWhenBlank(z.string().min(1)),
  })
  .strict()
export type UpdateWhatsappCredentialsInput = z.infer<
  typeof UpdateWhatsappCredentialsInput
>

// Whether each secret is stored, so the screen can say "configured" without
// the value ever leaving the server.
export const WhatsappSecretsStatus = z.object({
  accessToken: z.boolean(),
  appSecret: z.boolean(),
  webhookVerifyToken: z.boolean(),
})
export type WhatsappSecretsStatus = z.infer<typeof WhatsappSecretsStatus>

// A Telegram bot made in @BotFather. Only the token is typed in; the server
// asks Telegram for the bot's username and generates the secret Telegram
// echoes on every webhook call.
export const TelegramConfig = z.object({
  botToken: z
    .string()
    .trim()
    .regex(/^[0-9]{5,}:[A-Za-z0-9_-]{30,}$/, 'not a BotFather token'),
})
export type TelegramConfig = z.infer<typeof TelegramConfig>

// Encrypted at rest and never returned by any endpoint.
export const TELEGRAM_SECRET_FIELDS = ['botToken', 'webhookSecret'] as const

// A Facebook Page (Messenger) or the Instagram professional account linked to
// it, both reached through our Meta app with the Page's access token. The
// server reads the page name and the linked Instagram account from Meta.
export const MetaPageConfig = z.object({
  pageId: z.string().trim().regex(/^[0-9]{5,}$/, 'numeric Facebook Page id'),
  pageAccessToken: z.string().trim().min(20),
})
export type MetaPageConfig = z.infer<typeof MetaPageConfig>

// Encrypted at rest and never returned by any endpoint.
export const META_PAGE_SECRET_FIELDS = ['pageAccessToken'] as const

export const CreateMetaInboxesInput = z.object({
  pageId: MetaPageConfig.shape.pageId,
  pageAccessToken: MetaPageConfig.shape.pageAccessToken,
  // Which channels to open for this Page: Messenger, Instagram Direct, or both.
  messenger: z.boolean().default(true),
  instagram: z.boolean().default(false),
  messengerName: z.string().min(1).max(80).optional(),
  instagramName: z.string().min(1).max(80).optional(),
})
export type CreateMetaInboxesInput = z.infer<typeof CreateMetaInboxesInput>

export const ApiChannelConfig = z.object({
  // webhookUrl optional — customer's backend can pull via API instead.
  webhookUrl: z.string().url().optional(),
})
export type ApiChannelConfig = z.infer<typeof ApiChannelConfig>

// How long a conversation may sit without a message before it is closed
// automatically. The published Terms (4.2) promise a window between 1 hour and
// 7 days, and the billing meter depends on it: a contact who writes after the
// conversation closed opens a new, billable one. Nothing may stay open longer.
export const AUTO_RESOLVE_MIN_MINUTES = 60
export const AUTO_RESOLVE_MAX_MINUTES = 60 * 24 * 7
export const AutoResolveMinutes = z
  .number()
  .int()
  .min(AUTO_RESOLVE_MIN_MINUTES)
  .max(AUTO_RESOLVE_MAX_MINUTES)

// Per-channel discriminated create input. Channel type drives the config shape.

export const CreateInboxInput = z.discriminatedUnion('channelType', [
  z.object({
    name: z.string().min(1),
    channelType: z.literal('WEB_WIDGET'),
    channelConfig: WebWidgetConfig,
    greetingEnabled: z.boolean().optional(),
    greetingMessage: z.string().optional(),
    outOfOfficeMessage: z.string().optional(),
    aiAutoreplyMode: AiAutoreplyMode.optional(),
    autoResolveMinutes: AutoResolveMinutes.optional(),
    csatEnabled: z.boolean().optional(),
    // Optional on create — attach an AI agent at creation time instead of
    // forcing the operator to do a follow-up PATCH. Pass null/omit to leave
    // the inbox without a bot.
    agentBotId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    name: z.string().min(1),
    channelType: z.literal('EMAIL'),
    channelConfig: EmailConfig,
    greetingEnabled: z.boolean().optional(),
    greetingMessage: z.string().optional(),
    outOfOfficeMessage: z.string().optional(),
    aiAutoreplyMode: AiAutoreplyMode.optional(),
    autoResolveMinutes: AutoResolveMinutes.optional(),
    csatEnabled: z.boolean().optional(),
    // Optional on create — attach an AI agent at creation time instead of
    // forcing the operator to do a follow-up PATCH. Pass null/omit to leave
    // the inbox without a bot.
    agentBotId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    name: z.string().min(1),
    channelType: z.literal('WHATSAPP'),
    channelConfig: WhatsappConfig,
    greetingEnabled: z.boolean().optional(),
    greetingMessage: z.string().optional(),
    outOfOfficeMessage: z.string().optional(),
    aiAutoreplyMode: AiAutoreplyMode.optional(),
    autoResolveMinutes: AutoResolveMinutes.optional(),
    csatEnabled: z.boolean().optional(),
    // Optional on create — attach an AI agent at creation time instead of
    // forcing the operator to do a follow-up PATCH. Pass null/omit to leave
    // the inbox without a bot.
    agentBotId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    name: z.string().min(1),
    channelType: z.literal('TELEGRAM'),
    channelConfig: TelegramConfig,
    greetingEnabled: z.boolean().optional(),
    greetingMessage: z.string().optional(),
    outOfOfficeMessage: z.string().optional(),
    aiAutoreplyMode: AiAutoreplyMode.optional(),
    autoResolveMinutes: AutoResolveMinutes.optional(),
    csatEnabled: z.boolean().optional(),
    agentBotId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    name: z.string().min(1),
    channelType: z.literal('API'),
    channelConfig: ApiChannelConfig,
    greetingEnabled: z.boolean().optional(),
    greetingMessage: z.string().optional(),
    outOfOfficeMessage: z.string().optional(),
    aiAutoreplyMode: AiAutoreplyMode.optional(),
    autoResolveMinutes: AutoResolveMinutes.optional(),
    csatEnabled: z.boolean().optional(),
    // Optional on create — attach an AI agent at creation time instead of
    // forcing the operator to do a follow-up PATCH. Pass null/omit to leave
    // the inbox without a bot.
    agentBotId: z.string().min(1).nullable().optional(),
  }),
])
export type CreateInboxInput = z.infer<typeof CreateInboxInput>

// Update input — partial, channel type immutable, config replacement opt-in.

export const UpdateInboxInput = z.object({
  name: z.string().min(1).optional(),
  channelConfig: z.record(z.unknown()).optional(),
  greetingEnabled: z.boolean().optional(),
  greetingMessage: z.string().nullable().optional(),
  outOfOfficeMessage: z.string().nullable().optional(),
  // Sent when an agent resolves a conversation; '' or null turns it off.
  closingMessage: z.string().max(1000).nullable().optional(),
  aiAutoreplyMode: AiAutoreplyMode.optional(),
  autoResolveMinutes: AutoResolveMinutes.optional(),
  agentBotId: z.string().nullable().optional(),
  csatEnabled: z.boolean().optional(),
  slaPolicyId: z.string().nullable().optional(),
  // Deterministic flow + hybrid AI config.
  defaultFlowId: z.string().nullable().optional(),
  flowMode: FlowMode.optional(),
  deviationPolicy: DeviationPolicy.optional(),
  maxDeviations: z.number().int().min(0).max(20).optional(),
})
export type UpdateInboxInput = z.infer<typeof UpdateInboxInput>

export const AddInboxMemberInput = z.object({
  userId: z.string().min(1),
})
export type AddInboxMemberInput = z.infer<typeof AddInboxMemberInput>

// Response DTOs.

export const InboxMemberDTO = z.object({
  id: z.string(),
  userId: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    fullName: z.string().nullable(),
  }),
  createdAt: z.string(),
})
export type InboxMemberDTO = z.infer<typeof InboxMemberDTO>

export const InboxDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  channelType: ChannelType,
  channelConfig: z.record(z.unknown()),
  greetingEnabled: z.boolean(),
  greetingMessage: z.string().nullable(),
  outOfOfficeMessage: z.string().nullable(),
  closingMessage: z.string().nullable(),
  aiAutoreplyMode: AiAutoreplyMode,
  autoResolveMinutes: z.number().int(),
  agentBotId: z.string().nullable(),
  csatEnabled: z.boolean(),
  slaPolicyId: z.string().nullable(),
  defaultFlowId: z.string().nullable(),
  flowMode: FlowMode,
  deviationPolicy: DeviationPolicy,
  maxDeviations: z.number().int(),
  // WhatsApp only (null otherwise): which secrets are stored, never their values.
  whatsappSecrets: WhatsappSecretsStatus.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type InboxDTO = z.infer<typeof InboxDTO>

export const InboxWithMembersDTO = InboxDTO.extend({
  members: z.array(InboxMemberDTO),
})
export type InboxWithMembersDTO = z.infer<typeof InboxWithMembersDTO>
