// Stable error codes the API sends and the web translates.
//
// The HTTP message stays English for logs and for API consumers; the code is
// what the interface keys its wording off, so a Portuguese operator never
// reads an English sentence. Codes are append-only: renaming one silently
// falls the interface back to the generic wording for that status.

export const API_ERROR_CODES = [
  // access
  'not_a_member',
  'admin_required',
  'supervisor_required',
  'insufficient_role',
  'not_inbox_member',
  'not_target_inbox_member',
  'inbound_requires_role',
  'conversation_closed',
  'reaction_unavailable',
  'reaction_failed',
  'agents_add_self_only',
  'agents_remove_self_only',
  'own_availability_only',
  // input
  'invalid_input',
  'invalid_filters',
  'invalid_date_range',
  'range_too_large',
  // sign-in and account security
  'invalid_credentials',
  'email_taken',
  'invite_code_required',
  'no_membership',
  'reset_link_invalid',
  'invalid_challenge',
  'challenge_expired',
  'invalid_code',
  'totp_setup_missing',
  'totp_already_enabled',
  'totp_code_mismatch',
  'totp_not_enabled',
  'current_password_wrong',
  // uniqueness
  'shortcode_taken',
  'label_title_taken',
  'attribute_key_taken',
  'slug_taken',
  'source_id_taken',
  // membership
  'already_member',
  'already_inbox_member',
  'already_team_member',
  'already_participant',
  'last_admin_remove',
  'last_admin_demote',
  'remove_self_via_leave',
  // channels
  'inbox_not_whatsapp',
  'whatsapp_credentials_missing',
  'telegram_token_invalid',
  'telegram_webhook_failed',
  'telegram_credentials_missing',
  'meta_page_invalid',
  'meta_instagram_not_linked',
  'meta_subscribe_failed',
  'meta_credentials_missing',
  'whatsapp_credentials_endpoint',
  'whatsapp_phone_in_use',
  'whatsapp_credentials_save_failed',
  'inbox_has_conversations',
  // WhatsApp Embedded Signup
  'whatsapp_es_phone_required',
  'whatsapp_es_phone_already_connected',
  'whatsapp_es_code_rejected',
  'whatsapp_es_waba_not_granted',
  'whatsapp_es_subscribe_failed',
  'whatsapp_es_register_failed',
  // sending
  'template_not_approved',
  'template_variable_count',
  'whatsapp_send_failed',
  'whatsapp_sync_failed',
  'broadcast_needs_whatsapp',
  'broadcast_already_sent',
  'message_or_attachment_required',
  // flows
  'flow_invalid',
  // attachments
  'file_empty',
  'file_too_large',
  'file_use_presigned',
  'attachment_not_found',
  'attachment_already_linked',
  'upload_multipart_required',
  'upload_no_file',
  // contacts
  'contact_blocked',
  'merge_target_in_sources',
  'merge_duplicate_sources',
  // surveys
  'csat_already_submitted',
  'csat_link_expired',
  // limits and billing
  'ai_budget_exceeded',
  'plan_limit_exceeded',
  'subscription_inactive',
  'account_not_found',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

const KNOWN = new Set<string>(API_ERROR_CODES)

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && KNOWN.has(value)
}
