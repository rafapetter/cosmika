'use client'

// Names for what the assistant did and for the data behind it.
//
// Tool names and output keys are code identifiers, so the evidence panel used
// to show them prettified into English ("Set inbox AI mode", "Created at").
// Here they get real labels; anything this build has no word for still falls
// back to the prettified identifier, which is better than hiding a column.

import type { useTranslations } from 'next-intl'

import { humaniseKey, humaniseToolName } from './format'

type T = ReturnType<typeof useTranslations>

/** snake_case of an output key, which is how the messages are keyed. */
export function keyToken(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

const TOOL_NAMES = new Set([
  'account_overview', 'ai_spend', 'conversation_stats', 'csat_summary', 'recent_audit_log',
  'search_conversations', 'list_inboxes', 'create_inbox', 'update_inbox', 'add_inbox_member',
  'remove_inbox_member', 'set_inbox_ai_mode', 'set_inbox_default_flow', 'set_inbox_flow_mode',
  'set_csat_enabled', 'list_members', 'invite_member', 'set_member_role', 'deactivate_member',
  'list_teams', 'create_team', 'update_team', 'delete_team', 'add_team_member', 'remove_team_member',
  'list_labels', 'create_label', 'update_label', 'delete_label', 'label_conversation',
  'list_canned_responses', 'create_canned_response', 'update_canned_response',
  'delete_canned_response', 'list_articles', 'get_article', 'create_article', 'update_article',
  'delete_article', 'list_agent_bots', 'create_agent_bot', 'set_agent_bot_config',
  'set_agent_bot_prompt', 'list_flows', 'get_flow', 'create_flow', 'publish_flow',
  'revert_flow_draft', 'add_flow_group', 'rename_flow_group', 'delete_flow_group', 'add_flow_block',
  'update_flow_block', 'delete_flow_block', 'connect_flow_blocks', 'connect_flow_option',
  'set_flow_choice_options', 'set_flow_hours_condition', 'list_automations', 'create_automation', 'update_automation',
  'delete_automation', 'list_sla_policies', 'create_sla_policy', 'update_sla_policy',
  'delete_sla_policy', 'get_working_hours', 'set_working_hours', 'add_holiday', 'delete_holiday',
  'list_broadcast_templates', 'create_broadcast', 'send_broadcast', 'list_tickets', 'update_ticket',
  'update_conversation', 'set_account_settings', 'assign_conversation',
  'change_conversation_status', 'send_message', 'search_knowledge', 'tag_conversation',
  'add_internal_note', 'assign_conversation_to_human', 'attach_tag',
  'read_knowledge_base_article', 'search_knowledge_base', 'set_priority',
])

const KEY_NAMES = new Set([
  'id', 'name', 'full_name', 'title', 'description', 'email', 'role', 'status', 'priority',
  'is_active', 'enabled', 'created', 'updated', 'deleted', 'removed', 'added', 'created_at',
  'updated_at', 'last_active_at', 'inbox', 'inbox_name', 'channel_type', 'team', 'tags', 'type',
  'category', 'content', 'text', 'slug', 'shortcode', 'model', 'published', 'critical', 'approve',
  'always_approve', 'user_id', 'conversation_id', 'display_id', 'total_cost_usd',
  'monthly_ai_budget_usd', 'csat_enabled', 'csat_on_resolve', 'greeting_enabled',
  'greeting_message', 'out_of_office_message', 'working_hours_enabled', 'ai_autoreply_mode',
  'admin_agent_requires_approval', 'default_flow_id', 'trigger_event', 'variables', 'options',
  'website_name', 'website_url', 'via_admin_agent', 'first_publish', 'input', 'transcript',
  'count', 'conversations', 'members', 'inboxes', 'teams', 'labels', 'flows', 'articles',
  'tickets', 'automations', 'agent_bots', 'canned_responses', 'sla_policies', 'holidays',
  'templates',
  // argument names the approval card shows
  'inbox_id', 'team_id', 'label_id', 'article_id', 'flow_id', 'group_id', 'block_id',
  'automation_id', 'agent_bot_id', 'sla_policy_id', 'canned_response_id', 'broadcast_id',
  'ticket_id', 'template_id', 'holiday_id', 'assignee_id', 'member_id', 'mode', 'date', 'value',
  'query', 'limit', 'color', 'primary_color', 'country', 'remove', 'temperature', 'system_prompt',
  'fallback_to_human', 'run_once_per_conversation', 'closed_all_day', 'conversation', 'reason',
  'note', 'tag',
])

const VALUE_NAMES = new Set([
  'draft', 'auto_safe', 'auto_full', 'guided', 'strict', 'off', 'open', 'pending', 'resolved',
  'closed', 'snoozed', 'administrator', 'supervisor', 'agent', 'bot', 'published', 'archived',
  'active', 'suspended', 'terminated', 'low', 'normal', 'high', 'urgent', 'whatsapp', 'api',
  'web_widget', 'email', 'instagram', 'telegram',
])

/** What the assistant did, in words. */
export function toolLabel(t: T, name: string): string {
  return TOOL_NAMES.has(name)
    ? t(`assistantTools.${name}` as never)
    : humaniseToolName(name)
}

/** A column or stat name, in words. */
export function keyLabel(t: T, key: string): string {
  const token = keyToken(key)
  return KEY_NAMES.has(token) ? t(`assistantKeys.${token}` as never) : humaniseKey(key)
}

/** An enum value the API returns, in words. */
export function valueLabel(t: T, value: string): string {
  const token = value.toLowerCase()
  return VALUE_NAMES.has(token) ? t(`assistantValues.${token}` as never) : value
}
