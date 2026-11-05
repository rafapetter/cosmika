// These decide what an operator actually reads. A number rendered as a bare
// integer when it is dollars, or an inbox mode rendered as prose, is how a
// console starts lying quietly.
import { describe, expect, it } from 'vitest'

import {
  columnsOf,
  findStats,
  findTable,
  formatValue,
  humaniseKey,
  humaniseToolName,
  kindOf,
} from './format'

describe('humaniseToolName', () => {
  it('turns a snake_case tool into a sentence', () => {
    expect(humaniseToolName('set_inbox_flow_mode')).toBe('Set inbox flow mode')
  })

  it('keeps acronyms uppercase', () => {
    expect(humaniseToolName('set_inbox_ai_mode')).toBe('Set inbox AI mode')
    expect(humaniseToolName('csat_summary')).toBe('CSAT summary')
  })

  it('handles a single word', () => {
    expect(humaniseToolName('overview')).toBe('Overview')
  })
})

describe('humaniseKey', () => {
  it('splits camelCase', () => {
    expect(humaniseKey('defaultTimezone')).toBe('Default timezone')
  })

  it('uppercases USD rather than titlecasing it', () => {
    expect(humaniseKey('monthlyAiBudgetUsd')).toBe('Monthly AI budget USD')
  })

  it('handles snake_case too', () => {
    expect(humaniseKey('window_days')).toBe('Window days')
  })
})

describe('kindOf', () => {
  it('reads a number as money when the key says so', () => {
    expect(kindOf('monthlyAiBudgetUsd', 15)).toBe('money')
    expect(kindOf('totalCostUsd', 0.08)).toBe('money')
    // The same number elsewhere is just a count.
    expect(kindOf('contacts', 15)).toBe('count')
  })

  it('reads a threshold as a percentage', () => {
    expect(kindOf('autoSafeConfidenceThreshold', 80)).toBe('percent')
  })

  it('recognises product enums', () => {
    expect(kindOf('aiAutoreplyMode', 'AUTO_SAFE')).toBe('enum')
    expect(kindOf('role', 'ADMINISTRATOR')).toBe('enum')
    // An arbitrary uppercase string is not an enum.
    expect(kindOf('name', 'ACME')).toBe('text')
  })

  it('recognises ISO timestamps', () => {
    expect(kindOf('createdAt', '2026-08-07T12:00:00.000Z')).toBe('date')
  })

  it('recognises opaque handles so they render as ids, not prose', () => {
    expect(kindOf('id', 'cmpaccc8dd29d8a9dc08121599')).toBe('id')
  })

  it('treats null, undefined and empty string as empty', () => {
    expect(kindOf('x', null)).toBe('empty')
    expect(kindOf('x', undefined)).toBe('empty')
    expect(kindOf('x', '')).toBe('empty')
  })

  it('reads booleans as booleans even when the key looks numeric', () => {
    expect(kindOf('csatEnabledCount', false)).toBe('boolean')
  })
})

describe('formatValue', () => {
  it('formats money with two decimals and a symbol', () => {
    expect(formatValue('monthlyAiBudgetUsd', 15)).toBe('$15.00')
    expect(formatValue('totalCostUsd', 0.0869)).toBe('$0.09')
  })

  it('groups counts and formats dates through the caller\'s formatters', () => {
    const fmt = {
      number: (n: number) => new Intl.NumberFormat('pt-BR').format(n),
      dateTime: (v: string | number | Date) =>
        new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' }).format(
          new Date(v),
        ),
    }
    expect(formatValue('contacts', 7538, fmt)).toBe('7.538')
    expect(formatValue('createdAt', '2026-09-17T23:30:00.000Z', fmt)).toBe('17/09/2026')
  })

  it('stays neutral without formatters, so no language leaks in', () => {
    expect(formatValue('contacts', 7538)).toBe('7538')
    expect(formatValue('createdAt', '2026-09-17T23:30:00.000Z')).toBe('2026-09-17T23:30:00.000Z')
  })

  it('leaves booleans to the component, which translates them', () => {
    expect(formatValue('csatEnabled', false)).toBe('No')
    expect(formatValue('csatEnabled', true)).toBe('Yes')
  })

  it('renders an empty value as a dash rather than "null"', () => {
    expect(formatValue('agentBot', null)).toBe('-')
  })

  it('joins arrays and dashes an empty one', () => {
    expect(formatValue('tags', ['ajuda', 'bot'])).toBe('ajuda, bot')
    expect(formatValue('tags', [])).toBe('-')
  })

  it('falls back to the raw string for an unparseable date', () => {
    expect(formatValue('createdAt', '2026-13-45T99:99')).toBe('2026-13-45T99:99')
  })

  it('serialises a nested object rather than printing [object Object]', () => {
    expect(formatValue('agentBot', { id: 'b1' })).toBe('{"id":"b1"}')
  })
})

describe('findTable', () => {
  it('finds the array of rows in a tool result', () => {
    const out = { count: 2, inboxes: [{ name: 'A' }, { name: 'B' }] }
    expect(findTable(out)).toEqual({ key: 'inboxes', rows: [{ name: 'A' }, { name: 'B' }] })
  })

  it('prefers the longest array when there are several', () => {
    const out = { a: [{ x: 1 }], b: [{ y: 1 }, { y: 2 }] }
    expect(findTable(out)?.key).toBe('b')
  })

  it('ignores arrays of primitives', () => {
    expect(findTable({ tags: ['a', 'b'] })).toBeNull()
  })

  it('ignores an empty array', () => {
    expect(findTable({ rows: [] })).toBeNull()
  })

  it('returns null for a scalar-only result', () => {
    expect(findTable({ monthToDateUsd: 0.08 })).toBeNull()
  })

  it('tolerates null and non-objects', () => {
    expect(findTable(null)).toBeNull()
    expect(findTable([1, 2])).toBeNull()
    expect(findTable('x')).toBeNull()
  })
})

describe('findStats', () => {
  it('collects top-level scalars', () => {
    expect(findStats({ sent: 3, responded: 2 })).toEqual([
      { key: 'sent', value: 3 },
      { key: 'responded', value: 2 },
    ])
  })

  it('flattens one level so `counts` becomes tiles', () => {
    const stats = findStats({ name: 'X', counts: { members: 3, inboxes: 6 } })
    expect(stats).toEqual([
      { key: 'name', value: 'X' },
      { key: 'members', value: 3 },
      { key: 'inboxes', value: 6 },
    ])
  })

  it('leaves arrays to the table renderer', () => {
    expect(findStats({ inboxes: [{ a: 1 }] })).toEqual([])
  })

  it('never surfaces an error as a stat tile', () => {
    // Errors get their own treatment; a tile labelled "Error" reads as data.
    expect(findStats({ error: 'no such inbox' })).toEqual([])
  })

  it('keeps an explicit null as a stat so "not set" stays visible', () => {
    expect(findStats({ averageRating: null })).toEqual([{ key: 'averageRating', value: null }])
  })
})

describe('columnsOf', () => {
  it('puts the human-readable column first and ids last', () => {
    const rows = [{ id: 'c1', name: 'Suporte', status: 'OPEN' }]
    expect(columnsOf(rows)).toEqual(['name', 'status', 'id'])
  })

  it('unions keys across rows so a sparse row does not hide a column', () => {
    const rows = [{ name: 'a' }, { name: 'b', extra: 1 }]
    expect(columnsOf(rows)).toContain('extra')
  })

  it('caps the column count to keep the table legible', () => {
    const wide = [Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))]
    expect(columnsOf(wide)).toHaveLength(6)
  })
})
