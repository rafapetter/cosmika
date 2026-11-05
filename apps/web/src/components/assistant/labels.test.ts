// The evidence panel is only evidence if the operator can read it.
import { describe, expect, it } from 'vitest'

import { keyLabel, keyToken, toolLabel, valueLabel } from './labels'

const t = ((k: string) => k) as never

describe('keyToken', () => {
  it('normalizes camelCase, spaces and dashes to snake_case', () => {
    expect(keyToken('createdAt')).toBe('created_at')
    expect(keyToken('monthlyAiBudgetUsd')).toBe('monthly_ai_budget_usd')
    expect(keyToken('channel-type')).toBe('channel_type')
    expect(keyToken('Inbox Name')).toBe('inbox_name')
  })
})

describe('toolLabel', () => {
  it('names a known tool through the translator', () => {
    expect(toolLabel(t, 'set_inbox_ai_mode')).toBe('assistantTools.set_inbox_ai_mode')
  })

  it('falls back to the prettified identifier for a tool added later', () => {
    expect(toolLabel(t, 'do_something_new')).toBe('Do something new')
  })
})

describe('keyLabel', () => {
  it('translates known columns, in either spelling', () => {
    expect(keyLabel(t, 'createdAt')).toBe('assistantKeys.created_at')
    expect(keyLabel(t, 'created_at')).toBe('assistantKeys.created_at')
  })

  it('falls back to the prettified key for an unknown column', () => {
    expect(keyLabel(t, 'weirdCustomField')).toBe('Weird custom field')
  })
})

describe('valueLabel', () => {
  it('translates enum values the API returns', () => {
    expect(valueLabel(t, 'AUTO_SAFE')).toBe('assistantValues.auto_safe')
    expect(valueLabel(t, 'ADMINISTRATOR')).toBe('assistantValues.administrator')
  })

  it('leaves an unknown value alone', () => {
    expect(valueLabel(t, 'SOMETHING_ELSE')).toBe('SOMETHING_ELSE')
  })
})
