'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type {
  AutomationAction,
  AutomationActionKind,
  AutomationCondition,
  AutomationConditionField,
  AutomationConditionOp,
  AutomationRuleDTO,
  AutomationTriggerEvent,
  CreateAutomationRuleInput,
} from '@cosmika/shared'
import {
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@cosmika/ui'

const TRIGGERS: AutomationTriggerEvent[] = [
  'CONVERSATION_CREATED',
  'MESSAGE_CREATED',
  'CONVERSATION_UPDATED',
]

const FIELDS: AutomationConditionField[] = [
  'INBOX_ID',
  'PRIORITY',
  'STATUS',
  'CONTENT_CONTAINS',
  'CONTACT_EMAIL_DOMAIN',
  'TAG_INCLUDES',
  'OUTSIDE_WORKING_HOURS',
  'IS_FIRST_MESSAGE',
]

const OPS: AutomationConditionOp[] = [
  'equals',
  'not_equals',
  'in',
  'contains',
  'is_true',
]

const KINDS: AutomationActionKind[] = [
  'ASSIGN_TEAM',
  'ASSIGN_USER',
  'SET_PRIORITY',
  'ADD_TAG',
  'SET_STATUS',
  'SEND_REPLY',
]

export type RuleFormValues = CreateAutomationRuleInput

export function RuleForm({
  initial,
  submitting,
  onSubmit,
  onDelete,
}: {
  initial?: AutomationRuleDTO
  submitting?: boolean
  onSubmit: (values: RuleFormValues) => void
  onDelete?: () => void
}) {
  const t = useTranslations()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [triggerEvent, setTriggerEvent] = useState<AutomationTriggerEvent>(
    initial?.triggerEvent ?? 'MESSAGE_CREATED',
  )
  const [isActive, setIsActive] = useState(initial?.isActive ?? true)
  const [runOnce, setRunOnce] = useState(
    initial?.runOncePerConversation ?? true,
  )
  const [conditions, setConditions] = useState<AutomationCondition[]>(
    initial?.conditions ?? [],
  )
  const [actions, setActions] = useState<AutomationAction[]>(
    initial?.actions ?? [],
  )
  const [error, setError] = useState<string | null>(null)

  function addCondition() {
    setConditions((c) => [
      ...c,
      { field: 'CONTENT_CONTAINS', op: 'contains', value: '' },
    ])
  }
  function updateCondition(i: number, patch: Partial<AutomationCondition>) {
    setConditions((c) =>
      c.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    )
  }
  function removeCondition(i: number) {
    setConditions((c) => c.filter((_, idx) => idx !== i))
  }

  function addAction() {
    setActions((a) => [...a, { kind: 'ADD_TAG', value: '' }])
  }
  function updateAction(i: number, patch: Partial<AutomationAction>) {
    setActions((a) =>
      a.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    )
  }
  function removeAction(i: number) {
    setActions((a) => a.filter((_, idx) => idx !== i))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (actions.length === 0) {
      setError(t('automation.no_actions_yet'))
      return
    }
    onSubmit({
      name,
      description: description.trim() ? description : null,
      triggerEvent,
      isActive,
      runOncePerConversation: runOnce,
      conditions,
      actions,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <FormField label={t('automation.name')} htmlFor="rule-name" required>
          <Input
            id="rule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="rule-name"
          />
        </FormField>
        <FormField label={t('automation.description')} htmlFor="rule-description">
          <Input
            id="rule-description"
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <FormField label={t('automation.trigger')} htmlFor="rule-trigger">
          <Select
            value={triggerEvent}
            onValueChange={(v) => setTriggerEvent(v as AutomationTriggerEvent)}
          >
            <SelectTrigger id="rule-trigger" data-testid="rule-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRIGGERS.map((tr) => (
                <SelectItem key={tr} value={tr}>
                  {t(`automation.trigger_${tr}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={isActive}
              onCheckedChange={(v) => setIsActive(v === true)}
              data-testid="rule-active"
            />
            {t('automation.is_active')}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={runOnce} onCheckedChange={(v) => setRunOnce(v === true)} />
            {t('automation.run_once')}
          </label>
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">{t('automation.conditions')}</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addCondition}
            data-testid="add-condition"
          >
            {t('automation.add_condition')}
          </Button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-xs text-muted-foreground">-</p>
        ) : (
          conditions.map((cond, i) => (
            <div
              key={i}
              className="flex flex-wrap items-end gap-2 rounded border border-border p-2"
              data-testid={`condition-${i}`}
            >
              <Select
                value={cond.field}
                onValueChange={(v) =>
                  updateCondition(i, { field: v as AutomationConditionField })
                }
              >
                <SelectTrigger className="h-8 w-40 text-sm" aria-label={t('automation.field')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELDS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {t(`automation.field_${f}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={cond.op}
                onValueChange={(v) => updateCondition(i, { op: v as AutomationConditionOp })}
              >
                <SelectTrigger className="h-8 w-36 text-sm" aria-label={t('automation.op')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {t(`automation.op_${o}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label={t('automation.value')}
                value={
                  typeof cond.value === 'string'
                    ? cond.value
                    : Array.isArray(cond.value)
                      ? cond.value.join(',')
                      : String(cond.value ?? '')
                }
                onChange={(e) => updateCondition(i, { value: e.target.value })}
                className="h-8 flex-1 text-sm"
                placeholder={t('automation.value')}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => removeCondition(i)}
              >
                {t('automation.remove')}
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">{t('automation.actions')}</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addAction}
            data-testid="add-action"
          >
            {t('automation.add_action')}
          </Button>
        </div>
        {actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('automation.no_actions_yet')}
          </p>
        ) : (
          actions.map((act, i) => (
            <div
              key={i}
              className="flex flex-wrap items-end gap-2 rounded border border-border p-2"
              data-testid={`action-${i}`}
            >
              <Select
                value={act.kind}
                onValueChange={(v) => updateAction(i, { kind: v as AutomationActionKind })}
              >
                <SelectTrigger className="h-8 w-44 text-sm" aria-label={t('automation.kind')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`automation.kind_${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={act.value}
                onChange={(e) => updateAction(i, { value: e.target.value })}
                className="h-8 flex-1 text-sm"
                placeholder={t('automation.value')}
                aria-label={t('automation.value')}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => removeAction(i)}
              >
                {t('automation.remove')}
              </Button>
              {act.kind === 'SEND_REPLY' ? (
                <p className="w-full text-xs text-muted-foreground" data-testid={`action-${i}-send-reply-hint`}>
                  {t('automation.send_reply_hint')}
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button type="submit" disabled={submitting} data-testid="save-rule">
          {t('automation.save_changes')}
        </Button>
        {onDelete ? (
          <Button
            type="button"
            variant="outline"
            onClick={onDelete}
            data-testid="delete-rule"
          >
            {t('automation.delete')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
