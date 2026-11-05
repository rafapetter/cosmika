import { FlowDefinition } from '@cosmika/shared'

/**
 * Editing a flow is the most dangerous thing the assistant can do. A flow is a
 * graph that a real customer walks through on WhatsApp; a dangling edge or a
 * deleted block doesn't throw, it just silently strands people mid-conversation
 * — which is exactly the class of bug that made every V1-imported flow
 * unrunnable before it was found by executing one, not by reading it.
 *
 * So nothing here trusts the model. Every mutation produces a candidate
 * definition which is then checked for shape AND referential integrity, and is
 * only persisted if it passes.
 */

export type Block = Record<string, unknown> & { id: string; type: string }
export type Group = Record<string, unknown> & { id: string; blocks: Block[] }
export type Edge = {
  id: string
  from: { groupId?: string; blockId?: string; itemId?: string }
  to: { groupId: string; blockId?: string | null }
}
export type Definition = {
  groups: Group[]
  edges: Edge[]
  variables?: unknown[]
  startGroupId?: string
}

export type ValidationIssue = string

/**
 * Shape plus the things zod cannot express: that every reference resolves.
 *
 * Returns issues rather than throwing so a tool can report them back to the
 * model as something it can fix, instead of a stack trace.
 */
export function validateDefinition(candidate: unknown): ValidationIssue[] {
  const parsed = FlowDefinition.safeParse(candidate)
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`)
  }
  const def = parsed.data as unknown as Definition
  const issues: ValidationIssue[] = []

  const groupIds = new Set(def.groups.map((g) => g.id))
  const blockIds = new Set<string>()
  for (const g of def.groups) {
    for (const b of g.blocks) {
      if (blockIds.has(b.id)) issues.push(`duplicate block id "${b.id}"`)
      blockIds.add(b.id)
    }
  }
  if (groupIds.size !== def.groups.length) issues.push('duplicate group ids')

  const edgeIds = new Set<string>()
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) issues.push(`duplicate edge id "${e.id}"`)
    edgeIds.add(e.id)
    if (!groupIds.has(e.to.groupId)) {
      issues.push(`edge "${e.id}" points at group "${e.to.groupId}", which does not exist`)
    }
    const fromGroup = e.from?.groupId
    const fromBlock = e.from?.blockId
    if (fromGroup && !groupIds.has(fromGroup)) {
      issues.push(`edge "${e.id}" starts at group "${fromGroup}", which does not exist`)
    }
    if (fromBlock && !blockIds.has(fromBlock)) {
      issues.push(`edge "${e.id}" starts at block "${fromBlock}", which does not exist`)
    }
  }

  for (const g of def.groups) {
    for (const b of g.blocks) {
      const out = b.outgoingEdgeId
      if (typeof out === 'string' && out && !edgeIds.has(out)) {
        issues.push(`block "${b.id}" points at edge "${out}", which does not exist`)
      }
    }
  }

  if (def.startGroupId && !groupIds.has(def.startGroupId)) {
    issues.push(`startGroupId "${def.startGroupId}" is not a group in this flow`)
  }
  if (def.groups.length === 0) issues.push('a flow needs at least one group')

  return issues
}

/**
 * Groups nothing can reach from the start.
 *
 * Not an error — an author may be mid-edit — but the assistant should say so,
 * because "I added the block" while the block is unreachable is a false
 * report of success.
 */
export function unreachableGroups(def: Definition): string[] {
  if (def.groups.length === 0) return []
  const start = def.startGroupId ?? def.groups[0]!.id
  const byId = new Map(def.groups.map((g) => [g.id, g]))
  const blockToGroup = new Map<string, string>()
  for (const g of def.groups) for (const b of g.blocks) blockToGroup.set(b.id, g.id)

  const outgoing = new Map<string, string[]>()
  for (const e of def.edges) {
    const source = e.from?.groupId ?? (e.from?.blockId ? blockToGroup.get(e.from.blockId) : undefined)
    if (!source) continue
    outgoing.set(source, [...(outgoing.get(source) ?? []), e.to.groupId])
  }

  const seen = new Set<string>()
  const queue = [start]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id) || !byId.has(id)) continue
    seen.add(id)
    for (const next of outgoing.get(id) ?? []) if (!seen.has(next)) queue.push(next)
  }
  return def.groups.map((g) => g.id).filter((id) => !seen.has(id))
}

/** Deep clone so a failed edit can never leave the caller's copy half-changed. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function findBlock(
  def: Definition,
  blockId: string,
): { group: Group; block: Block; index: number } | null {
  for (const group of def.groups) {
    const index = group.blocks.findIndex((b) => b.id === blockId)
    if (index >= 0) return { group, block: group.blocks[index]!, index }
  }
  return null
}

/**
 * A one-line description of what a block does, for listing a flow without
 * dumping every option. The engine reads content from several shapes
 * depending on how the flow was authored or imported, so this looks in all of
 * them rather than assuming the modern one.
 */
export function summariseBlock(block: Block): string {
  const opts = (block.options ?? {}) as Record<string, unknown>
  if (opts.conditionType === 'business_hours' && opts.businessHours && typeof opts.businessHours === 'object') {
    const tz = typeof opts.timezone === 'string' ? opts.timezone : 'UTC'
    return `opening hours (${tz}): ${describeSchedule(opts.businessHours as Record<string, unknown>)}`.slice(0, 160)
  }
  const candidates = [
    block.content,
    opts.content,
    block.message,
    opts.message,
    block.text,
    opts.text,
    opts.name,
    block.name,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 160)
    if (c && typeof c === 'object') {
      const inner = (c as Record<string, unknown>).text ?? (c as Record<string, unknown>).html
      if (typeof inner === 'string' && inner.trim()) return inner.trim().slice(0, 160)
    }
  }
  const items = (block.items ?? opts.items) as unknown
  if (Array.isArray(items) && items.length > 0) {
    const labels = items
      .map((i) => {
        const rec = (i ?? {}) as Record<string, unknown>
        return rec.content ?? rec.label ?? rec.value
      })
      .filter((x) => typeof x === 'string')
    if (labels.length > 0) return `options: ${labels.join(' | ')}`.slice(0, 160)
  }
  return ''
}

/** Ids the model does not choose: collision-free and obviously machine-made. */
export function newId(prefix: string, existing: Set<string>): string {
  let n = 1
  let id = `${prefix}_${n}`
  while (existing.has(id)) {
    n += 1
    id = `${prefix}_${n}`
  }
  return id
}

export function allBlockIds(def: Definition): Set<string> {
  const ids = new Set<string>()
  for (const g of def.groups) for (const b of g.blocks) ids.add(b.id)
  return ids
}

export function allEdgeIds(def: Definition): Set<string> {
  return new Set(def.edges.map((e) => e.id))
}

/**
 * What publishing this draft would actually change, in terms a person can
 * check before clicking approve.
 *
 * This exists because of a real near-miss: three live flows on a production
 * account had drafts still pointing at a decommissioned ticket system, so
 * publishing any of them would have silently reverted a completed migration.
 * "Publish flow 3351" tells an approver nothing; this does.
 */
export function summariseChange(
  draft: Definition,
  live: Definition | null,
): Record<string, unknown> {
  if (!live) return { firstPublish: true }

  const liveGroups = new Set(live.groups.map((g) => g.id))
  const draftGroups = new Set(draft.groups.map((g) => g.id))
  const liveBlocks = new Map<string, Block>()
  for (const g of live.groups) for (const b of g.blocks) liveBlocks.set(b.id, b)
  const draftBlocks = new Map<string, Block>()
  for (const g of draft.groups) for (const b of g.blocks) draftBlocks.set(b.id, b)

  const changedText: Array<{ blockId: string; from: string; to: string }> = []
  for (const [id, b] of draftBlocks) {
    const before = liveBlocks.get(id)
    if (!before) continue
    const from = summariseBlock(before)
    const to = summariseBlock(b)
    if (from !== to) changedText.push({ blockId: id, from, to })
  }

  const liveLinks = linkTargets(live)
  const draftLinks = linkTargets(draft)

  return {
    groupsAdded: [...draftGroups].filter((g) => !liveGroups.has(g)),
    groupsRemoved: [...liveGroups].filter((g) => !draftGroups.has(g)),
    blocksAdded: [...draftBlocks.keys()].filter((b) => !liveBlocks.has(b)),
    blocksRemoved: [...liveBlocks.keys()].filter((b) => !draftBlocks.has(b)),
    messagesChanged: changedText.slice(0, 10),
    // A change in which sub-flows are linked is the highest-consequence edit
    // and the easiest to miss in a diff of text.
    linkedFlowsAdded: [...draftLinks].filter((l) => !liveLinks.has(l)),
    linkedFlowsRemoved: [...liveLinks].filter((l) => !draftLinks.has(l)),
  }
}

function linkTargets(def: Definition): Set<string> {
  const out = new Set<string>()
  for (const g of def.groups) {
    for (const b of g.blocks) {
      const opts = (b.options ?? {}) as Record<string, unknown>
      const id = opts.cosmoflowId ?? (b as Record<string, unknown>).cosmoflowId
      if (typeof id === 'string' && id) out.add(id)
    }
  }
  return out
}

// ─── Groups and menu options ─────────────────────────────────────────────
//
// Without these the assistant could only edit blocks inside groups that
// already existed, and could route a block as a whole but not each option of
// a menu. So "build me a menu with three options, each with its own reply"
// (Gabriel, 2026-09-10) was impossible no matter how it was asked.

export const CHOICE_BLOCK_TYPES = new Set(['choice input', 'picture choice input'])

/** WhatsApp shows ≤3 short options as buttons and anything else as a list. */
export const MAX_CHOICE_OPTIONS = 10
export const MAX_LIST_LABEL = 24
export const MAX_BUTTON_LABEL = 20

type XY = { x: number; y: number }

export function allGroupIds(def: Definition): Set<string> {
  return new Set(def.groups.map((g) => g.id))
}

export function allItemIds(def: Definition): Set<string> {
  const ids = new Set<string>()
  for (const g of def.groups) {
    for (const b of g.blocks) {
      for (const it of choiceItems(b)) if (typeof it.id === 'string') ids.add(it.id)
    }
  }
  return ids
}

/** Items live in `options.items` natively and at block level in V1 imports. */
export function choiceItems(block: Block): Array<Record<string, unknown>> {
  const opts = block.options as { items?: unknown } | undefined
  const raw = Array.isArray(opts?.items) ? opts?.items : block.items
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

/**
 * Where a new group goes on the canvas: a column to the right of everything
 * already placed, stacked downwards, so it never lands on top of a migrated
 * flow's hand-arranged layout.
 */
export function nextGroupPosition(def: Definition, stackIndex = 0): XY {
  let maxX = -Infinity
  for (const g of def.groups) {
    const c = (g as { graphCoordinates?: Partial<XY> }).graphCoordinates
    if (c && typeof c.x === 'number') maxX = Math.max(maxX, c.x)
  }
  const x = Number.isFinite(maxX) ? maxX + 400 : def.groups.length * 340
  return { x, y: stackIndex * 260 }
}

/**
 * A new block in the shape the engine and editor read. The one trap: a menu's
 * question lives in `options.message`: that is what the engine sends as the
 * WhatsApp body. Stored as `content` it would be ignored, and a menu with no
 * text bubble before it would go out with no question at all.
 */
export function shapeNewBlock(b: {
  type: string
  content?: string
  options?: Record<string, unknown>
}): { type: string; content?: string; options?: Record<string, unknown> } {
  if (CHOICE_BLOCK_TYPES.has(b.type) && typeof b.content === 'string') {
    return { type: b.type, options: { ...(b.options ?? {}), message: b.content } }
  }
  return {
    type: b.type,
    ...(typeof b.content === 'string' ? { content: b.content } : {}),
    ...(b.options ? { options: b.options } : {}),
  }
}

export function addGroup(
  def: Definition,
  title: string,
  blocks: Array<{ type: string; content?: string; options?: Record<string, unknown> }>,
  stackIndex = 0,
): { groupId: string; blockIds: string[] } {
  const groupId = newId('grp', allGroupIds(def))
  const taken = allBlockIds(def)
  const blockIds: string[] = []
  const made = blocks.map((b) => {
    const id = newId('blk', taken)
    taken.add(id)
    blockIds.push(id)
    return { id, ...shapeNewBlock(b) }
  })
  def.groups.push({
    id: groupId,
    title,
    blocks: made,
    graphCoordinates: nextGroupPosition(def, stackIndex),
  })
  return { groupId, blockIds }
}

/**
 * Remove a group and everything that pointed into or out of it, so no edge is
 * left dangling. The start group is refused: a flow must begin somewhere.
 */
export function removeGroup(
  def: Definition,
  groupId: string,
): string | { deleted: string; removedEdges: string[]; removedBlocks: number } {
  const idx = def.groups.findIndex((g) => g.id === groupId)
  if (idx < 0) return `no group "${groupId}" in this flow`
  if (def.startGroupId === groupId) {
    return 'that is the start group; move the start elsewhere before deleting it'
  }
  const [group] = def.groups.splice(idx, 1)
  const blockIds = new Set(group!.blocks.map((b) => b.id))
  const gone = def.edges
    .filter(
      (e) =>
        e.to.groupId === groupId ||
        e.from?.groupId === groupId ||
        (e.from?.blockId !== undefined && blockIds.has(e.from.blockId)),
    )
    .map((e) => e.id)
  const goneSet = new Set(gone)
  def.edges = def.edges.filter((e) => !goneSet.has(e.id))
  detachEdges(def, goneSet)
  return { deleted: groupId, removedEdges: gone, removedBlocks: blockIds.size }
}

/** Clear any block or menu option still pointing at a removed edge. */
function detachEdges(def: Definition, gone: Set<string>): void {
  for (const g of def.groups) {
    for (const b of g.blocks) {
      if (typeof b.outgoingEdgeId === 'string' && gone.has(b.outgoingEdgeId)) {
        b.outgoingEdgeId = null
      }
      for (const it of choiceItems(b)) {
        if (typeof it.outgoingEdgeId === 'string' && gone.has(it.outgoingEdgeId)) {
          it.outgoingEdgeId = null
        }
      }
    }
  }
}

export type ChoiceOption = { label: string; value?: string; toGroupId?: string }

/**
 * Replace a menu's options, each with its own destination.
 *
 * The engine routes a tap by the option's own edge (`item.outgoingEdgeId`,
 * edge `from.itemId`), which is also what the visual editor draws. Old option
 * edges are dropped with the old options; the block's own edge, if any, is
 * left alone.
 */
export function setChoiceOptions(
  def: Definition,
  blockId: string,
  options: ChoiceOption[],
  question?: string,
): string | { blockId: string; options: Array<{ itemId: string; label: string; toGroupId: string | null }>; shownAs: 'buttons' | 'list' } {
  const found = findBlock(def, blockId)
  if (!found) return `no block "${blockId}" in this flow`
  if (!CHOICE_BLOCK_TYPES.has(found.block.type)) {
    return `block "${blockId}" is a "${found.block.type}", not a menu (choice input)`
  }
  if (options.length === 0 || options.length > MAX_CHOICE_OPTIONS) {
    return `a menu needs 1 to ${MAX_CHOICE_OPTIONS} options (WhatsApp's limit)`
  }
  const tooLong = options.find((o) => !o.label?.trim() || o.label.length > MAX_LIST_LABEL)
  if (tooLong) {
    return `option labels must be 1 to ${MAX_LIST_LABEL} characters (WhatsApp's limit): "${tooLong.label ?? ''}"`
  }
  const groupIds = allGroupIds(def)
  const missing = options.find((o) => o.toGroupId && !groupIds.has(o.toGroupId))
  if (missing) return `no group "${missing.toGroupId}" in this flow`

  const oldItemIds = new Set(
    choiceItems(found.block).map((it) => it.id).filter((id): id is string => typeof id === 'string'),
  )
  const gone = new Set(
    def.edges
      .filter((e) => e.from?.blockId === blockId && e.from.itemId && oldItemIds.has(e.from.itemId))
      .map((e) => e.id),
  )
  def.edges = def.edges.filter((e) => !gone.has(e.id))

  const itemIds = allItemIds(def)
  const edgeIds = allEdgeIds(def)
  const result: Array<{ itemId: string; label: string; toGroupId: string | null }> = []
  const items = options.map((o) => {
    const itemId = newId('opt', itemIds)
    itemIds.add(itemId)
    const item: Record<string, unknown> = { id: itemId, content: o.label.trim() }
    if (o.value) item.value = o.value
    if (o.toGroupId) {
      const edgeId = newId('edge', edgeIds)
      edgeIds.add(edgeId)
      def.edges.push({ id: edgeId, from: { blockId, itemId }, to: { groupId: o.toGroupId } })
      item.outgoingEdgeId = edgeId
    }
    result.push({ itemId, label: o.label.trim(), toGroupId: o.toGroupId ?? null })
    return item
  })
  // Write where the engine and editor both read: options.items natively.
  const opts = (found.block.options as Record<string, unknown> | undefined) ?? {}
  found.block.options = { ...opts, items, ...(question?.trim() ? { message: question.trim() } : {}) }
  if ('items' in found.block) delete found.block.items
  const buttons =
    options.length <= 3 && options.every((o) => o.label.trim().length <= MAX_BUTTON_LABEL)
  return { blockId, options: result, shownAs: buttons ? 'buttons' : 'list' }
}

/** Point one menu option at a group, replacing where it went before. */
export function connectOption(
  def: Definition,
  blockId: string,
  itemId: string,
  toGroupId: string,
): string | { from: string; option: string; to: string; edgeId: string; replaced: string[] } {
  const found = findBlock(def, blockId)
  if (!found) return `no block "${blockId}" in this flow`
  const item = choiceItems(found.block).find((it) => it.id === itemId)
  if (!item) return `no option "${itemId}" on block "${blockId}"`
  if (!allGroupIds(def).has(toGroupId)) return `no group "${toGroupId}" in this flow`
  const replaced = def.edges
    .filter((e) => e.from?.blockId === blockId && e.from.itemId === itemId)
    .map((e) => e.id)
  def.edges = def.edges.filter((e) => !replaced.includes(e.id))
  const edgeId = newId('edge', allEdgeIds(def))
  def.edges.push({ id: edgeId, from: { blockId, itemId }, to: { groupId: toGroupId } })
  item.outgoingEdgeId = edgeId
  return { from: blockId, option: itemId, to: toGroupId, edgeId, replaced }
}

// ─── opening-hours branch ───────────────────────────────────────────────

/** One stretch of opening time, on one or more weekdays. Times are HH:MM, 24h. */
export type HoursWindow = { days: string[]; open: string; close: string }

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_SHIFTS_PER_DAY = 2

/** True when the runtime knows this IANA timezone name. */
export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Turn the windows a person describes ("Monday to Friday 7 to 12 and 13:30 to
 * 18") into the weekly schedule the engine reads: `mon_1`/`mon_2` for the
 * day's first shift, `mon_3`/`mon_4` for a second one. A day with no window is
 * closed all day.
 */
export function scheduleFromWindows(
  windows: HoursWindow[],
): string | Record<string, string> {
  if (!Array.isArray(windows) || windows.length === 0) {
    return 'give at least one opening window (days, open, close)'
  }
  const perDay = new Map<string, Array<{ open: string; close: string }>>()
  for (const w of windows) {
    const days = Array.isArray(w?.days) ? w.days.map((d) => String(d).toLowerCase().slice(0, 3)) : []
    if (days.length === 0) return 'each window needs at least one day (mon, tue, wed, thu, fri, sat, sun)'
    const bad = days.find((d) => !WEEKDAYS.includes(d))
    if (bad) return `"${bad}" is not a weekday; use mon, tue, wed, thu, fri, sat or sun`
    if (typeof w.open !== 'string' || !HHMM.test(w.open) || typeof w.close !== 'string' || !HHMM.test(w.close)) {
      return `times must be HH:MM in 24h format, got "${String(w.open)}" to "${String(w.close)}"`
    }
    if (w.open >= w.close) return `a window must open before it closes, got ${w.open} to ${w.close}`
    for (const d of days) {
      perDay.set(d, [...(perDay.get(d) ?? []), { open: w.open, close: w.close }])
    }
  }
  const schedule: Record<string, string> = {}
  for (const [day, shifts] of perDay) {
    if (shifts.length > MAX_SHIFTS_PER_DAY) {
      return `${day} has ${shifts.length} windows; a day can have at most ${MAX_SHIFTS_PER_DAY} (for example morning and afternoon)`
    }
    shifts.sort((a, b) => a.open.localeCompare(b.open))
    if (shifts.length === 2 && shifts[1]!.open < shifts[0]!.close) {
      return `the two windows on ${day} overlap (${shifts[0]!.open} to ${shifts[0]!.close} and ${shifts[1]!.open} to ${shifts[1]!.close})`
    }
    shifts.forEach((shift, i) => {
      schedule[`${day}_${i * 2 + 1}`] = shift.open
      schedule[`${day}_${i * 2 + 2}`] = shift.close
    })
  }
  return schedule
}

/** "mon 07:00-12:00, 13:30-18:00; sat 07:00-11:00" for reports and summaries. */
export function describeSchedule(schedule: Record<string, unknown>): string {
  const parts: string[] = []
  for (const day of WEEKDAYS) {
    const shifts: string[] = []
    for (const [a, b] of [[1, 2], [3, 4]] as const) {
      const open = schedule[`${day}_${a}`]
      const close = schedule[`${day}_${b}`]
      if (typeof open === 'string' && open && typeof close === 'string' && close) {
        shifts.push(`${open}-${close}`)
      }
    }
    if (shifts.length > 0) parts.push(`${day} ${shifts.join(', ')}`)
  }
  return parts.join('; ')
}

export type HoursConditionInput = {
  /** Update this existing opening-hours block... */
  blockId?: string
  /** ...or create a new one at the end of this group. */
  groupId?: string
  windows: HoursWindow[]
  timezone: string
  openGroupId: string
  closedGroupId: string
  /** What the editor shows on the "open" branch, in the account's language. */
  openLabel?: string
}

/**
 * Create or replace an opening-hours branch: a Condition block that sends the
 * conversation one way while the schedule says "open" and another way the
 * rest of the time.
 *
 * The engine takes the block's single item as the open branch and the block's
 * own edge as the closed one. Both are always wired here, because a branch
 * left dangling does not fail: it silently ends the conversation for everyone
 * who arrives at that hour.
 */
export function setHoursCondition(
  def: Definition,
  input: HoursConditionInput,
):
  | string
  | { blockId: string; created: boolean; schedule: string; timezone: string; open: string; closed: string } {
  const schedule = scheduleFromWindows(input.windows)
  if (typeof schedule === 'string') return schedule
  if (!isTimezone(input.timezone)) {
    return `"${input.timezone}" is not a timezone; use an IANA name such as America/Sao_Paulo`
  }
  const groupIds = allGroupIds(def)
  if (!groupIds.has(input.openGroupId)) return `no group "${input.openGroupId}" in this flow`
  if (!groupIds.has(input.closedGroupId)) return `no group "${input.closedGroupId}" in this flow`

  let block: Block
  let created = false
  if (input.blockId) {
    const found = findBlock(def, input.blockId)
    if (!found) return `no block "${input.blockId}" in this flow`
    const isHours =
      found.block.type === 'Condition' &&
      (found.block.options as Record<string, unknown> | undefined)?.conditionType === 'business_hours'
    if (!isHours) return `block "${input.blockId}" is not an opening-hours condition`
    block = found.block
    // Both branches are rewired below; drop the old ones first.
    def.edges = def.edges.filter((e) => e.from?.blockId !== block.id)
  } else {
    const group = def.groups.find((g) => g.id === input.groupId)
    if (!group) return `no group "${String(input.groupId)}" in this flow`
    block = { id: newId('blk', allBlockIds(def)), type: 'Condition' }
    group.blocks.push(block)
    created = true
  }

  const edgeIds = allEdgeIds(def)
  const openEdge = newId('edge', edgeIds)
  edgeIds.add(openEdge)
  const closedEdge = newId('edge', edgeIds)
  const itemId = newId('opt', allItemIds(def))
  def.edges.push(
    { id: openEdge, from: { blockId: block.id, itemId }, to: { groupId: input.openGroupId } },
    { id: closedEdge, from: { blockId: block.id }, to: { groupId: input.closedGroupId } },
  )
  block.options = {
    conditionType: 'business_hours',
    businessHours: schedule,
    timezone: input.timezone,
    items: [{ id: itemId, content: input.openLabel?.trim() || 'Open hours', outgoingEdgeId: openEdge }],
  }
  if ('items' in block) delete block.items
  block.outgoingEdgeId = closedEdge
  return {
    blockId: block.id,
    created,
    schedule: describeSchedule(schedule),
    timezone: input.timezone,
    open: input.openGroupId,
    closed: input.closedGroupId,
  }
}
