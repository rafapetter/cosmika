// Static checks over a published flow definition.
//
// Every defect behind conversation 8739 was visible in the definition itself,
// weeks before a customer hit it: a menu whose options had no route, a
// Condition chain no edge reached, a link cycle between two flows. Nothing
// looked at them, so the first person to find out was a sales lead at 01:45.
//
// Pure and I/O-free: the caller supplies the definition and (for link checks)
// the ids of the flows it could resolve.
import type { FlowDefinition } from '@cosmika/shared'

export type FlowLintCode =
  | 'unreachable_group'
  | 'menu_without_route'
  | 'question_without_route'
  | 'link_to_missing_flow'
  | 'link_cycle'

export type FlowLintFinding = {
  code: FlowLintCode
  /** Group the problem sits in, for the author to find it. */
  groupId: string
  groupTitle: string
  detail: string
}

type Block = Record<string, unknown> & { id: string; type: string }
type Group = { id: string; title?: string; blocks?: Block[] }

const INPUT_TYPES = new Set([
  'text input', 'email input', 'number input', 'url input',
  'phone number input', 'phone input', 'date input', 'choice input',
  'picture choice input', 'file input', 'rating input',
])
const CHOICE_TYPES = new Set(['choice input', 'picture choice input'])
const COMPOSITE_HEAD_TYPES = new Set([
  'choice input',
  'picture choice input',
  'rating input',
])
// Blocks that end the conversation on purpose: a question before one of these
// is allowed to have nowhere to go.
const TERMINAL_TYPES = new Set(['end-session', 'Cosmodesk', 'cosmodesk', 'Jump'])

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function opt(block: Block, key: string): unknown {
  const options = (block.options ?? block) as Record<string, unknown>
  return options[key]
}

/** An edge leaving this block that is not tied to one of its items. */
function hasBlockEdge(block: Block, edges: FlowDefinition['edges']): boolean {
  if (str(block.outgoingEdgeId)) return true
  return edges.some((e) => {
    const from = e.from as Record<string, unknown>
    return from.blockId === block.id && !str(from.itemId)
  })
}

/**
 * Lint one published definition.
 *
 * `linkedFlowIds` is the set of `cosmoflowId`s the caller could actually
 * resolve, and `selfIds` the ids that mean this very flow (its own
 * `externalId`), so a link back into itself reads as a cycle rather than a
 * missing flow.
 */
export function lintFlow(
  def: FlowDefinition,
  linkedFlowIds: Set<string> = new Set(),
  selfIds: Set<string> = new Set(),
): FlowLintFinding[] {
  const out: FlowLintFinding[] = []
  const groups = arr(def.groups) as Group[]
  const edges = def.edges ?? []
  const startId =
    str((def as { startGroupId?: unknown }).startGroupId) ?? groups[0]?.id ?? null

  const add = (code: FlowLintCode, g: Group, detail: string): void => {
    out.push({ code, groupId: g.id, groupTitle: g.title ?? g.id, detail })
  }

  // Which groups anything can reach. A Jump block targets a group directly,
  // without an edge, so it counts as an arrival too.
  const reached = new Set<string>()
  for (const e of edges) {
    const to = e.to as Record<string, unknown>
    const target = str(to.groupId)
    if (target) reached.add(target)
  }
  for (const g of groups) {
    for (const b of arr(g.blocks) as Block[]) {
      const jump = b.type === 'Jump' ? str(opt(b, 'groupId')) : null
      if (jump) reached.add(jump)
    }
  }

  for (const g of groups) {
    const blocks = arr(g.blocks) as Block[]

    if (g.id !== startId && !reached.has(g.id)) {
      add('unreachable_group', g, 'nothing leads to this group')
    }

    for (const [i, b] of blocks.entries()) {
      if (b.type === 'Cosmoflow link') {
        const raw = opt(b, 'cosmoflowId')
        const id = typeof raw === 'number' ? String(raw) : str(raw)
        // 'current' is the intra-flow keyword, not a cross-flow reference.
        if (id && id !== 'current') {
          if (selfIds.has(id)) {
            add('link_cycle', g, `links back into this same flow (${id})`)
          } else if (!linkedFlowIds.has(id)) {
            add('link_to_missing_flow', g, `links to flow ${id}, which did not resolve`)
          }
        }
        continue
      }

      if (!INPUT_TYPES.has(b.type)) continue
      // The trailing input of a composite step is the menu's router, not a
      // question of its own: judging it separately reports the same defect
      // twice and invents one where the menu is fine.
      const prev = blocks[i - 1]
      if (b.type === 'text input' && prev && COMPOSITE_HEAD_TYPES.has(prev.type)) continue

      const next = blocks[i + 1]
      const composite =
        CHOICE_TYPES.has(b.type) || b.type === 'rating input'
          ? next && next.type === 'text input'
            ? next
            : null
          : null
      // A composite's route lives on its trailing input, so judge that one.
      const router = composite ?? b
      const routed =
        hasBlockEdge(router, edges) ||
        blocks.slice(blocks.indexOf(router) + 1).length > 0

      if (CHOICE_TYPES.has(b.type)) {
        const items = arr(opt(b, 'items')) as Array<Record<string, unknown>>
        const wired = items.filter(
          (it) =>
            str(it.outgoingEdgeId) ||
            edges.some((e) => (e.from as Record<string, unknown>).itemId === it.id),
        ).length
        if (items.length > 0 && wired === 0 && !routed) {
          add(
            'menu_without_route',
            g,
            `${items.length} options, none with a route of its own and nothing after the menu`,
          )
        }
        continue
      }

      if (!routed && !blocks.some((x) => TERMINAL_TYPES.has(x.type))) {
        add('question_without_route', g, `"${b.type}" is answered but leads nowhere`)
      }
    }
  }

  return out
}

/** One-line summary per finding, for a CLI report or a log line. */
export function formatFindings(findings: FlowLintFinding[]): string[] {
  return findings.map((f) => `[${f.code}] ${f.groupTitle}: ${f.detail}`)
}
