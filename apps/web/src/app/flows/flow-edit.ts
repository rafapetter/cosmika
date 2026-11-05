// Pure, framework-free helpers for editing a flow definition. The builder UI
// renders these results; keeping the logic here makes it unit-testable and the
// page a thin shell. Definitions are Typebot-shaped (groups / edges / variables
// / startGroupId) — the same shape the FlowEngine runs.

import type { FlowDefinition } from '@cosmika/shared'

export type Def = FlowDefinition
type Block = { id: string; type: string; outgoingEdgeId?: string | null } & Record<string, unknown>
type Group = { id: string; title?: string; blocks: Block[] }

let counter = 0
export function genId(prefix: string): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter}${rand}`
}

/**
 * Words this module writes into a definition or shows in a summary. The UI
 * passes the viewer's language (see `_flow-text.ts`); the English defaults
 * keep the helpers usable, and testable, without a translator.
 */
export type FlowText = {
  startGroup: string
  starterMessage: string
  newMessage: string
  group: (n: number) => string
  groupFallback: string
  copyOf: (title: string) => string
  emptyText: string
  emptyMedia: (type: string) => string
  ask: (variable: string) => string
  aVariable: string
  branchOnCondition: string
  setVariable: (variable: string) => string
  jumpTo: (group: string) => string
  aGroup: string
  runSubflow: (flow: string) => string
  branch: (n: number) => string
  bucket: (n: number, weight: number) => string
  option: (n: number) => string
  typeLabel: (type: string) => string
}

export const DEFAULT_FLOW_TEXT: FlowText = {
  startGroup: 'Start',
  starterMessage: 'Hello! How can I help?',
  newMessage: 'New message',
  group: (n) => `Group ${n}`,
  groupFallback: 'Group',
  copyOf: (title) => `${title} (copy)`,
  emptyText: '(empty text)',
  emptyMedia: (type) => `(${type})`,
  ask: (v) => `ask → ${v}`,
  aVariable: 'variable',
  branchOnCondition: 'branch on a condition',
  setVariable: (v) => `set ${v}`,
  jumpTo: (g) => `jump to ${g}`,
  aGroup: 'a group',
  runSubflow: (f) => `run sub-flow ${f}`,
  branch: (n) => `Branch ${n}`,
  bucket: (n, w) => `Bucket ${n} · weight ${w}`,
  option: (n) => `Option ${n}`,
  typeLabel: (type) => type,
}

// Block types offered in the "add block" menu — the common, friendly-to-author
// ones grouped Typebot-style. Every other Cosmo-Flows type is still editable
// via the raw-options box. `key` names the category for the translator.
export const BLOCK_TYPE_GROUPS: {
  key: 'bubbles' | 'inputs' | 'logic' | 'integrations'
  kind: ReturnType<typeof blockKind>
  types: string[]
}[] = [
  { key: 'bubbles', kind: 'bubble', types: ['text', 'image', 'video', 'audio', 'file'] },
  {
    key: 'inputs',
    kind: 'input',
    types: ['text input', 'email input', 'number input', 'phone number input', 'choice input'],
  },
  {
    key: 'logic',
    kind: 'logic',
    types: ['Condition', 'Set variable', 'Jump', 'AB test', 'Cosmoflow link', 'Redirect', 'note', 'end-session'],
  },
  {
    key: 'integrations',
    kind: 'integration',
    types: ['AI agent', 'Webhook', 'OpenAI', 'WhatsApp Template', 'Cosmodesk'],
  },
]
export const BLOCK_TYPES = BLOCK_TYPE_GROUPS.flatMap((g) => g.types)

export function starterDefinition(text: FlowText = DEFAULT_FLOW_TEXT): Def {
  const g = genId('grp')
  return {
    groups: [
      {
        id: g,
        title: text.startGroup,
        blocks: [{ id: genId('blk'), type: 'text', options: { content: text.starterMessage } }],
      },
    ],
    edges: [],
    variables: [],
    startGroupId: g,
  } as Def
}

function clone(def: Def): Def {
  return JSON.parse(JSON.stringify(def)) as Def
}
function groups(def: Def): Group[] {
  return (def as { groups: Group[] }).groups
}

/** One-line human summary of a block for the outline. */
export function describeBlock(block: Block, text: FlowText = DEFAULT_FLOW_TEXT): string {
  const o = (block.options ?? {}) as Record<string, unknown>
  const type = block.type
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (type) {
    case 'text':
      return str(o.content) || text.emptyText
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return str(o.url) || text.emptyMedia(text.typeLabel(type))
    case 'text input':
    case 'email input':
    case 'number input':
    case 'phone number input':
    case 'choice input':
      return text.ask(str(o.variableId) || str((o.variable as { name?: string })?.name) || text.aVariable)
    case 'Condition':
      return text.branchOnCondition
    case 'Set variable':
      return text.setVariable(str(o.variableId) || text.aVariable)
    case 'Jump':
      return text.jumpTo(str(o.groupId) || text.aGroup)
    case 'Cosmoflow link':
      return text.runSubflow(str(o.cosmoflowId) || '?')
    default:
      return text.typeLabel(type)
  }
}

export function addGroup(def: Def, text: FlowText = DEFAULT_FLOW_TEXT): Def {
  const next = clone(def)
  groups(next).push({ id: genId('grp'), title: text.group(groups(next).length + 1), blocks: [] })
  return next
}

export function deleteGroup(def: Def, groupId: string): Def {
  const next = clone(def)
  const gs = groups(next)
  const idx = gs.findIndex((g) => g.id === groupId)
  if (idx === -1) return def
  gs.splice(idx, 1)
  // drop edges touching the removed group + clear startGroupId if it pointed here
  ;(next as { edges: { to: { groupId: string }; from: { groupId?: string } }[] }).edges =
    (next as { edges: { to: { groupId: string }; from: { groupId?: string } }[] }).edges.filter(
      (e) => e.to.groupId !== groupId && e.from.groupId !== groupId,
    )
  const d = next as { startGroupId?: string }
  if (d.startGroupId === groupId) d.startGroupId = gs[0]?.id
  return next
}

export function renameGroup(def: Def, groupId: string, title: string): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  if (!g) return def
  g.title = title
  return next
}

export function setStartGroup(def: Def, groupId: string): Def {
  const next = clone(def)
  ;(next as { startGroupId?: string }).startGroupId = groupId
  return next
}

function newBlock(type: string, text: FlowText): Block {
  const base: Block = { id: genId('blk'), type, options: {} }
  if (type === 'text') (base.options as Record<string, unknown>).content = text.newMessage
  // The engine's defaults, written out so the drawer shows what will run.
  if (type === 'AI agent') Object.assign(base.options as Record<string, unknown>, { maxAiTurns: 3, offTopic: 'refuse' })
  return base
}

export function addBlock(def: Def, groupId: string, type: string, text: FlowText = DEFAULT_FLOW_TEXT): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  if (!g) return def
  g.blocks.push(newBlock(type, text))
  return next
}

export function deleteBlock(def: Def, groupId: string, blockId: string): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  if (!g) return def
  g.blocks = g.blocks.filter((b) => b.id !== blockId)
  return next
}

export function moveBlock(def: Def, groupId: string, blockId: string, dir: -1 | 1): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  if (!g) return def
  const i = g.blocks.findIndex((b) => b.id === blockId)
  const j = i + dir
  if (i === -1 || j < 0 || j >= g.blocks.length) return def
  ;[g.blocks[i], g.blocks[j]] = [g.blocks[j]!, g.blocks[i]!]
  return next
}

/** Update a single block's options object (the raw escape hatch + text edits). */
export function setBlockOptions(def: Def, groupId: string, blockId: string, options: Record<string, unknown>): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  const b = g?.blocks.find((x) => x.id === blockId)
  if (!b) return def
  b.options = options
  return next
}

// ─── canvas helpers ─────────────────────────────────────────────────────

export type XY = { x: number; y: number }

/**
 * A group's canvas position: its Typebot `graphCoordinates` when present
 * (migrated flows keep their Nebula layout), else a deterministic grid
 * fallback from its index so hand-made flows still render sensibly.
 */
export function groupPosition(def: Def, groupId: string): XY {
  const gs = groups(def)
  const idx = gs.findIndex((g) => g.id === groupId)
  const g = gs[idx] as (Group & { graphCoordinates?: XY }) | undefined
  const c = g?.graphCoordinates
  if (c && typeof c.x === 'number' && typeof c.y === 'number') return { x: c.x, y: c.y }
  const i = Math.max(idx, 0)
  return { x: (i % 4) * 340, y: Math.floor(i / 4) * 260 }
}

export function setGroupPosition(def: Def, groupId: string, x: number, y: number): Def {
  const next = clone(def)
  const g = groups(next).find((v) => v.id === groupId) as (Group & { graphCoordinates?: XY }) | undefined
  if (!g) return def
  g.graphCoordinates = { x, y }
  return next
}

export function addGroupAt(def: Def, x: number, y: number, text: FlowText = DEFAULT_FLOW_TEXT): Def {
  const next = clone(def)
  groups(next).push({
    id: genId('grp'),
    title: text.group(groups(next).length + 1),
    blocks: [],
    graphCoordinates: { x, y },
  } as Group)
  return next
}

export type CanvasEdge = {
  id: string
  source: string
  target: string
  sourceHandle?: string
  label?: string
}

// A block's selectable items (choice buttons, condition rules, A/B buckets),
// read from either `options.items` or the legacy top-level `items`.
export function blockItems(block: Block): ({ id?: string } & Record<string, unknown>)[] {
  const opts = (block.options ?? {}) as Record<string, unknown>
  const list = Array.isArray(opts.items) ? opts.items : Array.isArray(block.items) ? block.items : []
  return list as ({ id?: string } & Record<string, unknown>)[]
}

// Handle id encoders — each block gets a source handle, each item its own.
export function blockHandle(blockId: string): string {
  return `blk:${blockId}`
}
export function itemHandle(blockId: string, itemId: string): string {
  return `item:${blockId}:${itemId}`
}
/** Decode a source-handle id back into what it anchors. */
export function decodeHandle(
  handle: string | null | undefined,
): { kind: 'block'; blockId: string } | { kind: 'item'; blockId: string; itemId: string } | { kind: 'group' } {
  if (handle?.startsWith('item:')) {
    const [, blockId, itemId] = handle.split(':')
    return { kind: 'item', blockId: blockId ?? '', itemId: itemId ?? '' }
  }
  if (handle?.startsWith('blk:')) return { kind: 'block', blockId: handle.slice(4) }
  return { kind: 'group' }
}

/** "variable = value" summary of a condition comparison, for edge labels. */
function comparisonSummary(c: Record<string, unknown> | undefined): string {
  if (!c) return ''
  const v = typeof c.variableId === 'string' ? c.variableId : ''
  const op = typeof c.comparisonOperator === 'string' ? c.comparisonOperator : '='
  // Dates are stored datetime-local style ("2026-10-20T18:00"); read them
  // with a space. A between rule shows both ends.
  const show = (x: unknown) => (typeof x === 'string' ? x.replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ') : '')
  const val = [show(c.value), show(c.valueTo)].filter(Boolean).join(' – ')
  if (!v && !val) return ''
  return [v, op.toLowerCase(), val].filter(Boolean).join(' ')
}

/** Edge ids referenced by an item's `outgoingEdgeId`, per block (or across the flow). */
function itemEdgeAnchors(def: Def): Map<string, { blockId: string; itemId: string; groupId: string }> {
  const anchors = new Map<string, { blockId: string; itemId: string; groupId: string }>()
  for (const g of groups(def)) {
    for (const b of g.blocks) {
      for (const item of blockItems(b)) {
        if (item && typeof item.id === 'string' && typeof item.outgoingEdgeId === 'string') {
          anchors.set(item.outgoingEdgeId, { blockId: b.id, itemId: item.id, groupId: g.id })
        }
      }
    }
  }
  return anchors
}

/**
 * Derive drawable edges anchored to the exact source handle. Migrated Typebot
 * edges hang off a block (`from.blockId`) or a choice/condition/A-B item —
 * where the item link is stored EITHER on the edge (`from.itemId`) or only on
 * the item (`item.outgoingEdgeId`, the common V1-import shape). Resolve each
 * to its owning group and the handle it leaves.
 */
export function canvasEdges(def: Def): CanvasEdge[] {
  const blockGroup = new Map<string, string>() // blockId -> groupId
  const itemBlock = new Map<string, string>() // itemId -> blockId
  const itemGroup = new Map<string, string>() // itemId -> groupId
  const itemLabel = new Map<string, string>() // itemId -> short label for the edge
  for (const g of groups(def)) {
    for (const b of g.blocks) {
      blockGroup.set(b.id, g.id)
      for (const item of blockItems(b)) {
        if (item && typeof item.id === 'string') {
          itemBlock.set(item.id, b.id)
          itemGroup.set(item.id, g.id)
          const raw =
            typeof item.content === 'string' && item.content
              ? item.content
              : comparisonSummary(itemComparisons(item)[0])
          if (raw) itemLabel.set(item.id, raw.length > 18 ? `${raw.slice(0, 17)}…` : raw)
        }
      }
    }
  }
  const anchors = itemEdgeAnchors(def)
  const out: CanvasEdge[] = []
  const edges = (def as { edges: { id: string; from?: { groupId?: string; blockId?: string; itemId?: string }; to: { groupId: string } }[] }).edges
  for (const e of edges) {
    const from = e.from ?? {}
    if (from.itemId) {
      const src = itemGroup.get(from.itemId)
      const blk = from.blockId ?? itemBlock.get(from.itemId)
      if (src && blk) {
        out.push({
          id: e.id,
          source: src,
          target: e.to.groupId,
          sourceHandle: itemHandle(blk, from.itemId),
          label: itemLabel.get(from.itemId),
        })
      }
      continue
    }
    const anchor = anchors.get(e.id)
    if (anchor) {
      out.push({
        id: e.id,
        source: anchor.groupId,
        target: e.to.groupId,
        sourceHandle: itemHandle(anchor.blockId, anchor.itemId),
        label: itemLabel.get(anchor.itemId),
      })
      continue
    }
    if (from.blockId) {
      const src = blockGroup.get(from.blockId)
      if (src) out.push({ id: e.id, source: src, target: e.to.groupId, sourceHandle: blockHandle(from.blockId) })
      continue
    }
    if (from.groupId) out.push({ id: e.id, source: from.groupId, target: e.to.groupId })
  }
  return out
}

/** Set/replace a block's own "next → group" edge (from.blockId). '' clears. */
export function setBlockNext(def: Def, groupId: string, blockId: string, targetGroupId: string): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  const b = g?.blocks.find((x) => x.id === blockId)
  if (!b) return def
  const edges = (next as { edges: { id: string; from: Record<string, unknown>; to: { groupId: string } }[] }).edges
  // Replace the block's own edge whether it's referenced (outgoingEdgeId) or
  // only anchored on the edge (migrated `from.blockId`, no itemId) — but never
  // touch edges an item owns via its outgoingEdgeId.
  const itemOwned = itemEdgeAnchors(next)
  const filtered = edges.filter((e) => {
    if (itemOwned.has(e.id)) return true
    if (e.id === b.outgoingEdgeId) return false
    const from = e.from as { blockId?: string; itemId?: string } | undefined
    return !(from?.blockId === blockId && !from?.itemId)
  })
  if (!targetGroupId) {
    ;(next as { edges: unknown[] }).edges = filtered
    delete b.outgoingEdgeId
    return next
  }
  const edgeId = genId('edge')
  filtered.push({ id: edgeId, from: { blockId }, to: { groupId: targetGroupId } })
  ;(next as { edges: unknown[] }).edges = filtered
  b.outgoingEdgeId = edgeId
  return next
}

/** Set/replace a choice/condition/A-B item's branch edge (from.itemId). '' clears. */
export function setItemNext(
  def: Def,
  groupId: string,
  blockId: string,
  itemId: string,
  targetGroupId: string,
): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  const b = g?.blocks.find((x) => x.id === blockId)
  if (!b) return def
  const item = blockItems(b).find((it) => it.id === itemId) as (Record<string, unknown> & { outgoingEdgeId?: string }) | undefined
  if (!item) return def
  const edges = (
    next as { edges: { id: string; from: { blockId?: string; itemId?: string }; to: { groupId: string } }[] }
  ).edges
  const filtered = edges.filter((e) => e.from?.itemId !== itemId && e.id !== item.outgoingEdgeId)
  if (!targetGroupId) {
    ;(next as { edges: unknown[] }).edges = filtered
    delete item.outgoingEdgeId
    return next
  }
  const edgeId = genId('edge')
  filtered.push({ id: edgeId, from: { blockId, itemId }, to: { groupId: targetGroupId } })
  ;(next as { edges: unknown[] }).edges = filtered
  item.outgoingEdgeId = edgeId
  return next
}

/** Remove an edge and null out every block/item reference to it. */
export function removeEdge(def: Def, edgeId: string): Def {
  const next = clone(def)
  const d = next as { edges: { id: string }[] }
  const before = d.edges.length
  d.edges = d.edges.filter((e) => e.id !== edgeId)
  if (d.edges.length === before) return def
  for (const g of groups(next)) {
    for (const b of g.blocks) {
      if (b.outgoingEdgeId === edgeId) delete b.outgoingEdgeId
      const opts = (b.options ?? {}) as Record<string, unknown>
      for (const item of [
        ...(Array.isArray(opts.items) ? (opts.items as { outgoingEdgeId?: string }[]) : []),
        ...(Array.isArray(b.items) ? (b.items as { outgoingEdgeId?: string }[]) : []),
      ]) {
        if (item && item.outgoingEdgeId === edgeId) delete item.outgoingEdgeId
      }
    }
  }
  return next
}

/** Visual family of a block type — drives chip colors on the canvas. */
export function blockKind(type: string): 'bubble' | 'input' | 'logic' | 'integration' {
  const t = type.toLowerCase()
  if (['text', 'image', 'video', 'audio', 'file', 'embed', 'cards'].includes(t)) return 'bubble'
  if (t.endsWith('input')) return 'input'
  if (['condition', 'jump', 'set variable', 'ab test', 'wait', 'redirect', 'webview', 'cosmoflow link', 'code', 'script', 'end-session', 'note'].includes(t)) {
    return 'logic'
  }
  return 'integration'
}

/** Read the group's outgoing "next" target (the last block's edge → group). */
export function groupNextTarget(def: Def, groupId: string): string | null {
  const g = groups(def).find((x) => x.id === groupId)
  const last = g?.blocks[g.blocks.length - 1]
  if (!last || !last.outgoingEdgeId) return null
  const edge = (def as { edges: { id: string; to: { groupId: string } }[] }).edges.find(
    (e) => e.id === last.outgoingEdgeId,
  )
  return edge ? edge.to.groupId : null
}

/**
 * Set (or clear) the linear "on completion → group" edge for a group, attached
 * to its last block's outgoingEdgeId. Passing '' clears it.
 */
export function setGroupNext(def: Def, groupId: string, targetGroupId: string): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  const last = g?.blocks[g.blocks.length - 1]
  if (!g || !last) return def
  const edges = (next as { edges: { id: string; from: { groupId: string; blockId: string }; to: { groupId: string } }[] }).edges
  // remove any existing edge owned by this block
  const filtered = edges.filter((e) => e.id !== last.outgoingEdgeId)
  if (!targetGroupId) {
    ;(next as { edges: unknown[] }).edges = filtered
    delete last.outgoingEdgeId
    return next
  }
  const edgeId = genId('edge')
  filtered.push({ id: edgeId, from: { groupId, blockId: last.id }, to: { groupId: targetGroupId } })
  ;(next as { edges: unknown[] }).edges = filtered
  last.outgoingEdgeId = edgeId
  return next
}

// ─── variables ──────────────────────────────────────────────────────────

export type Variable = { id: string; name: string } & Record<string, unknown>

export function variables(def: Def): Variable[] {
  const list = (def as { variables?: Variable[] }).variables
  return Array.isArray(list) ? list : []
}

/**
 * Add a variable. Ids equal names (the migration convention — `{{name}}`
 * interpolation and `variableId` captures resolve against the same key).
 * No-op on blank or duplicate names.
 */
export function addVariable(def: Def, name: string): Def {
  const clean = name.trim()
  if (!clean) return def
  if (variables(def).some((v) => v.id === clean || v.name === clean)) return def
  const next = clone(def)
  ;(next as { variables: Variable[] }).variables = [...variables(next), { id: clean, name: clean }]
  return next
}

export function removeVariable(def: Def, id: string): Def {
  if (!variables(def).some((v) => v.id === id)) return def
  const next = clone(def)
  ;(next as { variables: Variable[] }).variables = variables(next).filter((v) => v.id !== id)
  return next
}

/** How many places reference the variable (captures, {{tokens}}, comparisons). */
export function variableUseCount(def: Def, id: string): number {
  const json = JSON.stringify((def as { groups: unknown }).groups)
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokens = json.match(new RegExp(`\\{\\{\\s*${escaped}(\\s*\\||\\s*\\}\\})`, 'g'))?.length ?? 0
  const captures = json.match(new RegExp(`"variableId":"${escaped}"`, 'g'))?.length ?? 0
  return tokens + captures
}

// ─── item CRUD (choice buttons / condition branches / A-B buckets) ──────

/** Write a block's items, normalizing to options.items (what the engine reads). */
function writeItems(b: Block, items: unknown[]): void {
  b.options = { ...((b.options ?? {}) as Record<string, unknown>), items }
  delete b.items // legacy top-level copy would shadow the edit
}

function findBlock(def: Def, groupId: string, blockId: string): Block | undefined {
  return groups(def)
    .find((g) => g.id === groupId)
    ?.blocks.find((b) => b.id === blockId)
}

export function addItem(def: Def, groupId: string, blockId: string, seed: Record<string, unknown> = {}): Def {
  const next = clone(def)
  const b = findBlock(next, groupId, blockId)
  if (!b) return def
  writeItems(b, [...blockItems(b), { id: genId('item'), ...seed }])
  return next
}

/** Shallow-merge a patch into one item (label edits, comparisons, weights…). */
export function updateItem(
  def: Def,
  groupId: string,
  blockId: string,
  itemId: string,
  patch: Record<string, unknown>,
): Def {
  const next = clone(def)
  const b = findBlock(next, groupId, blockId)
  if (!b) return def
  const items = blockItems(b)
  const idx = items.findIndex((it) => it.id === itemId)
  if (idx === -1) return def
  items[idx] = { ...items[idx], ...patch }
  writeItems(b, items)
  return next
}

/** Remove an item and any edges anchored to it. */
export function removeItem(def: Def, groupId: string, blockId: string, itemId: string): Def {
  const next = clone(def)
  const b = findBlock(next, groupId, blockId)
  if (!b) return def
  const items = blockItems(b)
  const item = items.find((it) => it.id === itemId) as { outgoingEdgeId?: string } | undefined
  if (!item) return def
  writeItems(b, items.filter((it) => it.id !== itemId))
  const d = next as { edges: { id: string; from?: { itemId?: string } }[] }
  d.edges = d.edges.filter((e) => e.from?.itemId !== itemId && e.id !== item.outgoingEdgeId)
  return next
}

// ─── current targets (dropdown display) ─────────────────────────────────

type AnyEdge = { id: string; from?: { blockId?: string; itemId?: string }; to: { groupId: string } }

/** The group an item's branch currently points at, or null. */
export function itemTargetGroup(def: Def, blockId: string, itemId: string): string | null {
  for (const g of groups(def)) {
    const b = g.blocks.find((x) => x.id === blockId)
    if (!b) continue
    const item = blockItems(b).find((it) => it.id === itemId) as { outgoingEdgeId?: string } | undefined
    if (!item) return null
    const edges = (def as { edges: AnyEdge[] }).edges
    const e =
      edges.find((x) => x.id === item.outgoingEdgeId) ??
      edges.find((x) => x.from?.itemId === itemId)
    return e ? e.to.groupId : null
  }
  return null
}

/** The group a block's own outgoing edge points at, or null (item-owned edges excluded). */
export function blockTargetGroup(def: Def, blockId: string): string | null {
  for (const g of groups(def)) {
    const b = g.blocks.find((x) => x.id === blockId)
    if (!b) continue
    const itemOwned = itemEdgeAnchors(def)
    const edges = (def as { edges: AnyEdge[] }).edges
    const e =
      edges.find((x) => x.id === b.outgoingEdgeId && !itemOwned.has(x.id)) ??
      edges.find((x) => x.from?.blockId === blockId && !x.from?.itemId && !itemOwned.has(x.id))
    return e ? e.to.groupId : null
  }
  return null
}

/** `{id, title}` pairs for Jump/target dropdowns, untitled groups numbered. */
export function groupChoices(def: Def, text: FlowText = DEFAULT_FLOW_TEXT): { id: string; title: string }[] {
  return groups(def).map((g, i) => ({ id: g.id, title: g.title || text.group(i + 1) }))
}

// ─── condition item shapes ──────────────────────────────────────────────
// Migrated Typebot condition items nest their rules under `item.content`
// ({comparisons, logicalOperator}); builder-authored ones keep them flat on
// the item. Read both; the editor writes back flat (and drops the nested
// copy) so edited items converge on the shape the engine reads first.

export function itemComparisons(item: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(item.comparisons)) return item.comparisons as Record<string, unknown>[]
  const content = item.content
  if (content && typeof content === 'object' && Array.isArray((content as Record<string, unknown>).comparisons)) {
    return (content as { comparisons: Record<string, unknown>[] }).comparisons
  }
  return []
}

export function itemLogicalOperator(item: Record<string, unknown>): string {
  if (typeof item.logicalOperator === 'string') return item.logicalOperator
  const content = item.content
  if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).logicalOperator === 'string') {
    return (content as { logicalOperator: string }).logicalOperator
  }
  return 'AND'
}

/** Canvas row label for a choice option / condition branch / A-B bucket. */
export function itemSummary(item: Record<string, unknown>, idx: number, text: FlowText = DEFAULT_FLOW_TEXT): string {
  if (typeof item.content === 'string' && item.content) return item.content
  if (typeof item.value === 'string' && item.value) return item.value
  const comps = itemComparisons(item)
  if (comps.length > 0) {
    const s = comparisonSummary(comps[0])
    if (!s) return text.branch(idx + 1)
    return comps.length > 1 ? `${s} (+${comps.length - 1})` : s
  }
  if (item.weight != null || item.percentage != null) {
    return text.bucket(idx + 1, Number(item.weight ?? item.percentage) || 0)
  }
  return text.option(idx + 1)
}

/** updateItem patch normalizing a condition item to the flat shape. */
export function conditionItemPatch(
  comparisons: Record<string, unknown>[],
  logicalOperator: string,
): Record<string, unknown> {
  return { comparisons, logicalOperator, content: undefined }
}

// ─── duplicate ──────────────────────────────────────────────────────────

/** Deep-copy a block with fresh block/item ids; outgoing links are stripped. */
function copyBlock(b: Block): Block {
  const copy = JSON.parse(JSON.stringify(b)) as Block
  copy.id = genId('blk')
  delete copy.outgoingEdgeId
  const opts = (copy.options ?? {}) as Record<string, unknown>
  for (const list of [opts.items, copy.items]) {
    if (Array.isArray(list)) {
      for (const item of list as Record<string, unknown>[]) {
        if (item && typeof item === 'object') {
          item.id = genId('item')
          delete item.outgoingEdgeId
        }
      }
    }
  }
  return copy
}

/** Duplicate a block right below the original (branch edges not copied). */
export function duplicateBlock(def: Def, groupId: string, blockId: string): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId)
  if (!g) return def
  const idx = g.blocks.findIndex((b) => b.id === blockId)
  if (idx === -1) return def
  g.blocks.splice(idx + 1, 0, copyBlock(g.blocks[idx]!))
  return next
}

/** Duplicate a whole group, offset on the canvas (edges not copied). */
export function duplicateGroup(def: Def, groupId: string, text: FlowText = DEFAULT_FLOW_TEXT): Def {
  const next = clone(def)
  const g = groups(next).find((x) => x.id === groupId) as (Group & { graphCoordinates?: XY }) | undefined
  if (!g) return def
  const pos = groupPosition(next, groupId)
  const copy: Group & { graphCoordinates?: XY } = {
    ...(JSON.parse(JSON.stringify(g)) as Group),
    id: genId('grp'),
    title: text.copyOf(g.title || text.groupFallback),
    graphCoordinates: { x: pos.x + 40, y: pos.y + 40 },
  }
  copy.blocks = copy.blocks.map((b) => copyBlock(b))
  groups(next).push(copy)
  return next
}
