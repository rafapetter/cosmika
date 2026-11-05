'use client'

// Binds the flow builder's words to the viewer's language. `flow-edit.ts`
// stays framework-free and takes a FlowText; this hook builds one from
// next-intl so every screen of the builder speaks the same vocabulary.

import * as React from 'react'
import { useTranslations } from 'next-intl'

import type { FlowText } from './flow-edit'

type T = ReturnType<typeof useTranslations>

// Block type ids are stored in the definition exactly as Typebot/Cosmo-Flows
// wrote them; several spellings map to one label.
const BLOCK_TYPE_KEYS: Record<string, string> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  embed: 'embed',
  cards: 'cards',
  'text input': 'text_input',
  'number input': 'number_input',
  'email input': 'email_input',
  'url input': 'url_input',
  'phone number input': 'phone_input',
  'phone input': 'phone_input',
  'choice input': 'choice_input',
  Condition: 'condition',
  'Set variable': 'set_variable',
  Jump: 'jump',
  'AB test': 'ab_test',
  Wait: 'wait',
  Redirect: 'redirect',
  Webview: 'webview',
  'Cosmoflow link': 'subflow',
  note: 'note',
  'end-session': 'end_session',
  Webhook: 'webhook',
  webhook: 'webhook',
  api_call: 'webhook',
  'API call': 'webhook',
  OpenAI: 'openai',
  openai: 'openai',
  'AI agent': 'ai_agent',
  'WhatsApp Template': 'whatsapp_template',
  Cosmodesk: 'handoff',
  cosmodesk: 'handoff',
  'Google Sheets': 'google_sheets',
  Email: 'email',
  'Ticket Create': 'ticket_create',
  'Ticket Update': 'ticket_update',
  'Ticket Query': 'ticket_query',
}

/** The block type as the author should read it; unknown types show their id. */
export function blockTypeLabel(t: T, type: string): string {
  const key = BLOCK_TYPE_KEYS[type]
  return key ? t(`flows.type_${key}` as never) : type
}

// Comparison operators are stored Typebot-style in English; only the label
// is translated.
const OPERATOR_KEYS: Record<string, string> = {
  Equal: 'equal',
  'Not equal': 'not_equal',
  Contains: 'contains',
  'Does not contain': 'not_contains',
  'Starts with': 'starts_with',
  'Ends with': 'ends_with',
  'Is set': 'is_set',
  'Is empty': 'is_empty',
  'Greater than': 'greater_than',
  'Less than': 'less_than',
  'Is before': 'is_before',
  'Is after': 'is_after',
  'Is between': 'is_between',
}

export function operatorLabel(t: T, op: string): string {
  const key = OPERATOR_KEYS[op]
  return key ? t(`flows.op_${key}` as never) : op
}

export function flowText(t: T): FlowText {
  return {
    startGroup: t('flows.start_group'),
    starterMessage: t('flows.starter_message'),
    newMessage: t('flows.new_message'),
    group: (n) => t('flows.group_n', { n }),
    groupFallback: t('flows.group'),
    copyOf: (title) => t('flows.copy_of', { title }),
    emptyText: t('flows.summary_empty_text'),
    emptyMedia: (type) => t('flows.summary_empty_media', { type }),
    ask: (variable) => t('flows.summary_ask', { variable }),
    aVariable: t('flows.summary_a_variable'),
    branchOnCondition: t('flows.summary_condition'),
    setVariable: (variable) => t('flows.summary_set', { variable }),
    jumpTo: (group) => t('flows.summary_jump', { group }),
    aGroup: t('flows.summary_a_group'),
    runSubflow: (flow) => t('flows.summary_subflow', { flow }),
    branch: (n) => t('flows.branch_n', { n }),
    bucket: (n, weight) => t('flows.bucket_n', { n, weight }),
    option: (n) => t('flows.option_n', { n }),
    typeLabel: (type) => blockTypeLabel(t, type),
  }
}

export function useFlowText(): FlowText {
  const t = useTranslations()
  return React.useMemo(() => flowText(t), [t])
}
