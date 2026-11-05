/**
 * Turning raw tool output into something an operator reads at a glance.
 *
 * Kept separate from the components so the judgement calls here — what counts
 * as money, what a boolean should read as, which key is a row's identity —
 * are testable on their own.
 */

/** `set_inbox_ai_mode` → `Set inbox AI mode`. Acronyms stay uppercase. */
const ACRONYMS = new Set(['ai', 'csat', 'id', 'ids', 'url', 'api', 'sla', 'nps'])

export function humaniseToolName(name: string): string {
  const words = name.split('_')
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w)) return w.toUpperCase()
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
    })
    .join(' ')
}

/** `monthlyAiBudgetUsd` → `Monthly AI budget usd` is wrong; aim for readable. */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
  const words = spaced.split(/\s+/)
  return words
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      if (lower === 'usd') return 'USD'
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : lower
    })
    .join(' ')
}

export type ValueKind =
  | 'money'
  | 'percent'
  | 'count'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'id'
  | 'text'
  | 'empty'

const ENUMS = new Set([
  'DRAFT', 'AUTO_SAFE', 'AUTO_FULL', 'GUIDED', 'STRICT', 'OFF',
  'OPEN', 'PENDING', 'RESOLVED', 'CLOSED',
  'ADMINISTRATOR', 'SUPERVISOR', 'AGENT', 'BOT',
  'PUBLISHED', 'ARCHIVED', 'ACTIVE', 'SUSPENDED', 'TERMINATED',
  'LOW', 'NORMAL', 'HIGH', 'URGENT',
  'WHATSAPP', 'API', 'WEB_WIDGET', 'EMAIL', 'INSTAGRAM', 'TELEGRAM',
])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * Classify a value by key AND content. The key carries the intent (`...Usd` is
 * money, not just a number) which the value alone cannot tell you.
 */
export function kindOf(key: string, value: unknown): ValueKind {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'boolean') return 'boolean'
  const k = key.toLowerCase()
  if (typeof value === 'number') {
    if (k.includes('usd') || k.includes('cost') || k.includes('spend') || k.includes('budget')) {
      return 'money'
    }
    if (k.includes('threshold') || k.includes('percent') || k.endsWith('pct')) return 'percent'
    return 'count'
  }
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return 'date'
    if (ENUMS.has(value)) return 'enum'
    // Cuid-ish opaque handles: long, no spaces. Worth monospacing so they can
    // be compared by eye, and never worth reading as prose.
    if (/^c[a-z0-9]{16,}$/i.test(value) || (k === 'id' && !value.includes(' '))) return 'id'
    return 'text'
  }
  return 'text'
}

/** Locale- and zone-aware formatting the caller passes in; see format-datetime. */
export type ValueFormatters = {
  number: (value: number) => string
  dateTime: (value: string | number | Date) => string
}

export function formatValue(
  key: string,
  value: unknown,
  fmt?: ValueFormatters,
): string {
  const kind = kindOf(key, value)
  switch (kind) {
    case 'empty':
      return '-'
    case 'boolean':
      return value ? 'Yes' : 'No'
    case 'money':
      return `$${Number(value).toFixed(2)}`
    case 'percent':
      return `${Number(value)}%`
    case 'count':
      return fmt ? fmt.number(Number(value)) : String(Number(value))
    case 'date': {
      const d = new Date(String(value))
      if (Number.isNaN(d.getTime())) return String(value)
      return fmt ? fmt.dateTime(d) : d.toISOString()
    }
    default:
      if (Array.isArray(value)) return value.length === 0 ? '-' : value.join(', ')
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
  }
}

/**
 * The one array of objects worth turning into a table.
 *
 * A tool result is a record with one interesting key (`inboxes`, `members`,
 * `flows`) plus scalars. Picking the longest array of objects finds it without
 * hardcoding a list of tool names, so a tool added later renders for free.
 */
export function findTable(
  output: unknown,
): { key: string; rows: Array<Record<string, unknown>> } | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  let best: { key: string; rows: Array<Record<string, unknown>> } | null = null
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) continue
    const objects = value.filter(
      (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    ) as Array<Record<string, unknown>>
    if (objects.length !== value.length) continue
    if (!best || objects.length > best.rows.length) best = { key, rows: objects }
  }
  return best
}

/** Scalars worth showing as headline tiles, flattened one level. */
export function findStats(output: unknown): Array<{ key: string; value: unknown }> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return []
  const stats: Array<{ key: string; value: unknown }> = []
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      if (key === 'error') continue
      stats.push({ key, value })
      continue
    }
    if (Array.isArray(value)) continue
    // One level in: `counts: { members, inboxes }` is the shape that matters.
    for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
      if (v2 === null || typeof v2 !== 'object') stats.push({ key: k2, value: v2 })
    }
  }
  return stats
}

/** Columns worth showing, in a stable order, capped so a table stays readable. */
export function columnsOf(rows: Array<Record<string, unknown>>, max = 6): string[] {
  const seen: string[] = []
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.includes(k)) seen.push(k)
    }
  }
  // An opaque id is never the most useful column; push it to the end and let
  // the cap drop it before it displaces something legible.
  const ranked = [...seen].sort((a, b) => score(a) - score(b))
  return ranked.slice(0, max)
}

function score(key: string): number {
  const k = key.toLowerCase()
  if (k === 'name' || k === 'title' || k === 'email') return 0
  if (k === 'id' || k.endsWith('id')) return 3
  return 1
}
