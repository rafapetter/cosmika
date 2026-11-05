'use client'

// Rich per-block property editors for the flow builder drawer, plus the
// variables panel. Every editor writes exactly the option keys the FlowEngine
// reads (apps/api flow-engine.ts) so authored blocks run without translation.
// Page-coupled component (`_` prefix): exercised by e2e, not unit tests.

import * as React from 'react'
import { useTranslations } from 'next-intl'
import type { AgentBotDTO, FlowSummaryDTO, TeamDTO } from '@cosmika/shared'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

import { api } from '../../../lib/api'
import {
  addItem,
  addVariable,
  blockItems,
  blockTargetGroup,
  conditionItemPatch,
  genId,
  groupChoices,
  itemComparisons,
  itemLogicalOperator,
  itemTargetGroup,
  removeItem,
  removeVariable,
  setBlockNext,
  setBlockOptions,
  setItemNext,
  updateItem,
  variableUseCount,
  variables,
  type Def,
} from '../flow-edit'
import { blockTypeLabel, operatorLabel, useFlowText } from '../_flow-text'

type BlockShape = { id: string; type: string } & Record<string, unknown>

export type EditorProps = {
  def: Def
  groupId: string
  block: BlockShape
  onChange: (d: Def) => void
  token: string
  accountId: string
}

// Compact sizes for the narrow drawer; the controls themselves come from @cosmika/ui.
const inputCls = 'h-8 px-2 text-xs'
const textareaCls = 'min-h-0 px-2 py-1.5 text-xs'
const triggerCls = 'h-8 px-2 text-xs'
const miniBtnCls = 'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-destructive'
const addBtnCls =
  'w-full rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-primary hover:text-primary'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

// Radix Select reserves the empty string, so "nothing picked" travels as a sentinel.
const NONE = '__none__'

function CompactSelect({
  value,
  onValue,
  placeholder,
  options,
  testid,
  ariaLabel,
}: {
  value: string
  onValue: (v: string) => void
  placeholder?: string
  options: { value: string; label: string }[]
  testid?: string
  ariaLabel?: string
}) {
  return (
    <Select value={value === '' ? NONE : value} onValueChange={(v) => onValue(v === NONE ? '' : v)}>
      <SelectTrigger className={triggerCls} data-testid={testid} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {placeholder !== undefined ? (
          <SelectItem value={NONE} className="text-xs">
            {placeholder}
          </SelectItem>
        ) : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ─── shared pickers ─────────────────────────────────────────────────────

/**
 * Variable dropdown. Picking "+ New variable…" prompts for a name and hands
 * back BOTH the picked id and a def that already contains the variable, so
 * callers apply one atomic change.
 */
function VarSelect({
  def,
  value,
  onPick,
  placeholder,
  testid,
  builtins = [],
}: {
  def: Def
  value: string
  onPick: (varId: string, def2: Def) => void
  placeholder?: string
  testid?: string
  // System variables offered ahead of the flow's own (e.g. `now`).
  builtins?: { value: string; label: string }[]
}) {
  const t = useTranslations()
  const vars = variables(def)
  const options = [...builtins, ...vars.map((v) => ({ value: v.id, label: v.name }))]
  if (value && !options.some((o) => o.value === value)) options.push({ value, label: value })
  options.push({ value: '__new__', label: `＋ ${t('flows.new_variable')}` })
  return (
    <CompactSelect
      value={value}
      placeholder={placeholder ?? t('flows.pick_none')}
      options={options}
      testid={testid}
      onValue={(v) => {
        if (v === '__new__') {
          const name = window.prompt(t('flows.new_variable_prompt'))?.trim()
          if (name) onPick(name, addVariable(def, name))
          return
        }
        onPick(v, def)
      }}
    />
  )
}

/** Textarea with an "insert {{variable}} at cursor" dropdown underneath. */
function VarTextarea({
  def,
  value,
  onValue,
  rows = 4,
  placeholder,
  testid,
}: {
  def: Def
  value: string
  onValue: (v: string) => void
  rows?: number
  placeholder?: string
  testid?: string
}) {
  const t = useTranslations()
  const ref = React.useRef<HTMLTextAreaElement | null>(null)
  const insert = (name: string) => {
    const el = ref.current
    const token = `{{${name}}}`
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? start
    onValue(value.slice(0, start) + token + value.slice(end))
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = start + token.length
      }
    })
  }
  // contact.* are built-in variables the engine fills from the contact record.
  const builtins = [
    { id: 'contact.name', label: t('flows.var_contact_name') },
    { id: 'contact.email', label: t('flows.var_contact_email') },
    { id: 'contact.phone', label: t('flows.var_contact_phone') },
    { id: 'now', label: t('flows.var_now') },
  ]
  return (
    <div>
      <Textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onValue(e.target.value)}
        className={textareaCls}
        data-testid={testid}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={`mt-1 text-left ${addBtnCls}`}>
            ＋ {t('flows.insert_variable')}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
          {variables(def).map((v) => (
            <DropdownMenuItem key={v.id} className="text-xs" onSelect={() => insert(v.id)}>
              {v.name}
            </DropdownMenuItem>
          ))}
          {builtins.map((b) => (
            <DropdownMenuItem key={b.id} className="text-xs" onSelect={() => insert(b.id)}>
              {b.label}
              <span className="ml-auto pl-2 font-mono text-[10px] text-muted-foreground">{b.id}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Group dropdown for branch/next targets. */
function TargetSelect({
  def,
  value,
  onPick,
  placeholder,
  testid,
}: {
  def: Def
  value: string | null
  onPick: (groupId: string) => void
  placeholder?: string
  testid?: string
}) {
  const t = useTranslations()
  const text = useFlowText()
  return (
    <CompactSelect
      value={value ?? ''}
      onValue={onPick}
      placeholder={placeholder ?? t('flows.pick_continue')}
      options={groupChoices(def, text).map((g) => ({ value: g.id, label: g.title }))}
      testid={testid}
    />
  )
}

// ─── per-type editors ───────────────────────────────────────────────────

function useOpts(p: EditorProps) {
  const o = (p.block.options ?? {}) as Record<string, unknown>
  const set = (patch: Record<string, unknown>) =>
    p.onChange(setBlockOptions(p.def, p.groupId, p.block.id, { ...o, ...patch }))
  return { o, set }
}

function TextEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  return (
    <Field label={t('flows.field_message')}>
      <VarTextarea
        def={p.def}
        value={str(o.content)}
        onValue={(v) => set({ content: v })}
        rows={5}
        placeholder={t('flows.message_placeholder')}
        testid="drawer-text"
      />
    </Field>
  )
}

function MediaEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  return (
    <>
      <Field label={t('flows.field_media_url', { type: blockTypeLabel(t, p.block.type) })}>
        <Input
          className={inputCls}
          value={str(o.url) || str(o.src)}
          onChange={(e) => set({ url: e.target.value })}
          placeholder="https://…"
        />
      </Field>
      <Field label={t('flows.field_caption')}>
        <VarTextarea def={p.def} value={str(o.caption)} onValue={(v) => set({ caption: v })} rows={2} />
      </Field>
    </>
  )
}

function UrlEditor(p: EditorProps & { label: string }) {
  const { o, set } = useOpts(p)
  return (
    <Field label={p.label}>
      <Input className={inputCls} value={str(o.url)} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" />
    </Field>
  )
}

const TYPED_INPUT_HINTS: Record<string, string> = {
  'text input': 'flows.hint_text_input',
  'email input': 'flows.hint_email_input',
  'number input': 'flows.hint_number_input',
  'phone number input': 'flows.hint_phone_input',
  'url input': 'flows.hint_url_input',
}

function TypedInputEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const hint = TYPED_INPUT_HINTS[p.block.type]
  return (
    <>
      <Field label={t('flows.field_save_answer')}>
        <VarSelect
          def={p.def}
          value={str(o.variableId)}
          onPick={(varId, def2) => p.onChange(setBlockOptions(def2, p.groupId, p.block.id, { ...o, variableId: varId }))}
          placeholder={t('flows.pick_dont_save')}
          testid="drawer-variable"
        />
      </Field>
      <Field label={t('flows.field_retry_invalid')}>
        <VarTextarea def={p.def} value={str(o.retryMessage)} onValue={(v) => set({ retryMessage: v })} rows={2} />
      </Field>
      <p className="text-[10px] text-muted-foreground">{hint ? t(hint as never) : ''}</p>
    </>
  )
}

function ChoiceEditor(p: EditorProps) {
  const t = useTranslations()
  const text = useFlowText()
  const { o, set } = useOpts(p)
  const items = blockItems(p.block)
  return (
    <>
      <Field label={t('flows.field_choice_message')}>
        <VarTextarea def={p.def} value={str(o.message)} onValue={(v) => set({ message: v })} rows={3} testid="drawer-choice-message" />
      </Field>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{t('flows.options')}</span>
        <div className="space-y-1.5">
          {items.map((it, idx) => {
            const itemId = str(it.id) || String(idx)
            return (
              <div key={itemId} className="rounded-md border border-border/60 p-1.5">
                <div className="flex items-center gap-1">
                  <Input
                    className={inputCls}
                    value={str(it.content)}
                    placeholder={text.option(idx + 1)}
                    onChange={(e) => p.onChange(updateItem(p.def, p.groupId, p.block.id, itemId, { content: e.target.value }))}
                    data-testid={`drawer-item-${idx}`}
                  />
                  <button
                    type="button"
                    className={miniBtnCls}
                    title={t('flows.remove_option')}
                    aria-label={t('flows.remove_option')}
                    onClick={() => p.onChange(removeItem(p.def, p.groupId, p.block.id, itemId))}
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">→</span>
                  <TargetSelect
                    def={p.def}
                    value={itemTargetGroup(p.def, p.block.id, itemId)}
                    onPick={(g) => p.onChange(setItemNext(p.def, p.groupId, p.block.id, itemId, g))}
                    testid={`drawer-item-target-${idx}`}
                  />
                </div>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className={`mt-1.5 ${addBtnCls}`}
          onClick={() => p.onChange(addItem(p.def, p.groupId, p.block.id, { content: text.option(items.length + 1) }))}
          data-testid="drawer-add-item"
        >
          + {t('flows.add_option')}
        </button>
        <p className="mt-1 text-[10px] text-muted-foreground">{t('flows.options_hint')}</p>
      </div>
      <Field label={t('flows.field_retry_no_match')}>
        <VarTextarea def={p.def} value={str(o.retryMessage)} onValue={(v) => set({ retryMessage: v })} rows={2} />
      </Field>
    </>
  )
}

// Operator labels stored Typebot-style; the engine lowercases before matching.
const OPERATORS = [
  'Equal',
  'Not equal',
  'Contains',
  'Does not contain',
  'Starts with',
  'Ends with',
  'Is set',
  'Is empty',
  'Greater than',
  'Less than',
  'Is before',
  'Is after',
  'Is between',
] as const
const NO_VALUE_OPS = new Set(['is set', 'is empty'])
// Compared as dates in the account timezone (flow-datetime.ts on the API).
const DATE_OPS = new Set(['is before', 'is after', 'is between'])

type Comparison = {
  id?: string
  variableId?: string
  comparisonOperator?: string
  value?: string
  valueTo?: string
}

/**
 * Fixed date/time for a date comparison. "Date and time" writes the
 * `datetime-local` shape (2026-10-20T18:00); "time of day" writes 18:00 and
 * matches every day. The engine reads both.
 */
function DateValueInput({
  value,
  timeOnly,
  onValue,
  ariaLabel,
}: {
  value: string
  timeOnly: boolean
  onValue: (v: string) => void
  ariaLabel: string
}) {
  const shown = timeOnly
    ? /^\d{1,2}:\d{2}$/.test(value) ? value.padStart(5, '0') : ''
    : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) ? value.slice(0, 16).replace(' ', 'T') : ''
  return (
    <Input
      type={timeOnly ? 'time' : 'datetime-local'}
      className={inputCls}
      value={shown}
      aria-label={ariaLabel}
      onChange={(e) => onValue(e.target.value)}
    />
  )
}

function DateComparisonValue({ c, patch }: { c: Comparison; patch: (cp: Partial<Comparison>) => void }) {
  const t = useTranslations()
  const timeOnly = /^\d{1,2}:\d{2}$/.test(str(c.value))
  const between = (c.comparisonOperator ?? '').toLowerCase() === 'is between'
  return (
    <div className="space-y-1">
      <CompactSelect
        value={timeOnly ? 'time' : 'datetime'}
        ariaLabel={t('flows.date_mode')}
        onValue={(v) => patch({ value: v === 'time' ? '00:00' : '', valueTo: undefined })}
        options={[
          { value: 'datetime', label: t('flows.date_mode_datetime') },
          { value: 'time', label: t('flows.date_mode_time') },
        ]}
      />
      <DateValueInput
        value={str(c.value)}
        timeOnly={timeOnly}
        ariaLabel={t('flows.date_from')}
        onValue={(v) => patch({ value: v })}
      />
      {between ? (
        <>
          <span className="block text-[10px] text-muted-foreground">{t('flows.date_until')}</span>
          <DateValueInput
            value={str(c.valueTo)}
            timeOnly={timeOnly}
            ariaLabel={t('flows.date_to')}
            onValue={(v) => patch({ valueTo: v })}
          />
        </>
      ) : null}
    </div>
  )
}

function ConditionEditor(p: EditorProps) {
  const t = useTranslations()
  const text = useFlowText()
  const items = blockItems(p.block)
  return (
    <div className="space-y-2">
      {items.map((it, idx) => {
        const itemId = str(it.id) || String(idx)
        const comparisons = itemComparisons(it) as Comparison[]
        const logical = itemLogicalOperator(it).toUpperCase()
        const patchComparisons = (next: Comparison[]) =>
          p.onChange(
            updateItem(p.def, p.groupId, p.block.id, itemId, conditionItemPatch(next as Record<string, unknown>[], logical)),
          )
        return (
          <div key={itemId} className="rounded-md border border-border/60 p-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {text.branch(idx + 1)}
              </span>
              <button
                type="button"
                className={miniBtnCls}
                title={t('flows.remove_branch')}
                aria-label={t('flows.remove_branch')}
                onClick={() => p.onChange(removeItem(p.def, p.groupId, p.block.id, itemId))}
              >
                ✕
              </button>
            </div>
            <div className="space-y-1.5">
              {comparisons.map((c, ci) => {
                const noValue = NO_VALUE_OPS.has((c.comparisonOperator ?? '').toLowerCase())
                const dateOp = DATE_OPS.has((c.comparisonOperator ?? '').toLowerCase())
                const patch = (cp: Partial<Comparison>) =>
                  patchComparisons(comparisons.map((x, i) => (i === ci ? { ...x, ...cp } : x)))
                return (
                  <div key={c.id ?? ci} className="space-y-1 rounded border border-border/40 p-1.5">
                    <VarSelect
                      def={p.def}
                      value={str(c.variableId)}
                      onPick={(varId, def2) => {
                        // apply variable creation + comparison patch in one change
                        const nextComparisons = comparisons.map((x, i) =>
                          i === ci ? { ...x, variableId: varId } : x,
                        )
                        p.onChange(updateItem(def2, p.groupId, p.block.id, itemId, { comparisons: nextComparisons }))
                      }}
                      placeholder={t('flows.pick_variable')}
                      builtins={[{ value: 'now', label: t('flows.var_now') }]}
                    />
                    <div className="flex items-center gap-1">
                      <CompactSelect
                        value={c.comparisonOperator ?? 'Equal'}
                        onValue={(v) => patch({ comparisonOperator: v })}
                        ariaLabel={t('flows.operator')}
                        options={[
                          ...OPERATORS.map((op) => ({ value: op, label: operatorLabel(t, op) })),
                          ...(c.comparisonOperator && !OPERATORS.some((op) => op === c.comparisonOperator)
                            ? [{ value: c.comparisonOperator, label: c.comparisonOperator }]
                            : []),
                        ]}
                      />
                      {!noValue && !dateOp ? (
                        <Input
                          className={inputCls}
                          value={str(c.value)}
                          placeholder={t('flows.value_placeholder')}
                          onChange={(e) => patch({ value: e.target.value })}
                        />
                      ) : null}
                      <button
                        type="button"
                        className={miniBtnCls}
                        title={t('flows.remove_comparison')}
                        aria-label={t('flows.remove_comparison')}
                        onClick={() => patchComparisons(comparisons.filter((_x, i) => i !== ci))}
                      >
                        ✕
                      </button>
                    </div>
                    {dateOp ? <DateComparisonValue c={c} patch={patch} /> : null}
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              className={`mt-1.5 ${addBtnCls}`}
              onClick={() =>
                patchComparisons([...comparisons, { id: genId('cmp'), variableId: '', comparisonOperator: 'Equal', value: '' }])
              }
            >
              + {t('flows.add_comparison')}
            </button>
            {comparisons.length > 1 ? (
              <div className="mt-1.5">
                <Field label={t('flows.field_combine')}>
                  <CompactSelect
                    value={logical}
                    onValue={(v) =>
                      p.onChange(
                        updateItem(
                          p.def,
                          p.groupId,
                          p.block.id,
                          itemId,
                          conditionItemPatch(comparisons as Record<string, unknown>[], v),
                        ),
                      )
                    }
                    options={[
                      { value: 'AND', label: t('flows.logic_and') },
                      { value: 'OR', label: t('flows.logic_or') },
                    ]}
                  />
                </Field>
              </div>
            ) : null}
            <div className="mt-1.5">
              <Field label={t('flows.field_if_matches')}>
                <TargetSelect
                  def={p.def}
                  value={itemTargetGroup(p.def, p.block.id, itemId)}
                  onPick={(g) => p.onChange(setItemNext(p.def, p.groupId, p.block.id, itemId, g))}
                />
              </Field>
            </div>
          </div>
        )
      })}
      <button
        type="button"
        className={addBtnCls}
        onClick={() =>
          p.onChange(
            addItem(p.def, p.groupId, p.block.id, {
              comparisons: [{ id: genId('cmp'), variableId: '', comparisonOperator: 'Equal', value: '' }],
              logicalOperator: 'AND',
            }),
          )
        }
        data-testid="drawer-add-branch"
      >
        + {t('flows.add_branch')}
      </button>
      <p className="text-[10px] text-muted-foreground">{t('flows.branches_hint')}</p>
      <p className="text-[10px] text-muted-foreground">{t('flows.date_hint')}</p>
    </div>
  )
}

function SetVariableEditor(p: EditorProps) {
  const t = useTranslations()
  const { o } = useOpts(p)
  return (
    <>
      <Field label={t('flows.field_variable')}>
        <VarSelect
          def={p.def}
          value={str(o.variableId)}
          onPick={(varId, def2) => p.onChange(setBlockOptions(def2, p.groupId, p.block.id, { ...o, variableId: varId }))}
          placeholder={t('flows.pick_variable')}
        />
      </Field>
      <Field label={t('flows.field_value')}>
        <VarTextarea
          def={p.def}
          value={str(o.value)}
          onValue={(v) => p.onChange(setBlockOptions(p.def, p.groupId, p.block.id, { ...o, value: v }))}
          rows={2}
          placeholder={t('flows.value_text_placeholder')}
        />
      </Field>
    </>
  )
}

function JumpEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  return (
    <Field label={t('flows.field_jump')}>
      <TargetSelect def={p.def} value={str(o.groupId) || null} onPick={(g) => set({ groupId: g })} placeholder={t('flows.pick_group')} />
    </Field>
  )
}

function CosmoflowLinkEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const [flows, setFlows] = React.useState<FlowSummaryDTO[] | null>(null)
  React.useEffect(() => {
    let alive = true
    api
      .listFlows(p.token, p.accountId)
      .then((fs) => alive && setFlows(fs))
      .catch(() => alive && setFlows([]))
    return () => {
      alive = false
    }
  }, [p.token, p.accountId])
  const linkable = (flows ?? []).filter((f) => f.externalId)
  const current = str(o.cosmoflowId)
  return (
    <>
      <Field label={t('flows.field_subflow')}>
        <CompactSelect
          value={current}
          onValue={(v) => set({ cosmoflowId: v })}
          placeholder={flows === null ? t('common.loading') : t('flows.pick_flow')}
          options={[
            ...linkable.map((f) => ({ value: f.externalId!, label: f.name })),
            ...(current && !linkable.some((f) => f.externalId === current) ? [{ value: current, label: current }] : []),
          ]}
        />
      </Field>
      <p className="text-[10px] text-muted-foreground">{t('flows.subflow_hint')}</p>
    </>
  )
}

function WebhookEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const headers = (o.headers ?? {}) as Record<string, string>
  const entries = Object.entries(headers)
  const writeHeaders = (next: [string, string][]) => set({ headers: Object.fromEntries(next) })
  return (
    <>
      <div className="flex items-start gap-1.5">
        <div className="w-24">
          <Field label={t('flows.field_method')}>
            <CompactSelect
              value={str(o.method) || 'POST'}
              onValue={(v) => set({ method: v })}
              options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))}
            />
          </Field>
        </div>
        <div className="min-w-0 flex-1">
          <Field label="URL">
            <Input className={inputCls} value={str(o.url)} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" />
          </Field>
        </div>
      </div>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{t('flows.headers')}</span>
        <div className="space-y-1">
          {entries.map(([k, v], i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                className={inputCls}
                value={k}
                placeholder={t('flows.header_name')}
                onChange={(e) => writeHeaders(entries.map((kv, j) => (j === i ? [e.target.value, kv[1]] : kv)))}
              />
              <Input
                className={inputCls}
                value={v}
                placeholder={t('flows.header_value')}
                onChange={(e) => writeHeaders(entries.map((kv, j) => (j === i ? [kv[0], e.target.value] : kv)))}
              />
              <button
                type="button"
                className={miniBtnCls}
                aria-label={t('flows.remove_header')}
                title={t('flows.remove_header')}
                onClick={() => writeHeaders(entries.filter((_kv, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={`mt-1 ${addBtnCls}`} onClick={() => writeHeaders([...entries, ['', '']])}>
          + {t('flows.add_header')}
        </button>
      </div>
      <Field label={t('flows.field_body')}>
        <VarTextarea def={p.def} value={str(o.body)} onValue={(v) => set({ body: v })} rows={4} />
      </Field>
      <Field label={t('flows.field_save_response')}>
        <VarSelect
          def={p.def}
          value={str(o.responseVariableId)}
          onPick={(varId, def2) =>
            p.onChange(setBlockOptions(def2, p.groupId, p.block.id, { ...o, responseVariableId: varId }))
          }
          placeholder={t('flows.pick_dont_save')}
        />
      </Field>
      <p className="text-[10px] text-muted-foreground">{t('flows.webhook_hint')}</p>
    </>
  )
}

function CosmodeskEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const [teams, setTeams] = React.useState<TeamDTO[] | null>(null)
  React.useEffect(() => {
    let alive = true
    api
      .listTeams(p.token, p.accountId)
      .then((ts) => alive && setTeams(ts))
      .catch(() => alive && setTeams([]))
    return () => {
      alive = false
    }
  }, [p.token, p.accountId])
  const current = str(o.teamId) || str(o.team)
  return (
    <>
      <Field label={t('flows.field_handoff_message')}>
        <VarTextarea
          def={p.def}
          value={str(o.assigningMessage) || str(o.message)}
          onValue={(v) => set({ assigningMessage: v })}
          rows={2}
          placeholder={t('flows.handoff_placeholder')}
        />
      </Field>
      <Field label={t('flows.field_team')}>
        <CompactSelect
          value={current}
          onValue={(v) => set({ teamId: v })}
          placeholder={teams === null ? t('common.loading') : t('flows.pick_any_team')}
          options={[
            ...(teams ?? []).map((team) => ({ value: team.id, label: team.name })),
            ...(current && !(teams ?? []).some((team) => team.id === current) ? [{ value: current, label: current }] : []),
          ]}
        />
      </Field>
      <p className="text-[10px] text-muted-foreground">{t('flows.handoff_hint')}</p>
    </>
  )
}

function SimpleTextareaEditor(p: EditorProps & { field: string; label: string; rows?: number }) {
  const { o, set } = useOpts(p)
  return (
    <Field label={p.label}>
      <VarTextarea def={p.def} value={str(o[p.field])} onValue={(v) => set({ [p.field]: v })} rows={p.rows ?? 3} />
    </Field>
  )
}

function AbTestEditor(p: EditorProps) {
  const t = useTranslations()
  const items = blockItems(p.block)
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-medium text-muted-foreground">{t('flows.buckets')}</span>
      {items.map((it, idx) => {
        const itemId = str(it.id) || String(idx)
        const weight = Number(it.weight ?? it.percentage ?? 1) || 0
        return (
          <div key={itemId} className="flex items-center gap-1">
            <Input
              type="number"
              min={0}
              className={`${inputCls} w-16`}
              value={weight}
              onChange={(e) => p.onChange(updateItem(p.def, p.groupId, p.block.id, itemId, { weight: Number(e.target.value) }))}
              title={t('flows.weight')}
              aria-label={t('flows.weight')}
            />
            <TargetSelect
              def={p.def}
              value={itemTargetGroup(p.def, p.block.id, itemId)}
              onPick={(g) => p.onChange(setItemNext(p.def, p.groupId, p.block.id, itemId, g))}
            />
            <button
              type="button"
              className={miniBtnCls}
              aria-label={t('flows.remove_bucket')}
              title={t('flows.remove_bucket')}
              onClick={() => p.onChange(removeItem(p.def, p.groupId, p.block.id, itemId))}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button type="button" className={addBtnCls} onClick={() => p.onChange(addItem(p.def, p.groupId, p.block.id, { weight: 1 }))}>
        + {t('flows.add_bucket')}
      </button>
    </div>
  )
}

function WhatsAppTemplateEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const params = (Array.isArray(o.params) ? o.params : []) as unknown[]
  return (
    <>
      <Field label={t('flows.field_template_name')}>
        <Input
          className={inputCls}
          value={str(o.name) || str(o.templateName)}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="order_update"
        />
      </Field>
      <Field label={t('flows.field_language')}>
        <Input className={inputCls} value={str(o.language) || 'pt_BR'} onChange={(e) => set({ language: e.target.value })} />
      </Field>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
          {t('flows.template_params')} ({'{{1}}, {{2}}…'})
        </span>
        <div className="space-y-1">
          {params.map((v, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                className={inputCls}
                value={str(v)}
                placeholder={t('flows.parameter_n', { n: i + 1 })}
                onChange={(e) => set({ params: params.map((x, j) => (j === i ? e.target.value : x)) })}
              />
              <button
                type="button"
                className={miniBtnCls}
                aria-label={t('flows.remove_parameter')}
                title={t('flows.remove_parameter')}
                onClick={() => set({ params: params.filter((_x, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button type="button" className={`mt-1 ${addBtnCls}`} onClick={() => set({ params: [...params, ''] })}>
          + {t('flows.add_parameter')}
        </button>
      </div>
    </>
  )
}

function OpenAiEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  return (
    <>
      <Field label={t('flows.field_system_prompt')}>
        <Textarea
          className={textareaCls}
          rows={3}
          value={str(o.systemPrompt)}
          onChange={(e) => set({ systemPrompt: e.target.value })}
        />
      </Field>
      <Field label={t('flows.field_prompt')}>
        <VarTextarea def={p.def} value={str(o.prompt) || str(o.message)} onValue={(v) => set({ prompt: v })} rows={4} />
      </Field>
      <Field label={t('flows.field_save_response')}>
        <VarSelect
          def={p.def}
          value={str(o.responseVariableId)}
          onPick={(varId, def2) =>
            p.onChange(setBlockOptions(def2, p.groupId, p.block.id, { ...o, responseVariableId: varId }))
          }
          placeholder={t('flows.pick_dont_save')}
        />
      </Field>
    </>
  )
}

/**
 * "AI agent": one of the account's agents takes the conversation with its
 * own persona and knowledge base, answers up to `maxAiTurns` customer
 * messages, then the flow leaves by the block's exit (the "then" target
 * below), or hands straight to a person when no exit is drawn.
 */
function AiAgentEditor(p: EditorProps) {
  const t = useTranslations()
  const { o, set } = useOpts(p)
  const [bots, setBots] = React.useState<AgentBotDTO[] | null>(null)
  const [teams, setTeams] = React.useState<TeamDTO[] | null>(null)
  React.useEffect(() => {
    let alive = true
    api
      .listAgentBots(p.token, p.accountId)
      .then((bs) => alive && setBots(bs))
      .catch(() => alive && setBots([]))
    api
      .listTeams(p.token, p.accountId)
      .then((ts) => alive && setTeams(ts))
      .catch(() => alive && setTeams([]))
    return () => {
      alive = false
    }
  }, [p.token, p.accountId])
  const current = str(o.agentBotId)
  const bot = (bots ?? []).find((b) => b.id === current)
  const maxTurns = typeof o.maxAiTurns === 'number' ? o.maxAiTurns : 3
  const teamId = str(o.teamId)
  return (
    <>
      <Field label={t('flows.field_agent')}>
        <CompactSelect
          value={current}
          onValue={(v) => set({ agentBotId: v })}
          placeholder={bots === null ? t('common.loading') : t('flows.pick_agent')}
          testid="drawer-agent"
          options={[
            ...(bots ?? []).map((b) => ({ value: b.id, label: b.isActive ? b.name : `${b.name} (${t('flows.agent_inactive')})` })),
            ...(current && bots !== null && !bot ? [{ value: current, label: current }] : []),
          ]}
        />
      </Field>
      {bot ? (
        <div className="space-y-1 rounded-md border border-border/60 p-2 text-[11px]" data-testid="drawer-agent-summary">
          <p className="line-clamp-3 text-muted-foreground">{bot.description || bot.systemPrompt}</p>
          <p>
            <span className="font-medium">{t('flows.agent_base')}: </span>
            {bot.knowledgeTags.length > 0
              ? t('flows.agent_base_tags', { tags: bot.knowledgeTags.join(', '), count: bot.knowledgeArticleCount })
              : t('flows.agent_base_all', { count: bot.knowledgeArticleCount })}
          </p>
        </div>
      ) : null}
      <Field label={t('flows.field_max_ai_turns')}>
        <Input
          type="number"
          min={0}
          max={50}
          className={inputCls}
          value={maxTurns}
          onChange={(e) => set({ maxAiTurns: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          data-testid="drawer-max-ai-turns"
        />
      </Field>
      <p className="text-[10px] text-muted-foreground">{t('flows.max_ai_turns_hint')}</p>
      <Field label={t('flows.field_greeting')}>
        <VarTextarea
          def={p.def}
          value={str(o.greeting)}
          onValue={(v) => set({ greeting: v })}
          rows={2}
          placeholder={t('flows.greeting_placeholder')}
        />
      </Field>
      <Field label={t('flows.field_agent_instructions')}>
        <VarTextarea
          def={p.def}
          value={str(o.instructions)}
          onValue={(v) => set({ instructions: v })}
          rows={3}
          placeholder={t('flows.agent_instructions_placeholder')}
        />
      </Field>
      <Field label={t('flows.field_off_topic')}>
        <CompactSelect
          value={o.offTopic === 'handoff' ? 'handoff' : 'refuse'}
          onValue={(v) => set({ offTopic: v })}
          options={[
            { value: 'refuse', label: t('flows.off_topic_refuse') },
            { value: 'handoff', label: t('flows.off_topic_handoff') },
          ]}
        />
      </Field>
      <Field label={t('flows.field_agent_handoff_message')}>
        <VarTextarea
          def={p.def}
          value={str(o.handoffMessage)}
          onValue={(v) => set({ handoffMessage: v })}
          rows={2}
          placeholder={t('flows.handoff_placeholder')}
        />
      </Field>
      <Field label={t('flows.field_team')}>
        <CompactSelect
          value={teamId}
          onValue={(v) => set({ teamId: v })}
          placeholder={teams === null ? t('common.loading') : t('flows.pick_any_team')}
          options={[
            ...(teams ?? []).map((team) => ({ value: team.id, label: team.name })),
            ...(teamId && !(teams ?? []).some((team) => team.id === teamId) ? [{ value: teamId, label: teamId }] : []),
          ]}
        />
      </Field>
      <p className="text-[10px] text-muted-foreground">{t('flows.ai_agent_hint')}</p>
    </>
  )
}

// ─── dispatcher ─────────────────────────────────────────────────────────

// Block types whose own outgoing edge is meaningful and not item-based.
const NO_NEXT_TYPES = new Set(['Condition', 'AB test', 'Jump', 'end-session'])

export function BlockEditor(p: EditorProps) {
  const tr = useTranslations()
  const t = p.block.type
  const body = (() => {
    switch (t) {
      case 'text':
        return <TextEditor {...p} />
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        return <MediaEditor {...p} />
      case 'embed':
        return <UrlEditor {...p} label={tr('flows.field_embed_url')} />
      case 'Redirect':
      case 'Webview':
        return <UrlEditor {...p} label={tr('flows.field_open_url')} />
      case 'text input':
      case 'email input':
      case 'number input':
      case 'phone number input':
      case 'url input':
        return <TypedInputEditor {...p} />
      case 'choice input':
        return <ChoiceEditor {...p} />
      case 'Condition':
        return <ConditionEditor {...p} />
      case 'Set variable':
        return <SetVariableEditor {...p} />
      case 'Jump':
        return <JumpEditor {...p} />
      case 'AB test':
        return <AbTestEditor {...p} />
      case 'Cosmoflow link':
        return <CosmoflowLinkEditor {...p} />
      case 'Webhook':
      case 'webhook':
      case 'api_call':
      case 'API call':
        return <WebhookEditor {...p} />
      case 'Cosmodesk':
      case 'cosmodesk':
        return <CosmodeskEditor {...p} />
      case 'note':
        return <SimpleTextareaEditor {...p} field="content" label={tr('flows.field_note')} />
      case 'end-session':
        return <SimpleTextareaEditor {...p} field="message" label={tr('flows.field_goodbye')} rows={2} />
      case 'OpenAI':
      case 'openai':
        return <OpenAiEditor {...p} />
      case 'AI agent':
        return <AiAgentEditor {...p} />
      case 'Wait':
        return (
          <p className="text-[11px] text-muted-foreground">{tr('flows.wait_hint')}</p>
        )
      default:
        return (
          <p className="text-[11px] text-muted-foreground">
            {tr('flows.no_editor', { type: blockTypeLabel(tr, t) })}
          </p>
        )
    }
  })()

  return (
    <div className="space-y-3">
      {body}
      {!NO_NEXT_TYPES.has(t) ? (
        <Field
          label={
            t === 'choice input'
              ? tr('flows.field_after_retries')
              : t === 'Cosmoflow link'
                ? tr('flows.field_after_subflow')
                : t === 'AI agent'
                  ? tr('flows.field_after_ai_agent')
                  : tr('flows.field_then')
          }
        >
          <TargetSelect
            def={p.def}
            value={blockTargetGroup(p.def, p.block.id)}
            onPick={(g) => p.onChange(setBlockNext(p.def, p.groupId, p.block.id, g))}
            testid="drawer-next"
          />
        </Field>
      ) : null}
    </div>
  )
}

// ─── variables panel ────────────────────────────────────────────────────

export function VariablesPanel({
  def,
  onChange,
  onClose,
}: {
  def: Def
  onChange: (d: Def) => void
  onClose: () => void
}) {
  const t = useTranslations()
  const [name, setName] = React.useState('')
  const vars = variables(def)
  const add = () => {
    const clean = name.trim()
    if (!clean) return
    onChange(addVariable(def, clean))
    setName('')
  }
  return (
    <div
      className="absolute right-3 top-3 z-10 w-64 rounded-lg border border-border bg-card p-3 shadow-lg"
      data-testid="variables-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold">{t('flows.variables')}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-1 text-xs text-muted-foreground hover:bg-muted"
          aria-label={t('flows.close')}
        >
          ✕
        </button>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {vars.length === 0 ? <p className="text-[11px] text-muted-foreground">{t('flows.no_variables')}</p> : null}
        {vars.map((v) => {
          const uses = variableUseCount(def, v.id)
          return (
            <div key={v.id} className="flex items-center gap-1.5 rounded-md border border-border/50 px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{v.name}</span>
              <span className="text-[10px] text-muted-foreground">{t('flows.variable_uses', { count: uses })}</span>
              <button
                type="button"
                className={miniBtnCls}
                title={uses > 0 ? t('flows.variable_in_use') : t('flows.delete_variable')}
                aria-label={t('flows.delete_variable')}
                onClick={() => {
                  if (uses > 0 && !window.confirm(t('flows.variable_delete_confirm', { name: v.name, count: uses }))) return
                  onChange(removeVariable(def, v.id))
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <Input
          className={inputCls}
          value={name}
          placeholder={t('flows.new_variable_placeholder')}
          aria-label={t('flows.new_variable')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          data-testid="variables-new-name"
        />
        <Button type="button" size="sm" variant="outline" onClick={add} className="h-8 px-2 text-[11px]" data-testid="variables-add">
          {t('flows.add')}
        </Button>
      </div>
    </div>
  )
}
