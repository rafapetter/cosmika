import { z } from 'zod'

export const ConversationStatus = z.enum(['OPEN', 'RESOLVED', 'PENDING'])
export type ConversationStatus = z.infer<typeof ConversationStatus>

// Ordering options for the conversation list (Nebula's sort dropdown).
export const ConversationSort = z.enum([
  'ACTIVITY_DESC', // latest activity first (default)
  'ACTIVITY_ASC', // oldest activity first
  'CREATED_DESC', // newest conversations first
  'CREATED_ASC', // oldest conversations first
  'PRIORITY_DESC', // highest priority first
])
export type ConversationSort = z.infer<typeof ConversationSort>

// Who is currently driving the conversation. Orthogonal to status.
export const ControlMode = z.enum(['BOT', 'HUMAN'])
export type ControlMode = z.infer<typeof ControlMode>

export const Priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export type Priority = z.infer<typeof Priority>

export const Sentiment = z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])
export type Sentiment = z.infer<typeof Sentiment>

export const SenderType = z.enum(['CONTACT', 'USER', 'AGENT_BOT', 'SYSTEM'])
export type SenderType = z.infer<typeof SenderType>

export const ContentType = z.enum([
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'FILE',
  'LOCATION',
  'CONTACT_CARD',
  'CARDS',
  'QUICK_REPLIES',
])
export type ContentType = z.infer<typeof ContentType>

export const MessageStatus = z.enum([
  'PENDING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
])
export type MessageStatus = z.infer<typeof MessageStatus>

// Inputs

// `content` may be empty when the message carries attachments — a photo sent
// with no caption is a real message and has to reach the channel.
export const SendMessageInput = z
  .object({
    content: z.string().max(10000).default(''),
    contentType: ContentType.default('TEXT'),
    contentAttributes: z.record(z.unknown()).optional(),
    attachmentIds: z.array(z.string()).max(10).default([]),
    isPrivate: z.boolean().default(false),
    inReplyToId: z.string().optional(),
  })
  .refine((v) => v.content.trim().length > 0 || v.attachmentIds.length > 0, {
    message: 'A message needs content or at least one attachment',
    path: ['content'],
  })
export type SendMessageInput = z.infer<typeof SendMessageInput>

// `emoji: ''` takes our reaction off. Capped so it can only ever be an emoji
// (with skin tone / ZWJ sequences), never a message in disguise.
export const ReactToMessageInput = z.object({
  emoji: z.string().max(16),
})
export type ReactToMessageInput = z.infer<typeof ReactToMessageInput>

export const InboundMessageInput = z.object({
  content: z.string().min(1).max(10000),
  contentType: ContentType.default('TEXT'),
  contentAttributes: z.record(z.unknown()).optional(),
  externalSourceId: z.string().optional(),
  inReplyToId: z.string().optional(),
})
export type InboundMessageInput = z.infer<typeof InboundMessageInput>

export const CreateConversationInput = z.object({
  contactId: z.string().min(1),
  inboxId: z.string().min(1),
  sourceId: z.string().min(1).max(200).optional(),
  initialMessage: z
    .object({
      senderType: z.enum(['CONTACT', 'USER']).default('USER'),
      content: z.string().min(1).max(10000),
      contentType: ContentType.default('TEXT'),
      isPrivate: z.boolean().default(false),
    })
    .optional(),
})
export type CreateConversationInput = z.infer<typeof CreateConversationInput>

export const UpdateConversationInput = z.object({
  status: ConversationStatus.optional(),
  controlMode: ControlMode.optional(),
  priority: Priority.optional(),
  assigneeId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  aiSummary: z.string().max(4000).nullable().optional(),
  aiSentiment: Sentiment.nullable().optional(),
  aiTags: z.array(z.string().min(1).max(64)).max(20).optional(),
  customAttributes: z.record(z.unknown()).optional(),
  // Handover context for whoever receives the conversation: written into the
  // thread as a private note, right after the assignment note.
  transferNote: z.string().trim().max(2000).optional(),
})
export type UpdateConversationInput = z.infer<typeof UpdateConversationInput>

// Plain-text transcript of a conversation, for client-side download.
export const ConversationTranscriptDTO = z.object({
  displayId: z.number().int(),
  filename: z.string(),
  text: z.string(),
})
export type ConversationTranscriptDTO = z.infer<typeof ConversationTranscriptDTO>

export const ListConversationsQuery = z.object({
  status: ConversationStatus.optional(),
  controlMode: ControlMode.optional(),
  inboxId: z.string().optional(),
  assigneeId: z.string().optional(),
  teamId: z.string().optional(),
  labelId: z.string().optional(),
  contactId: z.string().optional(),
  excludeId: z.string().optional(),
  // Conversation display number (the per-account #42 shown in the UI).
  displayId: z.coerce.number().int().positive().optional(),
  // Contact country (ISO code, e.g. "BR") from the contact's attributes.
  country: z.string().optional(),
  // Created-at window.
  createdAfter: z.coerce.date().optional(),
  createdBefore: z.coerce.date().optional(),
  // Last-activity window (conversation.updatedAt).
  lastActivityAfter: z.coerce.date().optional(),
  lastActivityBefore: z.coerce.date().optional(),
  sort: ConversationSort.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type ListConversationsQuery = z.infer<typeof ListConversationsQuery>

// Bulk update payload — applied to every conversation in `ids`. One action
// per request keeps the API + UI simple; the bulk bar fires one of these
// per click.
export const BulkConversationActionInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('STATUS'), status: ConversationStatus }),
  z.object({ type: z.literal('PRIORITY'), priority: Priority }),
  z.object({ type: z.literal('ASSIGN'), assigneeId: z.string().nullable() }),
  z.object({ type: z.literal('APPLY_LABEL'), labelId: z.string().min(1) }),
  z.object({ type: z.literal('REMOVE_LABEL'), labelId: z.string().min(1) }),
])
export type BulkConversationActionInput = z.infer<
  typeof BulkConversationActionInput
>

export const BulkConversationsInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: BulkConversationActionInput,
})
export type BulkConversationsInput = z.infer<typeof BulkConversationsInput>

export const BulkConversationsResult = z.object({
  updated: z.number().int(),
})
export type BulkConversationsResult = z.infer<typeof BulkConversationsResult>

export const AddParticipantInput = z.object({
  userId: z.string().min(1),
})
export type AddParticipantInput = z.infer<typeof AddParticipantInput>

// Response DTOs

export const ConversationContactRefDTO = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  identifier: z.string().nullable().optional(),
  blockedAt: z.string().nullable().optional(),
  customAttributes: z.record(z.unknown()).optional(),
})
export type ConversationContactRefDTO = z.infer<typeof ConversationContactRefDTO>

export const ConversationInboxRefDTO = z.object({
  id: z.string(),
  name: z.string(),
  channelType: z.string(),
})
export type ConversationInboxRefDTO = z.infer<typeof ConversationInboxRefDTO>

export const ConversationLastMessageRefDTO = z.object({
  content: z.string().nullable(),
  senderType: z.enum(['CONTACT', 'USER', 'AGENT_BOT', 'SYSTEM']),
  isPrivate: z.boolean(),
  createdAt: z.string(),
})
export type ConversationLastMessageRefDTO = z.infer<typeof ConversationLastMessageRefDTO>

export const ConversationLabelOnConvRefDTO = z.object({
  id: z.string(),
  title: z.string(),
  color: z.string(),
})
export type ConversationLabelOnConvRefDTO = z.infer<typeof ConversationLabelOnConvRefDTO>

export const ConversationSummaryDTO = z.object({
  id: z.string(),
  displayId: z.number().int(),
  // The service protocol shared across channels for the same case.
  protocol: z.string().nullable().optional(),
  accountId: z.string(),
  inboxId: z.string(),
  contactId: z.string(),
  contactInboxId: z.string(),
  assigneeId: z.string().nullable(),
  teamId: z.string().nullable(),
  status: ConversationStatus,
  controlMode: ControlMode,
  priority: Priority,
  agentLastSeenAt: z.string().nullable(),
  contactLastSeenAt: z.string().nullable(),
  firstReplyAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  aiSummary: z.string().nullable(),
  aiSentiment: Sentiment.nullable(),
  aiTags: z.array(z.string()),
  customAttributes: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Sparse refs hydrated for the inbox list pane. */
  contact: ConversationContactRefDTO.nullish(),
  inbox: ConversationInboxRefDTO.nullish(),
  lastMessage: ConversationLastMessageRefDTO.nullish(),
  /** Most recent of: createdAt | last message | last status change. */
  lastActivityAt: z.string().nullish(),
  labels: z.array(ConversationLabelOnConvRefDTO).default([]),
  /** Computed SLA status. Always present; NOT_APPLICABLE when no policy. */
  slaStatus: z
    .object({
      state: z.enum(['NOT_APPLICABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED']),
      dimension: z.enum(['firstResponse', 'resolution']).nullable(),
      targetAt: z.string().nullable(),
      minutesRemaining: z.number().nullable(),
      secondsRemaining: z.number().nullable().optional(),
    })
    .nullish(),
})
export type ConversationSummaryDTO = z.infer<typeof ConversationSummaryDTO>

export const ConversationParticipantDTO = z.object({
  id: z.string(),
  userId: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    fullName: z.string().nullable(),
  }),
  createdAt: z.string(),
})
export type ConversationParticipantDTO = z.infer<typeof ConversationParticipantDTO>

export const ConversationDetailDTO = ConversationSummaryDTO.extend({
  contact: ConversationContactRefDTO,
  inbox: ConversationInboxRefDTO,
  assignee: z
    .object({
      id: z.string(),
      email: z.string(),
      fullName: z.string().nullable(),
    })
    .nullable(),
  participants: z.array(ConversationParticipantDTO),
  messageCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  /** Set if this conversation was created via the forward action. */
  forwardedFrom: z
    .object({ id: z.string(), displayId: z.number().int() })
    .nullable(),
  /**
   * WhatsApp's 24h customer-service window. While it's shut only an approved
   * template may be sent, so the composer warns instead of letting an agent
   * type a reply that Meta will reject. Null on non-WhatsApp inboxes.
   */
  messagingWindow: z
    .object({
      open: z.boolean(),
      lastInboundAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
})
export type ConversationDetailDTO = z.infer<typeof ConversationDetailDTO>

export const ConversationsPage = z.object({
  data: z.array(ConversationSummaryDTO),
  nextCursor: z.string().nullable(),
})
export type ConversationsPage = z.infer<typeof ConversationsPage>

export const MessageAttachmentDTO = z.object({
  id: z.string(),
  fileType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FILE', 'LOCATION', 'FALLBACK']),
  fileUrl: z.string(),
  fileName: z.string().nullable(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
})
export type MessageAttachmentDTO = z.infer<typeof MessageAttachmentDTO>

export const MessageDTO = z.object({
  id: z.string(),
  conversationId: z.string(),
  inboxId: z.string(),
  accountId: z.string(),
  senderType: SenderType,
  senderUserId: z.string().nullable(),
  senderAgentBotId: z.string().nullable(),
  senderContactId: z.string().nullable(),
  content: z.string().nullable(),
  contentType: ContentType,
  contentAttributes: z.record(z.unknown()),
  status: MessageStatus,
  isPrivate: z.boolean(),
  externalSourceId: z.string().nullable(),
  inReplyToId: z.string().nullable(),
  attachments: z.array(MessageAttachmentDTO).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MessageDTO = z.infer<typeof MessageDTO>

export const MessagesPage = z.object({
  data: z.array(MessageDTO),
  nextCursor: z.string().nullable(),
})
export type MessagesPage = z.infer<typeof MessagesPage>

// ─── Interactive messages (quick-reply buttons / list) ────────────────
// Carried in Message.contentAttributes when contentType = QUICK_REPLIES.
// Limits mirror the WhatsApp Cloud API: ≤3 reply buttons (title ≤20 chars);
// list messages ≤10 rows total (title ≤24, description ≤72), button ≤20.

export const InteractiveButton = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(20),
})
export type InteractiveButton = z.infer<typeof InteractiveButton>

export const InteractiveListRow = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(24),
  description: z.string().max(72).optional(),
})
export type InteractiveListRow = z.infer<typeof InteractiveListRow>

export const InteractiveListSection = z.object({
  title: z.string().max(24).optional(),
  rows: z.array(InteractiveListRow).min(1).max(10),
})
export type InteractiveListSection = z.infer<typeof InteractiveListSection>

export const InteractiveContent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('buttons'),
    body: z.string().min(1).max(1024),
    buttons: z.array(InteractiveButton).min(1).max(3),
  }),
  z.object({
    kind: z.literal('list'),
    body: z.string().min(1).max(1024),
    buttonText: z.string().min(1).max(20),
    sections: z.array(InteractiveListSection).min(1),
  }),
])
export type InteractiveContent = z.infer<typeof InteractiveContent>

// Everything said under one protocol, across channels: the conversations and
// their public messages in one timeline (pilot, item 02).
export const ProtocolHistoryDTO = z.object({
  protocol: z.string().nullable(),
  conversations: z.array(
    z.object({
      id: z.string(),
      displayId: z.number().int(),
      status: z.string(),
      inboxName: z.string(),
      channelType: z.string(),
      createdAt: z.string(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      conversationId: z.string(),
      channelType: z.string(),
      inboxName: z.string(),
      senderType: z.string(),
      content: z.string().nullable(),
      contentType: z.string(),
      createdAt: z.string(),
    }),
  ),
})
export type ProtocolHistoryDTO = z.infer<typeof ProtocolHistoryDTO>
