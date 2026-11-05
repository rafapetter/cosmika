import { z } from 'zod'

export const AutomationTriggerEvent = z.enum([
  'CONVERSATION_CREATED',
  'MESSAGE_CREATED',
  'CONVERSATION_UPDATED',
])
export type AutomationTriggerEvent = z.infer<typeof AutomationTriggerEvent>

export const AutomationConditionField = z.enum([
  'INBOX_ID',
  'PRIORITY',
  'STATUS',
  'CONTENT_CONTAINS',
  'CONTACT_EMAIL_DOMAIN',
  'TAG_INCLUDES',
  'OUTSIDE_WORKING_HOURS',
  'IS_FIRST_MESSAGE',
])
export type AutomationConditionField = z.infer<typeof AutomationConditionField>

export const AutomationConditionOp = z.enum([
  'equals',
  'not_equals',
  'in',
  'contains',
  'is_true',
])
export type AutomationConditionOp = z.infer<typeof AutomationConditionOp>

export const AutomationCondition = z.object({
  field: AutomationConditionField,
  op: AutomationConditionOp,
  // value can be string | string[] | boolean | null depending on field/op
  value: z.union([
    z.string(),
    z.array(z.string()),
    z.boolean(),
    z.null(),
  ]),
})
export type AutomationCondition = z.infer<typeof AutomationCondition>

export const AutomationActionKind = z.enum([
  'ASSIGN_TEAM',
  'ASSIGN_USER',
  'SET_PRIORITY',
  'ADD_TAG',
  'SET_STATUS',
  'SEND_REPLY',
])
export type AutomationActionKind = z.infer<typeof AutomationActionKind>

// The only statuses a conversation can hold (mirrors the ConversationStatus
// enum in the database). SET_STATUS is checked against this list here, at the
// API boundary, so a rule that would fail on write is rejected up front
// instead of erroring every time it runs.
export const SET_STATUS_VALUES = ['OPEN', 'RESOLVED', 'PENDING'] as const

export const AutomationAction = z
  .object({
    kind: AutomationActionKind,
    // value is action-specific: teamId/userId for ASSIGN_*, NORMAL|HIGH|... for SET_PRIORITY,
    // tag string for ADD_TAG, OPEN|RESOLVED|PENDING for SET_STATUS, message body for SEND_REPLY
    value: z.string().min(1).max(4000),
  })
  .superRefine((action, ctx) => {
    if (action.kind !== 'SET_STATUS') return
    if ((SET_STATUS_VALUES as readonly string[]).includes(action.value)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: `SET_STATUS accepts ${SET_STATUS_VALUES.join(' | ')}`,
    })
  })
export type AutomationAction = z.infer<typeof AutomationAction>

export const CreateAutomationRuleInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  triggerEvent: AutomationTriggerEvent,
  isActive: z.boolean().optional(),
  conditions: z.array(AutomationCondition).max(20).default([]),
  actions: z.array(AutomationAction).min(1).max(10),
  runOncePerConversation: z.boolean().optional(),
})
export type CreateAutomationRuleInput = z.infer<typeof CreateAutomationRuleInput>

export const UpdateAutomationRuleInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  triggerEvent: AutomationTriggerEvent.optional(),
  isActive: z.boolean().optional(),
  conditions: z.array(AutomationCondition).max(20).optional(),
  actions: z.array(AutomationAction).min(1).max(10).optional(),
  runOncePerConversation: z.boolean().optional(),
})
export type UpdateAutomationRuleInput = z.infer<typeof UpdateAutomationRuleInput>

export const AutomationRuleDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: AutomationTriggerEvent,
  isActive: z.boolean(),
  conditions: z.array(AutomationCondition),
  actions: z.array(AutomationAction),
  runOncePerConversation: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AutomationRuleDTO = z.infer<typeof AutomationRuleDTO>

export const AutomationDryRunQuery = z.object({
  conversationId: z.string().min(1),
})
export type AutomationDryRunQuery = z.infer<typeof AutomationDryRunQuery>

export const AutomationDryRunResult = z.object({
  matched: z.boolean(),
  conditionResults: z.array(
    z.object({
      field: AutomationConditionField,
      op: AutomationConditionOp,
      matched: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  wouldExecute: z.array(AutomationAction),
})
export type AutomationDryRunResult = z.infer<typeof AutomationDryRunResult>
