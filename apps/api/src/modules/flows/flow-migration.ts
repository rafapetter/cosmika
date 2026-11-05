import { FlowDefinition } from '@cosmika/shared'

// ─── Cosmo-Flows / Nebula → Cosmika flow converter ───────────────────
//
// Cosmo-Flows (`cf_public_cosmoflows`) and Nebula V3 (`flows.published_
// definition`) store the same Typebot-shaped graph Cosmika uses, so this is a
// near-identity transform. Its real jobs: derive the start group from the
// `events` start node, drop theme/settings, coerce variables, and FLAG block
// types the engine doesn't run (so migration is auditable, not silently lossy).
// Block-level V1 dual-form quirks (cosmodesk team/message, phone-input alias,
// choice edge/item, template name/params) are handled by the engine itself.

// Block types the engine executes (anything else → a warning, but kept so the
// flow still imports). Mirrors FlowEngine's switch + input set.
const SUPPORTED_BLOCKS = new Set([
  // bubbles
  'text', 'image', 'video', 'audio', 'embed', 'cards',
  // inputs
  'text input', 'email input', 'number input', 'url input',
  'phone number input', 'phone input', 'date input', 'choice input',
  'picture choice input', 'file input', 'rating input',
  // logic
  'Condition', 'Jump', 'Set variable', 'AB test', 'Redirect', 'Webview',
  'Wait', 'Cosmoflow link',
  // integrations / control
  'Webhook', 'webhook', 'api_call', 'API call', 'OpenAI', 'openai',
  'Google Sheets', 'Email', 'Pipefy', 'WhatsApp Template',
  'Ticket Create', 'Ticket Update', 'Ticket Query',
  'Cosmodesk', 'cosmodesk', 'note', 'end-session',
  // author JS — executed in the isolated-vm sandbox (degrades to a no-op where
  // the native module isn't built).
  'Code', 'Script',
])

// Blocks that need a runtime capability present only in a properly-provisioned
// deploy (here: the isolated-vm sandbox). Imported + executed, but flagged so
// the migration report notes the dependency.
const SANDBOX_BLOCKS = new Set(['Code', 'Script'])

export type FlowConversion = {
  definition: FlowDefinition | null
  warnings: string[]
  // counts of block types seen, for migration reporting
  blockCounts: Record<string, number>
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/**
 * Derive the start group: follow the `start` event's outgoing edge to its
 * target group; fall back to the first group.
 */
function deriveStartGroup(
  events: unknown,
  edges: unknown[],
  firstGroupId: string,
): string {
  for (const e of asArr(events)) {
    const ev = asObj(e)
    if (!ev) continue
    const edgeId = ev.outgoingEdgeId
    if (typeof edgeId !== 'string') continue
    const edge = edges
      .map(asObj)
      .find((x) => x && x.id === edgeId)
    const to = edge && asObj(edge.to)
    if (to && typeof to.groupId === 'string') return to.groupId
  }
  return firstGroupId
}

export function convertPublishedFlow(source: unknown): FlowConversion {
  const warnings: string[] = []
  const blockCounts: Record<string, number> = {}
  const s = asObj(source)
  if (!s) return { definition: null, warnings: ['source is empty or not an object'], blockCounts }

  const groups = asArr(s.groups)
  const edges = asArr(s.edges)
  if (groups.length === 0) {
    warnings.push('flow has no groups')
    return { definition: null, warnings, blockCounts }
  }

  // Tally block types + flag anything the engine won't run.
  for (const g of groups) {
    const grp = asObj(g)
    for (const b of asArr(grp?.blocks)) {
      const block = asObj(b)
      const type = typeof block?.type === 'string' ? block.type : '(unknown)'
      blockCounts[type] = (blockCounts[type] ?? 0) + 1
      if (SANDBOX_BLOCKS.has(type)) {
        warnings.push(`block "${type}" runs in the isolated-vm sandbox (no-op if the native module is absent)`)
      } else if (!SUPPORTED_BLOCKS.has(type)) {
        warnings.push(`block "${type}" has no engine support — will be skipped`)
      }
    }
  }

  const firstGroup = asObj(groups[0])
  const firstGroupId = typeof firstGroup?.id === 'string' ? firstGroup.id : ''
  const startGroupId = deriveStartGroup(s.events, edges, firstGroupId)

  const variables = asArr(s.variables)
    .map((v) => {
      const vv = asObj(v)
      if (!vv || typeof vv.id !== 'string' || typeof vv.name !== 'string') return null
      return {
        id: vv.id,
        name: vv.name,
        ...(typeof vv.entity === 'string' ? { entity: vv.entity } : {}),
      }
    })
    .filter((v): v is { id: string; name: string } => v !== null)

  const candidate = { groups, edges, variables, startGroupId }
  const parsed = FlowDefinition.safeParse(candidate)
  if (!parsed.success) {
    warnings.push('converted definition failed schema validation')
    return { definition: null, warnings, blockCounts }
  }
  return { definition: parsed.data, warnings, blockCounts }
}
