import type {
  AccountProfileDTO,
  CompleteEmbeddedSignupInput,
  EmbeddedSignupConfigDTO,
  UpsertAccountProfileInput,
  OnboardingStatusDTO,
  SupportTicketDTO,
  SupportTicketDetailDTO,
  TicketFilter,
  AccountDTO,
  AccountMemberDTO,
  AccountWithMembers,
  AddInboxMemberInput,
  ChangePasswordInput,
  UpdateAccountInput,
  UpdateMeInput,
  UserDTO,
  AddParticipantInput,
  AgentBotDTO,
  AgentToolCallDTO,
  AiAgentSessionDTO,
  AuthEnvelope,
  BillingStatusDTO,
  BulkConversationsInput,
  BulkConversationsResult,
  CannedResponseDTO,
  ConfirmToolCallsInput,
  CreateSavedViewInput,
  ListNotificationsQuery,
  NotificationCounts,
  NotificationDTO,
  NotificationPreferenceDTO,
  UpdateNotificationPreferenceInput,
  SavedViewDTO,
  UpdateSavedViewInput,
  BulkContactAction,
  BulkContactActionResult,
  ContactDTO,
  ContactNoteDTO,
  ContactWithInboxesDTO,
  ContactsPage,
  ConversationDetailDTO,
  ConversationParticipantDTO,
  ConversationSummaryDTO,
  ConversationTranscriptDTO,
  ConversationsPage,
  CreateAgentBotInput,
  CreateCannedResponseInput,
  CreateContactInput,
  CreateConversationInput,
  CreateInboxInput,
  CreateMetaInboxesInput,
  SlaMissDTO,
  ProtocolHistoryDTO,
  CreateLabelInput,
  CreateFlowInput,
  UpdateFlowInput,
  FlowDTO,
  FlowPublishResultDTO,
  FlowPreviewInput,
  FlowPreviewResultDTO,
  FlowSummaryDTO,
  InboundMessageInput,
  InboxDTO,
  InboxMemberDTO,
  InboxWithMembersDTO,
  LabelDTO,
  ListContactsQuery,
  ListConversationsQuery,
  MeResponse,
  MergeContactsInput,
  AttachmentDTO,
  MessageDTO,
  MessagesPage,
  SendMessageInput,
  SendTemplateMessageInput,
  WhatsappTemplateDTO,
  BroadcastDTO,
  CreateBroadcastInput,
  PreviewAudienceInput,
  BroadcastAudiencePreview,
  UpdateAgentBotInput,
  UpdateCannedResponseInput,
  UpdateContactInput,
  UpdateConversationInput,
  UpdateInboxInput,
  UpdateWhatsappCredentialsInput,
  UpdateLabelInput,
  AddTeamMemberInput,
  AutomationDryRunResult,
  AutomationRuleDTO,
  CreateAutomationRuleInput,
  CreateHolidayInput,
  BreakdownQuery,
  BreakdownResponse,
  CreateTeamInput,
  HolidayDTO,
  LeaderboardQuery,
  LeaderboardResponse,
  OverviewQuery,
  OverviewResponse,
  SetWorkingHoursInput,
  TeamDTO,
  TeamMemberDTO,
  TeamWithMembersDTO,
  TimeseriesQuery,
  TimeseriesResponse,
  UpdateAutomationRuleInput,
  UpdateTeamInput,
  WorkingHourDTO,
  AgentAvailabilityDTO,
  AuditLogPage,
  ContactImportInput,
  ContactImportResult,
  CreateCustomAttributeInput,
  CreateWebhookInput,
  ApiKeyDTO,
  ApiKeyWithSecret,
  ArticleDTO,
  ArticleHitDTO,
  ChangeMemberRoleInput,
  CreateApiKeyInput,
  CreateArticleInput,
  CreateSlaPolicyInput,
  CsatStats,
  CsatStatsQuery,
  ListArticlesQuery,
  SlaPolicyDTO,
  TotpSetupResponse,
  TotpVerifyResponse,
  UpdateArticleInput,
  UpdateSlaPolicyInput,
  CustomAttributeDTO,
  ForwardConversationInput,
  ForwardConversationResult,
  ListAuditLogsQuery,
  DataExportFormat,
  DataExportKind,
  NpsQuery,
  NpsStats,
  SurveySettingsDTO,
  ReplaceAgentAvailabilityInput,
  UpdateCustomAttributeInput,
  UpdateWebhookInput,
  WebhookDTO,
  WebhookDeliveryDTO,
  WebhookWithSecret,
  AdminAgentSessionDTO,
  AdminAgentSessionDetailDTO,
  AdminAgentTurnDTO,
  AdminAgentDecisionDTO,
  SavedViewEntity,
} from '@cosmika/shared'

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3110'

export class ApiError extends Error {
  status: number
  payload: unknown
  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...rest } = init
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      // Only declare a JSON body when one is actually sent. Fastify rejects a
      // request that carries `content-type: application/json` with an empty
      // body ("Body cannot be empty…"), which broke bodyless mutations like
      // flow publish/delete.
      ...(rest.body != null ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  })
  let payload: unknown = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!res.ok) {
    if (res.status === 401 && token) expireSession()
    if (res.status === 402 && token && isPaymentRequired(payload)) showSubscriptionEnded()
    const msg =
      (payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : null) ?? `Request failed (${res.status})`
    throw new ApiError(res.status, msg, payload)
  }
  return payload as T
}

function npsParams(query?: NpsQuery): string {
  const params = new URLSearchParams()
  for (const k of ['inboxId', 'teamId', 'agentId', 'from', 'to'] as const) {
    if (query?.[k]) params.set(k, query[k]!)
  }
  return params.toString() ? `?${params}` : ''
}

/**
 * A rejected token means the session is gone (expired, revoked, signed out
 * elsewhere), and no amount of retrying fixes it. Without this the app kept
 * the dead session in storage and every pane rendered the generic "something
 * went wrong", leaving the user stuck on a screen with no way forward.
 * Sessions last 30 days, so this is a monthly event for every user, not an
 * edge case.
 *
 * Only fires when we actually sent a token: a 401 from sign-in is a wrong
 * password, and must stay on the form with its own message.
 */
function expireSession(): void {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  if (pathname.startsWith('/sign-in') || pathname.startsWith('/sign-up')) return
  try {
    window.localStorage.removeItem('cosmika.session')
  } catch {
    /* private mode — the redirect below still gets the user unstuck */
  }
  // Keep where they were so sign-in can send them back.
  const next = encodeURIComponent(`${pathname}${search}`)
  window.location.replace(`/sign-in?next=${next}`)
}

function isPaymentRequired(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as { error?: unknown }).error === 'payment_required'
  )
}

/**
 * The account's trial ran out (or its subscription lapsed): every account
 * route now answers 402, and without this each pane showed a bare error with
 * no way forward. Send the user to the screen that offers the payment link.
 */
function showSubscriptionEnded(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname.startsWith('/subscription')) return
  window.location.replace('/subscription')
}

/** Serialize a Date (or already-ISO string) to an ISO-8601 query value. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** What `GET /accounts/:id/usage` answers. */
export type UsageMeterDTO = {
  key: 'newConversations' | 'totalConversations' | 'contacts'
  used: number
  cap: number | null
  absoluteLimit: number | null
  percent: number | null
  /** Usage above the cap that would actually be billed. */
  billableOver: number
}

export type UsageDTO = {
  plan: string
  caps: {
    newConversationsPerMonth: number | null
    totalConversations: number | null
    contacts: number | null
    overageFraction: number | null
  }
  newConversationsThisMonth: number
  totalConversations: number
  contacts: number
  meters: UsageMeterDTO[]
  state: 'ok' | 'warn' | 'overage' | 'upgrade'
  warning: Array<'newConversations' | 'totalConversations' | 'contacts'>
  estimatedPlanOverageBrl: number
  ai: {
    conversations: number
    /** null = this plan does not count AI conversations. */
    included: number | null
    overagePriceBrl: number | null
    capBrl: number | null
    overConversations: number
    estimatedOverageBrl: number
    resetsAt: string
  }
  canManageBilling: boolean
  /** False until customer-side retention exists (decision 1). */
  totalConversationsBilled: boolean
}

export const api = {
  signUp(body: {
    email: string
    password: string
    fullName: string
    accountName: string
    inviteCode?: string
  }) {
    return request<AuthEnvelope>('/auth/sign-up', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  forgotPassword(email: string) {
    return request<void>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
  },
  resetPassword(body: { token: string; password: string }) {
    return request<void>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  signIn(body: { email: string; password: string }) {
    return request<AuthEnvelope | { kind: 'totp'; challengeToken: string }>(
      '/auth/sign-in',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    )
  },
  signOut(token: string) {
    return request<void>('/auth/sign-out', { method: 'POST', token })
  },
  getBillingStatus(token: string) {
    return request<BillingStatusDTO>('/billing/status', { method: 'GET', token })
  },
  me(token: string) {
    return request<MeResponse>('/auth/me', { method: 'GET', token })
  },
  updateMe(token: string, body: UpdateMeInput) {
    return request<UserDTO>('/auth/me', {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  changePassword(token: string, body: ChangePasswordInput) {
    return request<void>('/auth/me/password', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateAccount(token: string, accountId: string, body: UpdateAccountInput) {
    return request<AccountDTO>(`/accounts/${accountId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  getAccount(token: string, accountId: string) {
    return request<AccountWithMembers>(`/accounts/${accountId}`, {
      method: 'GET',
      token,
    })
  },
  listAccountMembers(token: string, accountId: string) {
    return request<AccountMemberDTO[]>(`/accounts/${accountId}/members`, {
      method: 'GET',
      token,
    })
  },
  listInboxes(token: string, accountId: string) {
    return request<InboxDTO[]>(`/accounts/${accountId}/inboxes`, {
      method: 'GET',
      token,
    })
  },
  listFlows(token: string, accountId: string) {
    return request<FlowSummaryDTO[]>(`/accounts/${accountId}/flows`, {
      method: 'GET',
      token,
    })
  },
  getFlow(token: string, accountId: string, flowId: string) {
    return request<FlowDTO>(`/accounts/${accountId}/flows/${flowId}`, {
      method: 'GET',
      token,
    })
  },
  createFlow(token: string, accountId: string, body: CreateFlowInput) {
    return request<FlowDTO>(`/accounts/${accountId}/flows`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateFlow(
    token: string,
    accountId: string,
    flowId: string,
    body: UpdateFlowInput,
  ) {
    return request<FlowDTO>(`/accounts/${accountId}/flows/${flowId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  publishFlow(token: string, accountId: string, flowId: string) {
    return request<FlowPublishResultDTO>(`/accounts/${accountId}/flows/${flowId}/publish`, {
      method: 'POST',
      token,
    })
  },
  previewFlow(
    token: string,
    accountId: string,
    flowId: string,
    body: FlowPreviewInput,
  ) {
    return request<FlowPreviewResultDTO>(
      `/accounts/${accountId}/flows/${flowId}/preview`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  deleteFlow(token: string, accountId: string, flowId: string) {
    return request<void>(`/accounts/${accountId}/flows/${flowId}`, {
      method: 'DELETE',
      token,
    })
  },
  createInbox(token: string, accountId: string, body: CreateInboxInput) {
    // Telegram has its own route: the server checks the token with Telegram
    // and registers the bot's webhook around the insert.
    const path =
      body.channelType === 'TELEGRAM'
        ? `/accounts/${accountId}/inboxes/telegram`
        : `/accounts/${accountId}/inboxes`
    return request<InboxDTO>(path, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  /** Connect a Facebook Page: opens its Messenger and/or Instagram Direct inboxes. */
  connectMetaPage(token: string, accountId: string, body: CreateMetaInboxesInput) {
    return request<InboxDTO[]>(`/accounts/${accountId}/inboxes/meta`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  getInbox(token: string, accountId: string, inboxId: string) {
    return request<InboxWithMembersDTO>(
      `/accounts/${accountId}/inboxes/${inboxId}`,
      { method: 'GET', token },
    )
  },
  updateInbox(
    token: string,
    accountId: string,
    inboxId: string,
    body: UpdateInboxInput,
  ) {
    return request<InboxDTO>(`/accounts/${accountId}/inboxes/${inboxId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  // Admin-only. Blank or absent fields keep their stored value; the response
  // never carries a secret, only whether each one is set.
  updateWhatsappCredentials(
    token: string,
    accountId: string,
    inboxId: string,
    body: UpdateWhatsappCredentialsInput,
  ) {
    return request<InboxDTO>(
      `/accounts/${accountId}/inboxes/${inboxId}/whatsapp-credentials`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  getEmbeddedSignupConfig(token: string, accountId: string) {
    return request<EmbeddedSignupConfigDTO>(
      `/accounts/${accountId}/whatsapp/embedded-signup/config`,
      { method: 'GET', token },
    )
  },
  completeEmbeddedSignup(
    token: string,
    accountId: string,
    body: CompleteEmbeddedSignupInput,
  ) {
    return request<InboxDTO>(`/accounts/${accountId}/whatsapp/embedded-signup`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteInbox(token: string, accountId: string, inboxId: string) {
    return request<void>(`/accounts/${accountId}/inboxes/${inboxId}`, {
      method: 'DELETE',
      token,
    })
  },
  addInboxMember(
    token: string,
    accountId: string,
    inboxId: string,
    body: AddInboxMemberInput,
  ) {
    return request<InboxMemberDTO>(
      `/accounts/${accountId}/inboxes/${inboxId}/members`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  removeInboxMember(
    token: string,
    accountId: string,
    inboxId: string,
    userId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/inboxes/${inboxId}/members/${userId}`,
      { method: 'DELETE', token },
    )
  },
  listContacts(
    token: string,
    accountId: string,
    query: ListContactsQuery = {},
  ) {
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.cursor) params.set('cursor', query.cursor)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.sort) params.set('sort', query.sort)
    if (query.dir) params.set('dir', query.dir)
    if (query.blocked) params.set('blocked', query.blocked)
    if (query.hasEmail) params.set('hasEmail', query.hasEmail)
    if (query.hasPhone) params.set('hasPhone', query.hasPhone)
    if (query.filters?.length) params.set('filters', JSON.stringify(query.filters))
    const suffix = params.toString() ? `?${params}` : ''
    return request<ContactsPage>(
      `/accounts/${accountId}/contacts${suffix}`,
      { method: 'GET', token },
    )
  },
  createContact(token: string, accountId: string, body: CreateContactInput) {
    return request<ContactDTO>(`/accounts/${accountId}/contacts`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  getContact(token: string, accountId: string, contactId: string) {
    return request<ContactWithInboxesDTO>(
      `/accounts/${accountId}/contacts/${contactId}`,
      { method: 'GET', token },
    )
  },
  updateContact(
    token: string,
    accountId: string,
    contactId: string,
    body: UpdateContactInput,
  ) {
    return request<ContactDTO>(
      `/accounts/${accountId}/contacts/${contactId}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteContact(token: string, accountId: string, contactId: string) {
    return request<void>(`/accounts/${accountId}/contacts/${contactId}`, {
      method: 'DELETE',
      token,
    })
  },
  bulkContactAction(
    token: string,
    accountId: string,
    contactIds: string[],
    action: BulkContactAction,
  ) {
    return request<BulkContactActionResult>(
      `/accounts/${accountId}/contacts/bulk`,
      { method: 'POST', token, body: JSON.stringify({ contactIds, action }) },
    )
  },
  mergeContacts(
    token: string,
    accountId: string,
    contactId: string,
    body: MergeContactsInput,
  ) {
    return request<ContactWithInboxesDTO>(
      `/accounts/${accountId}/contacts/${contactId}/merge`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  setContactBlocked(
    token: string,
    accountId: string,
    contactId: string,
    blocked: boolean,
  ) {
    return request<ContactDTO>(
      `/accounts/${accountId}/contacts/${contactId}/block`,
      { method: 'POST', token, body: JSON.stringify({ blocked }) },
    )
  },
  listContactNotes(token: string, accountId: string, contactId: string) {
    return request<ContactNoteDTO[]>(
      `/accounts/${accountId}/contacts/${contactId}/notes`,
      { method: 'GET', token },
    )
  },
  addContactNote(
    token: string,
    accountId: string,
    contactId: string,
    body: string,
  ) {
    return request<ContactNoteDTO>(
      `/accounts/${accountId}/contacts/${contactId}/notes`,
      { method: 'POST', token, body: JSON.stringify({ body }) },
    )
  },
  deleteContactNote(
    token: string,
    accountId: string,
    contactId: string,
    noteId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/contacts/${contactId}/notes/${noteId}`,
      { method: 'DELETE', token },
    )
  },
  listConversations(
    token: string,
    accountId: string,
    query: ListConversationsQuery = {},
  ) {
    const params = new URLSearchParams()
    if (query.status) params.set('status', query.status)
    if (query.controlMode) params.set('controlMode', query.controlMode)
    if (query.inboxId) params.set('inboxId', query.inboxId)
    if (query.assigneeId) params.set('assigneeId', query.assigneeId)
    if (query.teamId) params.set('teamId', query.teamId)
    if (query.labelId) params.set('labelId', query.labelId)
    if (query.contactId) params.set('contactId', query.contactId)
    if (query.excludeId) params.set('excludeId', query.excludeId)
    if (query.displayId !== undefined) params.set('displayId', String(query.displayId))
    if (query.country) params.set('country', query.country)
    if (query.createdAfter) params.set('createdAfter', toIso(query.createdAfter))
    if (query.createdBefore) params.set('createdBefore', toIso(query.createdBefore))
    if (query.lastActivityAfter)
      params.set('lastActivityAfter', toIso(query.lastActivityAfter))
    if (query.lastActivityBefore)
      params.set('lastActivityBefore', toIso(query.lastActivityBefore))
    if (query.sort) params.set('sort', query.sort)
    if (query.q) params.set('q', query.q)
    if (query.cursor) params.set('cursor', query.cursor)
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.toString() ? `?${params}` : ''
    return request<ConversationsPage>(
      `/accounts/${accountId}/conversations${suffix}`,
      { method: 'GET', token },
    )
  },
  createConversation(
    token: string,
    accountId: string,
    body: CreateConversationInput,
  ) {
    return request<ConversationSummaryDTO>(
      `/accounts/${accountId}/conversations`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  getConversation(token: string, accountId: string, conversationId: string) {
    return request<ConversationDetailDTO>(
      `/accounts/${accountId}/conversations/${conversationId}`,
      { method: 'GET', token },
    )
  },
  updateConversation(
    token: string,
    accountId: string,
    conversationId: string,
    body: UpdateConversationInput,
  ) {
    return request<ConversationSummaryDTO>(
      `/accounts/${accountId}/conversations/${conversationId}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteConversation(token: string, accountId: string, conversationId: string) {
    return request<void>(
      `/accounts/${accountId}/conversations/${conversationId}`,
      { method: 'DELETE', token },
    )
  },
  /** Every conversation and public message under this conversation's protocol. */
  getProtocolHistory(token: string, accountId: string, conversationId: string) {
    return request<ProtocolHistoryDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/protocol-history`,
      { method: 'GET', token },
    )
  },
  getConversationTranscript(
    token: string,
    accountId: string,
    conversationId: string,
  ) {
    return request<ConversationTranscriptDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/transcript`,
      { method: 'GET', token },
    )
  },
  listMessages(
    token: string,
    accountId: string,
    conversationId: string,
    cursor?: string,
    limit?: number,
  ) {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    if (limit !== undefined) params.set('limit', String(limit))
    const suffix = params.toString() ? `?${params}` : ''
    return request<MessagesPage>(
      `/accounts/${accountId}/conversations/${conversationId}/messages${suffix}`,
      { method: 'GET', token },
    )
  },
  /**
   * Server-proxied upload. Goes through `fetch` directly rather than
   * `request()` because the body is multipart — the browser has to set the
   * content-type itself so the boundary is right.
   */
  async uploadAttachment(
    token: string,
    accountId: string,
    file: File,
  ): Promise<AttachmentDTO> {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch(`${API_BASE}/accounts/${accountId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    const text = await res.text()
    let payload: unknown = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }
    if (!res.ok) {
      const msg =
        (payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message: unknown }).message)
          : null) ?? `Upload failed (${res.status})`
      throw new ApiError(res.status, msg, payload)
    }
    return payload as AttachmentDTO
  },
  sendMessage(
    token: string,
    accountId: string,
    conversationId: string,
    body: SendMessageInput,
  ) {
    return request<MessageDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/messages`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  sendTemplateMessage(
    token: string,
    accountId: string,
    conversationId: string,
    body: SendTemplateMessageInput,
  ) {
    return request<MessageDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/messages/template`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  listTickets(
    token: string,
    accountId: string,
    opts: {
      status?: string
      q?: string
      sort?: string
      dir?: 'asc' | 'desc'
      filters?: TicketFilter[]
    } = {},
  ) {
    const params = new URLSearchParams()
    if (opts.status) params.set('status', opts.status)
    if (opts.q) params.set('q', opts.q)
    if (opts.sort) params.set('sort', opts.sort)
    if (opts.dir) params.set('dir', opts.dir)
    if (opts.filters?.length) params.set('filters', JSON.stringify(opts.filters))
    const qs = params.toString()
    return request<SupportTicketDTO[]>(
      `/accounts/${accountId}/tickets${qs ? `?${qs}` : ''}`,
      { token },
    )
  },
  getTicket(token: string, accountId: string, ticketId: string) {
    return request<SupportTicketDetailDTO>(
      `/accounts/${accountId}/tickets/${ticketId}`,
      { token },
    )
  },
  updateTicket(
    token: string,
    accountId: string,
    ticketId: string,
    body: { status?: string; priority?: string; category?: string | null },
  ) {
    return request<SupportTicketDTO>(`/accounts/${accountId}/tickets/${ticketId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
    /** Re-attempt delivery of a message that failed to reach the channel. */
  retryMessage(
    token: string,
    accountId: string,
    conversationId: string,
    messageId: string,
  ) {
    return request<MessageDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}/retry`,
      { method: 'POST', token },
    )
  },
  /** React to a message on WhatsApp; `emoji: ''` takes the reaction off. */
  reactToMessage(
    token: string,
    accountId: string,
    conversationId: string,
    messageId: string,
    emoji: string,
  ) {
    return request<MessageDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}/reaction`,
      { method: 'POST', token, body: JSON.stringify({ emoji }) },
    )
  },
    /** Discard an AI suggestion. Only ever removes a pending bot draft. */
  discardAgentDraft(
    token: string,
    accountId: string,
    conversationId: string,
    messageId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}/draft`,
      { method: 'DELETE', token },
    )
  },
    listWhatsappTemplates(token: string, accountId: string, inboxId: string) {
    return request<WhatsappTemplateDTO[]>(
      `/accounts/${accountId}/inboxes/${inboxId}/whatsapp-templates`,
      { method: 'GET', token },
    )
  },
  listBroadcasts(token: string, accountId: string) {
    return request<BroadcastDTO[]>(`/accounts/${accountId}/broadcasts`, {
      method: 'GET',
      token,
    })
  },
  createBroadcast(token: string, accountId: string, body: CreateBroadcastInput) {
    return request<BroadcastDTO>(`/accounts/${accountId}/broadcasts`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  previewBroadcastAudience(
    token: string,
    accountId: string,
    body: PreviewAudienceInput,
  ) {
    return request<BroadcastAudiencePreview>(
      `/accounts/${accountId}/broadcasts/preview-audience`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  sendBroadcast(token: string, accountId: string, broadcastId: string) {
    return request<BroadcastDTO>(
      `/accounts/${accountId}/broadcasts/${broadcastId}/send`,
      { method: 'POST', token },
    )
  },
  syncWhatsappTemplates(token: string, accountId: string, inboxId: string) {
    return request<{ synced: number }>(
      `/accounts/${accountId}/inboxes/${inboxId}/whatsapp-templates/sync`,
      { method: 'POST', token },
    )
  },
  createInboundMessage(
    token: string,
    accountId: string,
    conversationId: string,
    body: InboundMessageInput,
  ) {
    return request<MessageDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/messages/inbound`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  addConversationParticipant(
    token: string,
    accountId: string,
    conversationId: string,
    body: AddParticipantInput,
  ) {
    return request<ConversationParticipantDTO>(
      `/accounts/${accountId}/conversations/${conversationId}/participants`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  removeConversationParticipant(
    token: string,
    accountId: string,
    conversationId: string,
    userId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/conversations/${conversationId}/participants/${userId}`,
      { method: 'DELETE', token },
    )
  },
  listAdminAgentSessions(token: string, accountId: string) {
    return request<AdminAgentSessionDTO[]>(
      `/accounts/${accountId}/admin-agent/sessions`,
      { method: 'GET', token },
    )
  },
  getAdminAgentSession(token: string, accountId: string, sessionId: string) {
    return request<AdminAgentSessionDetailDTO>(
      `/accounts/${accountId}/admin-agent/sessions/${sessionId}`,
      { method: 'GET', token },
    )
  },
  sendAdminAgentMessage(
    token: string,
    accountId: string,
    body: { sessionId?: string; message: string },
  ) {
    return request<AdminAgentTurnDTO>(`/accounts/${accountId}/admin-agent/messages`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  decideAdminAgentCalls(
    token: string,
    accountId: string,
    sessionId: string,
    decisions: Array<{ id: string; approve: boolean }>,
  ) {
    return request<AdminAgentDecisionDTO[]>(
      `/accounts/${accountId}/admin-agent/sessions/${sessionId}/decide`,
      { method: 'POST', token, body: JSON.stringify({ decisions }) },
    )
  },
  listAgentBots(token: string, accountId: string) {
    return request<AgentBotDTO[]>(`/accounts/${accountId}/agent-bots`, {
      method: 'GET',
      token,
    })
  },
  createAgentBot(
    token: string,
    accountId: string,
    body: CreateAgentBotInput,
  ) {
    return request<AgentBotDTO>(`/accounts/${accountId}/agent-bots`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  getAgentBot(token: string, accountId: string, botId: string) {
    return request<AgentBotDTO>(
      `/accounts/${accountId}/agent-bots/${botId}`,
      { method: 'GET', token },
    )
  },
  updateAgentBot(
    token: string,
    accountId: string,
    botId: string,
    body: UpdateAgentBotInput,
  ) {
    return request<AgentBotDTO>(
      `/accounts/${accountId}/agent-bots/${botId}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteAgentBot(token: string, accountId: string, botId: string) {
    return request<void>(`/accounts/${accountId}/agent-bots/${botId}`, {
      method: 'DELETE',
      token,
    })
  },
  getAiSession(token: string, accountId: string, conversationId: string) {
    return request<{
      session: AiAgentSessionDTO | null
      recentToolCalls: AgentToolCallDTO[]
    }>(`/accounts/${accountId}/conversations/${conversationId}/ai`, {
      method: 'GET',
      token,
    })
  },
  confirmToolCalls(
    token: string,
    accountId: string,
    conversationId: string,
    body: ConfirmToolCallsInput,
  ) {
    return request<AgentToolCallDTO[]>(
      `/accounts/${accountId}/conversations/${conversationId}/ai/confirm-tool-calls`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  listTeams(token: string, accountId: string) {
    return request<TeamDTO[]>(`/accounts/${accountId}/teams`, {
      method: 'GET',
      token,
    })
  },
  createTeam(token: string, accountId: string, body: CreateTeamInput) {
    return request<TeamDTO>(`/accounts/${accountId}/teams`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  getTeam(token: string, accountId: string, teamId: string) {
    return request<TeamWithMembersDTO>(
      `/accounts/${accountId}/teams/${teamId}`,
      { method: 'GET', token },
    )
  },
  updateTeam(
    token: string,
    accountId: string,
    teamId: string,
    body: UpdateTeamInput,
  ) {
    return request<TeamDTO>(`/accounts/${accountId}/teams/${teamId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteTeam(token: string, accountId: string, teamId: string) {
    return request<void>(`/accounts/${accountId}/teams/${teamId}`, {
      method: 'DELETE',
      token,
    })
  },
  addTeamMember(
    token: string,
    accountId: string,
    teamId: string,
    body: AddTeamMemberInput,
  ) {
    return request<TeamMemberDTO>(
      `/accounts/${accountId}/teams/${teamId}/members`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  removeTeamMember(
    token: string,
    accountId: string,
    teamId: string,
    userId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/teams/${teamId}/members/${userId}`,
      { method: 'DELETE', token },
    )
  },
  getWorkingHours(token: string, accountId: string, inboxId: string) {
    return request<WorkingHourDTO[]>(
      `/accounts/${accountId}/inboxes/${inboxId}/working-hours`,
      { method: 'GET', token },
    )
  },
  setWorkingHours(
    token: string,
    accountId: string,
    inboxId: string,
    body: SetWorkingHoursInput,
  ) {
    return request<WorkingHourDTO[]>(
      `/accounts/${accountId}/inboxes/${inboxId}/working-hours`,
      { method: 'PUT', token, body: JSON.stringify(body) },
    )
  },
  listHolidays(token: string, accountId: string) {
    return request<HolidayDTO[]>(`/accounts/${accountId}/holidays`, {
      method: 'GET',
      token,
    })
  },
  createHoliday(
    token: string,
    accountId: string,
    body: CreateHolidayInput,
  ) {
    return request<HolidayDTO>(`/accounts/${accountId}/holidays`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteHoliday(token: string, accountId: string, holidayId: string) {
    return request<void>(`/accounts/${accountId}/holidays/${holidayId}`, {
      method: 'DELETE',
      token,
    })
  },
  reportsOverview(
    token: string,
    accountId: string,
    query: OverviewQuery = {},
  ) {
    const params = new URLSearchParams()
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.inboxId) params.set('inboxId', query.inboxId)
    if (query.teamId) params.set('teamId', query.teamId)
    if (query.assigneeId) params.set('assigneeId', query.assigneeId)
    const suffix = params.toString() ? `?${params}` : ''
    return request<OverviewResponse>(
      `/accounts/${accountId}/reports/overview${suffix}`,
      { method: 'GET', token },
    )
  },
  reportsTimeseries(
    token: string,
    accountId: string,
    query: TimeseriesQuery,
  ) {
    const params = new URLSearchParams()
    params.set('metric', query.metric)
    params.set('bucket', query.bucket)
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    if (query.inboxId) params.set('inboxId', query.inboxId)
    if (query.teamId) params.set('teamId', query.teamId)
    if (query.assigneeId) params.set('assigneeId', query.assigneeId)
    return request<TimeseriesResponse>(
      `/accounts/${accountId}/reports/timeseries?${params}`,
      { method: 'GET', token },
    )
  },
  reportsLeaderboard(
    token: string,
    accountId: string,
    query: LeaderboardQuery = {},
  ) {
    const params = new URLSearchParams()
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    const suffix = params.toString() ? `?${params}` : ''
    return request<LeaderboardResponse>(
      `/accounts/${accountId}/reports/agent-leaderboard${suffix}`,
      { method: 'GET', token },
    )
  },
  reportsBreakdown(token: string, accountId: string, query: BreakdownQuery) {
    const params = new URLSearchParams({ dimension: query.dimension })
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    return request<BreakdownResponse>(
      `/accounts/${accountId}/reports/breakdown?${params}`,
      { method: 'GET', token },
    )
  },
  reportsBreakdownCsv(token: string, accountId: string, query: BreakdownQuery) {
    const params = new URLSearchParams({ dimension: query.dimension })
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    return request<string>(
      `/accounts/${accountId}/reports/breakdown.csv?${params}`,
      { method: 'GET', token },
    )
  },
  /** Conversations that crossed their first-response SLA (pilot item 11). */
  slaMisses(token: string, accountId: string, query: SlaMissesFilter = {}) {
    return request<SlaMissDTO[]>(
      `/accounts/${accountId}/sla/misses?${slaMissesParams(query)}`,
      { method: 'GET', token },
    )
  },
  slaMissesCsv(token: string, accountId: string, query: SlaMissesFilter = {}) {
    return request<string>(
      `/accounts/${accountId}/sla/misses.csv?${slaMissesParams(query)}`,
      { method: 'GET', token },
    )
  },
  listAutomationRules(token: string, accountId: string) {
    return request<AutomationRuleDTO[]>(
      `/accounts/${accountId}/automation-rules`,
      { method: 'GET', token },
    )
  },
  createAutomationRule(
    token: string,
    accountId: string,
    body: CreateAutomationRuleInput,
  ) {
    return request<AutomationRuleDTO>(
      `/accounts/${accountId}/automation-rules`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  getAutomationRule(token: string, accountId: string, id: string) {
    return request<AutomationRuleDTO>(
      `/accounts/${accountId}/automation-rules/${id}`,
      { method: 'GET', token },
    )
  },
  updateAutomationRule(
    token: string,
    accountId: string,
    id: string,
    body: UpdateAutomationRuleInput,
  ) {
    return request<AutomationRuleDTO>(
      `/accounts/${accountId}/automation-rules/${id}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteAutomationRule(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/automation-rules/${id}`, {
      method: 'DELETE',
      token,
    })
  },
  dryRunAutomationRule(
    token: string,
    accountId: string,
    id: string,
    conversationId: string,
  ) {
    return request<AutomationDryRunResult>(
      `/accounts/${accountId}/automation-rules/${id}/run-dry?conversationId=${encodeURIComponent(conversationId)}`,
      { method: 'GET', token },
    )
  },
  // Canned responses
  listCannedResponses(token: string, accountId: string) {
    return request<CannedResponseDTO[]>(
      `/accounts/${accountId}/canned-responses`,
      { method: 'GET', token },
    )
  },
  createCannedResponse(
    token: string,
    accountId: string,
    body: CreateCannedResponseInput,
  ) {
    return request<CannedResponseDTO>(
      `/accounts/${accountId}/canned-responses`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  updateCannedResponse(
    token: string,
    accountId: string,
    id: string,
    body: UpdateCannedResponseInput,
  ) {
    return request<CannedResponseDTO>(
      `/accounts/${accountId}/canned-responses/${id}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteCannedResponse(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/canned-responses/${id}`, {
      method: 'DELETE',
      token,
    })
  },
  // Labels
  listLabels(token: string, accountId: string) {
    return request<LabelDTO[]>(`/accounts/${accountId}/labels`, {
      method: 'GET',
      token,
    })
  },
  createLabel(token: string, accountId: string, body: CreateLabelInput) {
    return request<LabelDTO>(`/accounts/${accountId}/labels`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateLabel(
    token: string,
    accountId: string,
    id: string,
    body: UpdateLabelInput,
  ) {
    return request<LabelDTO>(`/accounts/${accountId}/labels/${id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteLabel(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/labels/${id}`, {
      method: 'DELETE',
      token,
    })
  },
  applyLabel(
    token: string,
    accountId: string,
    conversationId: string,
    labelId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/conversations/${conversationId}/labels/${labelId}`,
      { method: 'POST', token },
    )
  },
  removeLabel(
    token: string,
    accountId: string,
    conversationId: string,
    labelId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/conversations/${conversationId}/labels/${labelId}`,
      { method: 'DELETE', token },
    )
  },
  bulkConversations(
    token: string,
    accountId: string,
    body: BulkConversationsInput,
  ) {
    return request<BulkConversationsResult>(
      `/accounts/${accountId}/conversations/bulk`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  listNotifications(
    token: string,
    accountId: string,
    query: ListNotificationsQuery = {},
  ) {
    const params = new URLSearchParams()
    if (query.onlyUnread) params.set('onlyUnread', '1')
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.toString() ? `?${params}` : ''
    return request<NotificationDTO[]>(
      `/accounts/${accountId}/notifications${suffix}`,
      { method: 'GET', token },
    )
  },
  notificationCounts(token: string, accountId: string) {
    return request<NotificationCounts>(
      `/accounts/${accountId}/notifications/count`,
      { method: 'GET', token },
    )
  },
  markNotificationRead(token: string, accountId: string, id: string) {
    return request<void>(
      `/accounts/${accountId}/notifications/${id}/read`,
      { method: 'PATCH', token },
    )
  },
  markAllNotificationsRead(token: string, accountId: string) {
    return request<{ updated: number }>(
      `/accounts/${accountId}/notifications/read-all`,
      { method: 'POST', token },
    )
  },
  getNotificationPreferences(token: string, accountId: string) {
    return request<NotificationPreferenceDTO>(
      `/accounts/${accountId}/notifications/preferences`,
      { method: 'GET', token },
    )
  },
  updateNotificationPreferences(
    token: string,
    accountId: string,
    body: UpdateNotificationPreferenceInput,
  ) {
    return request<NotificationPreferenceDTO>(
      `/accounts/${accountId}/notifications/preferences`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  listSavedViews(token: string, accountId: string, entity?: SavedViewEntity) {
    const suffix = entity ? `?entity=${entity}` : ''
    return request<SavedViewDTO[]>(`/accounts/${accountId}/saved-views${suffix}`, {
      method: 'GET',
      token,
    })
  },
  createSavedView(
    token: string,
    accountId: string,
    body: CreateSavedViewInput,
  ) {
    return request<SavedViewDTO>(`/accounts/${accountId}/saved-views`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateSavedView(
    token: string,
    accountId: string,
    id: string,
    body: UpdateSavedViewInput,
  ) {
    return request<SavedViewDTO>(`/accounts/${accountId}/saved-views/${id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteSavedView(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/saved-views/${id}`, {
      method: 'DELETE',
      token,
    })
  },

  // ─── custom attributes ───
  listCustomAttributes(
    token: string,
    accountId: string,
    target?: 'CONTACT' | 'CONVERSATION',
  ) {
    const qs = target ? `?target=${target}` : ''
    return request<CustomAttributeDTO[]>(
      `/accounts/${accountId}/custom-attributes${qs}`,
      { method: 'GET', token },
    )
  },
  createCustomAttribute(
    token: string,
    accountId: string,
    body: CreateCustomAttributeInput,
  ) {
    return request<CustomAttributeDTO>(
      `/accounts/${accountId}/custom-attributes`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  updateCustomAttribute(
    token: string,
    accountId: string,
    id: string,
    body: UpdateCustomAttributeInput,
  ) {
    return request<CustomAttributeDTO>(
      `/accounts/${accountId}/custom-attributes/${id}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },
  deleteCustomAttribute(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/custom-attributes/${id}`, {
      method: 'DELETE',
      token,
    })
  },

  // ─── agent availability ───
  listAgentAvailability(
    token: string,
    accountId: string,
    memberId: string,
  ) {
    return request<AgentAvailabilityDTO[]>(
      `/accounts/${accountId}/agents/${memberId}/availability`,
      { method: 'GET', token },
    )
  },
  replaceAgentAvailability(
    token: string,
    accountId: string,
    memberId: string,
    body: ReplaceAgentAvailabilityInput,
  ) {
    return request<AgentAvailabilityDTO[]>(
      `/accounts/${accountId}/agents/${memberId}/availability`,
      { method: 'PUT', token, body: JSON.stringify(body) },
    )
  },

  // ─── data export (contacts, conversations with messages) ───
  /** A one-time (2 min) absolute URL the browser can download straight to
   *  disk; an export of a large account is too big to buffer as a Blob. */
  async createDataExportLink(
    token: string,
    accountId: string,
    kind: DataExportKind,
    query: { format: DataExportFormat; from?: string; to?: string },
  ): Promise<string> {
    const params = new URLSearchParams({ format: query.format })
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
    const { url } = await request<{ url: string }>(
      `/accounts/${accountId}/exports/${kind}/ticket?${params}`,
      { method: 'POST', token },
    )
    return `${API_BASE}${url}`
  },

  // ─── audit log ───
  listAuditLogs(
    token: string,
    accountId: string,
    query?: ListAuditLogsQuery,
  ) {
    const params = new URLSearchParams()
    if (query?.cursor) params.set('cursor', query.cursor)
    if (query?.limit) params.set('limit', String(query.limit))
    if (query?.action) params.set('action', query.action)
    if (query?.actorId) params.set('actorId', query.actorId)
    if (query?.from) params.set('from', query.from)
    if (query?.to) params.set('to', query.to)
    const qs = params.toString() ? `?${params}` : ''
    return request<AuditLogPage>(`/accounts/${accountId}/audit-logs${qs}`, {
      method: 'GET',
      token,
    })
  },

  // ─── webhooks ───
  listWebhooks(token: string, accountId: string) {
    return request<WebhookDTO[]>(`/accounts/${accountId}/webhooks`, {
      method: 'GET',
      token,
    })
  },
  createWebhook(token: string, accountId: string, body: CreateWebhookInput) {
    return request<WebhookWithSecret>(`/accounts/${accountId}/webhooks`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateWebhook(
    token: string,
    accountId: string,
    id: string,
    body: UpdateWebhookInput,
  ) {
    return request<WebhookDTO>(`/accounts/${accountId}/webhooks/${id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteWebhook(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/webhooks/${id}`, {
      method: 'DELETE',
      token,
    })
  },
  listWebhookDeliveries(token: string, accountId: string, id: string) {
    return request<WebhookDeliveryDTO[]>(
      `/accounts/${accountId}/webhooks/${id}/deliveries`,
      { method: 'GET', token },
    )
  },
  retryWebhookDelivery(
    token: string,
    accountId: string,
    webhookId: string,
    deliveryId: string,
  ) {
    return request<void>(
      `/accounts/${accountId}/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
      { method: 'POST', token },
    )
  },

  // ─── contact GDPR ───
  exportContact(token: string, accountId: string, id: string) {
    return request<Record<string, unknown>>(
      `/accounts/${accountId}/contacts/${id}/export`,
      { method: 'GET', token },
    )
  },
  anonymizeContact(token: string, accountId: string, id: string) {
    return request<ContactDTO>(
      `/accounts/${accountId}/contacts/${id}/anonymize`,
      { method: 'POST', token },
    )
  },

  // ─── contact import ───
  importContacts(token: string, accountId: string, body: ContactImportInput) {
    return request<ContactImportResult>(
      `/accounts/${accountId}/contacts/import`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },

  // ─── csat ───
  getSurveySettings(token: string, accountId: string) {
    return request<SurveySettingsDTO>(`/accounts/${accountId}/csat/settings`, { method: 'GET', token })
  },
  updateSurveySettings(token: string, accountId: string, body: SurveySettingsDTO) {
    return request<SurveySettingsDTO>(`/accounts/${accountId}/csat/settings`, {
      method: 'PUT',
      token,
      body: JSON.stringify(body),
    })
  },
  getNpsStats(token: string, accountId: string, query?: NpsQuery) {
    return request<NpsStats>(`/accounts/${accountId}/csat/nps${npsParams(query)}`, { method: 'GET', token })
  },
  getNpsCsv(token: string, accountId: string, query?: NpsQuery) {
    return request<string>(`/accounts/${accountId}/csat/nps.csv${npsParams(query)}`, { method: 'GET', token })
  },
  getCsatStats(token: string, accountId: string, query?: CsatStatsQuery) {
    const params = new URLSearchParams()
    if (query?.inboxId) params.set('inboxId', query.inboxId)
    if (query?.agentId) params.set('agentId', query.agentId)
    if (query?.from) params.set('from', query.from)
    if (query?.to) params.set('to', query.to)
    const qs = params.toString() ? `?${params}` : ''
    return request<CsatStats>(`/accounts/${accountId}/csat/stats${qs}`, {
      method: 'GET',
      token,
    })
  },

  // ─── knowledge base ───
  listArticles(token: string, accountId: string, query?: ListArticlesQuery) {
    const params = new URLSearchParams()
    if (query?.status) params.set('status', query.status)
    if (query?.q) params.set('q', query.q)
    if (query?.limit) params.set('limit', String(query.limit))
    const qs = params.toString() ? `?${params}` : ''
    return request<ArticleDTO[]>(`/accounts/${accountId}/articles${qs}`, {
      method: 'GET',
      token,
    })
  },
  getArticle(token: string, accountId: string, id: string) {
    return request<ArticleDTO>(`/accounts/${accountId}/articles/${id}`, {
      method: 'GET',
      token,
    })
  },
  createArticle(token: string, accountId: string, body: CreateArticleInput) {
    return request<ArticleDTO>(`/accounts/${accountId}/articles`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateArticle(
    token: string,
    accountId: string,
    id: string,
    body: UpdateArticleInput,
  ) {
    return request<ArticleDTO>(`/accounts/${accountId}/articles/${id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteArticle(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/articles/${id}`, {
      method: 'DELETE',
      token,
    })
  },
  searchArticles(token: string, accountId: string, q: string, limit?: number) {
    const params = new URLSearchParams({ q })
    if (limit) params.set('limit', String(limit))
    return request<ArticleHitDTO[]>(
      `/accounts/${accountId}/articles/search?${params}`,
      { method: 'GET', token },
    )
  },

  // ─── sla ───
  listSlaPolicies(token: string, accountId: string) {
    return request<SlaPolicyDTO[]>(`/accounts/${accountId}/sla-policies`, {
      method: 'GET',
      token,
    })
  },
  createSlaPolicy(token: string, accountId: string, body: CreateSlaPolicyInput) {
    return request<SlaPolicyDTO>(`/accounts/${accountId}/sla-policies`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  updateSlaPolicy(
    token: string,
    accountId: string,
    id: string,
    body: UpdateSlaPolicyInput,
  ) {
    return request<SlaPolicyDTO>(`/accounts/${accountId}/sla-policies/${id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    })
  },
  deleteSlaPolicy(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/sla-policies/${id}`, {
      method: 'DELETE',
      token,
    })
  },

  // ─── conversation forwarding ───
  forwardConversation(
    token: string,
    accountId: string,
    conversationId: string,
    body: ForwardConversationInput,
  ) {
    return request<ForwardConversationResult>(
      `/accounts/${accountId}/conversations/${conversationId}/forward`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },

  // ─── api keys ───
  listApiKeys(token: string, accountId: string) {
    return request<ApiKeyDTO[]>(`/accounts/${accountId}/api-keys`, {
      method: 'GET',
      token,
    })
  },
  createApiKey(token: string, accountId: string, body: CreateApiKeyInput) {
    return request<ApiKeyWithSecret>(`/accounts/${accountId}/api-keys`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    })
  },
  revokeApiKey(token: string, accountId: string, id: string) {
    return request<void>(`/accounts/${accountId}/api-keys/${id}`, {
      method: 'DELETE',
      token,
    })
  },

  // ─── 2FA ───
  totpSetup(token: string) {
    return request<TotpSetupResponse>('/auth/me/2fa/setup', {
      method: 'POST',
      token,
    })
  },
  totpVerify(token: string, code: string) {
    return request<TotpVerifyResponse>('/auth/me/2fa/verify', {
      method: 'POST',
      token,
      body: JSON.stringify({ code }),
    })
  },
  totpDisable(token: string, code: string) {
    return request<void>('/auth/me/2fa/disable', {
      method: 'POST',
      token,
      body: JSON.stringify({ code }),
    })
  },
  totpChallenge(challengeToken: string, code: string) {
    return request<AuthEnvelope>('/auth/2fa/challenge', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, code }),
    })
  },

  // ─── member management ───
  inviteMember(
    token: string,
    accountId: string,
    body: { email: string; role: 'ADMINISTRATOR' | 'SUPERVISOR' | 'AGENT' | 'BOT'; fullName?: string },
  ) {
    return request<AccountMemberDTO>(
      `/accounts/${accountId}/members`,
      { method: 'POST', token, body: JSON.stringify(body) },
    )
  },
  removeMember(token: string, accountId: string, userId: string) {
    return request<void>(`/accounts/${accountId}/members/${userId}`, {
      method: 'DELETE',
      token,
    })
  },
  changeMemberRole(
    token: string,
    accountId: string,
    userId: string,
    body: ChangeMemberRoleInput,
  ) {
    return request<AccountMemberDTO>(
      `/accounts/${accountId}/members/${userId}`,
      { method: 'PATCH', token, body: JSON.stringify(body) },
    )
  },

  // ─── global search ───
  search(token: string, accountId: string, q: string) {
    const params = new URLSearchParams({ q })
    return request<{
      hits: Array<{
        kind: 'contact' | 'conversation' | 'article'
        id: string
        title: string
        subtitle: string | null
      }>
    }>(`/accounts/${accountId}/search?${params}`, { method: 'GET', token })
  },

  // ─── onboarding ───
  getOnboarding(token: string, accountId: string) {
    return request<OnboardingStatusDTO>(`/accounts/${accountId}/onboarding`, {
      method: 'GET',
      token,
    })
  },

  // ─── welcome flow (commercial profile) ───
  //
  // GET answers `null` for an account that never started the flow, which is
  // how the resume prompt and /welcome tell "pending" from "done".
  getAccountProfile(token: string, accountId: string) {
    return request<AccountProfileDTO | null>(`/accounts/${accountId}/profile`, {
      method: 'GET',
      token,
    })
  },
  saveAccountProfile(
    token: string,
    accountId: string,
    body: UpsertAccountProfileInput,
  ) {
    return request<AccountProfileDTO>(`/accounts/${accountId}/profile`, {
      method: 'PUT',
      token,
      body: JSON.stringify(body),
    })
  },

  // ─── usage / billing ───
  getUsage(token: string, accountId: string) {
    return request<UsageDTO>(`/accounts/${accountId}/usage`, {
      method: 'GET',
      token,
    })
  },

  /**
   * Set (or clear) the account's own monthly ceiling on AI overage, in BRL.
   * `null` clears it, which is the default: no ceiling unless asked for.
   */
  setAiOverageCap(
    token: string,
    accountId: string,
    capBrl: number | null,
  ) {
    return request<{ capBrl: number | null; capConversations: number | null }>(
      `/accounts/${accountId}/usage/ai-cap`,
      { method: 'PATCH', token, body: JSON.stringify({ capBrl }) },
    )
  },

  /**
   * Ask whoever handles billing for a bigger plan. Deliberately a message to
   * a human rather than a plan change: changing a plan means a pro-rata
   * charge and a new subscription, which only cosmo-admin can do correctly.
   */
  requestPlanUpgrade(token: string, accountId: string) {
    return request<{ requested: boolean; emailed: boolean }>(
      `/accounts/${accountId}/usage/upgrade-request`,
      { method: 'POST', token },
    )
  },
}

export type SlaMissesFilter = { from?: string; to?: string; teamId?: string; inboxId?: string }

function slaMissesParams(q: SlaMissesFilter): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v)
  return params.toString()
}
