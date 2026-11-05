import { z } from 'zod'

// ─── Flow definition (Typebot/Cosmo-Flows-compatible subset) ──────────
//
// Flows are stored as a JSON graph: groups contain ordered blocks; edges wire
// a block's outgoing edge to a target group/block. Blocks are kept permissive
// (id + type + free-form options) because authored flows carry a wide, evolving
// set of block shapes — the engine reads each block's options defensively, the
// same way Nebula's bot_engine does. We only validate the envelope.

export const FlowVariable = z.object({
  id: z.string(),
  name: z.string(),
  // `contact` variables are pre-seeded from the contact's custom attributes.
  entity: z.string().optional(),
})
export type FlowVariable = z.infer<typeof FlowVariable>

export const FlowBlock = z
  .object({
    id: z.string(),
    type: z.string(),
    outgoingEdgeId: z.string().optional().nullable(),
  })
  .passthrough()
export type FlowBlock = z.infer<typeof FlowBlock> & Record<string, unknown>

export const FlowGroup = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    blocks: z.array(FlowBlock),
    // Canvas position (Typebot shape). Optional: flows authored before the
    // canvas builder — or hand-written ones — get an auto-layout instead.
    graphCoordinates: z.object({ x: z.number(), y: z.number() }).optional(),
  })
  // Passthrough so migrated Typebot metadata survives round-trips. A strict
  // object here silently STRIPPED graphCoordinates from all imported flows.
  .passthrough()
export type FlowGroup = z.infer<typeof FlowGroup> & Record<string, unknown>

export const FlowEdge = z.object({
  id: z.string(),
  from: z.object({ groupId: z.string().optional(), blockId: z.string().optional() }).passthrough(),
  to: z.object({ groupId: z.string(), blockId: z.string().optional().nullable() }),
})
export type FlowEdge = z.infer<typeof FlowEdge>

export const FlowDefinition = z.object({
  groups: z.array(FlowGroup),
  edges: z.array(FlowEdge),
  variables: z.array(FlowVariable).default([]),
  // start group: explicit, else the first group.
  startGroupId: z.string().optional(),
})
export type FlowDefinition = z.infer<typeof FlowDefinition>

// ─── Flow CRUD ────────────────────────────────────────────────────────

export const FlowStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
export type FlowStatus = z.infer<typeof FlowStatus>

// How an inbox blends the deterministic flow with the AI agent.
//   OFF    → pure AI agent (today's behavior)
//   STRICT → deterministic only; non-matching input retries/handoffs
//   GUIDED → deterministic happy-path + AI handles deviations (Phase 4)
export const FlowMode = z.enum(['OFF', 'STRICT', 'GUIDED'])
export type FlowMode = z.infer<typeof FlowMode>

// GUIDED-mode policy for AI-handled deviations.
export const DeviationPolicy = z.enum([
  'answer_and_return', // answer the question, then re-ask the step
  'answer_and_advance', // also let the AI fill the step from free text
  'free_until_done', // also let the AI exit the flow to free conversation
  'escalate', // answer-only; hand to a human sooner
])
export type DeviationPolicy = z.infer<typeof DeviationPolicy>

// ─── Flow preview (builder "test bot" panel) ─────────────────────────
//
// Stateless: the client holds the engine's runtime state between steps and
// posts it back with the visitor's reply. Nothing is persisted server-side.

export const FlowPreviewState = z.object({
  currentFlowId: z.string(),
  stack: z.array(z.object({ flowId: z.string(), returnEdgeId: z.string().nullable() })),
  currentGroupId: z.string().nullable(),
  currentBlockId: z.string().nullable(),
  variables: z.record(z.unknown()),
  retryCounts: z.record(z.number()),
  visitCounts: z.record(z.number()),
})
export type FlowPreviewState = z.infer<typeof FlowPreviewState>

export const FlowPreviewInput = z.object({
  // Absent/null → start the flow from the beginning.
  state: FlowPreviewState.optional().nullable(),
  input: z
    .object({
      text: z.string().max(4000),
      interactiveReplyId: z.string().optional().nullable(),
    })
    .optional(),
})
export type FlowPreviewInput = z.infer<typeof FlowPreviewInput>

// Mirrors the engine's emission/intent shapes for web rendering (type-only).
export type FlowPreviewEmission =
  | { kind: 'text'; text: string }
  | {
      kind: 'interactive'
      content: {
        kind: 'buttons' | 'list'
        body: string
        buttons?: { id: string; label: string }[]
        sections?: { title?: string; rows: { id: string; label: string }[] }[]
      }
    }
  | { kind: 'media'; mediaType: string; url: string; caption?: string | null }

export type FlowPreviewResultDTO = {
  status: 'waiting' | 'completed' | 'handoff' | 'deviation'
  emissions: FlowPreviewEmission[]
  intents: unknown[]
  state: FlowPreviewState
}

export const CreateFlowInput = z.object({
  name: z.string().min(1).max(120),
  definition: FlowDefinition,
})
export type CreateFlowInput = z.infer<typeof CreateFlowInput>

export const UpdateFlowInput = z.object({
  name: z.string().min(1).max(120).optional(),
  definition: FlowDefinition.optional(),
})
export type UpdateFlowInput = z.infer<typeof UpdateFlowInput>

export const FlowDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  status: FlowStatus,
  definition: FlowDefinition,
  hasPublished: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FlowDTO = z.infer<typeof FlowDTO>

/**
 * A wiring defect found in a flow when it is published.
 *
 * The check is a warning, never a block: an author mid-build has half a graph
 * and is entitled to save it. What it must not do is let a defect reach a
 * customer unseen, which is how the commercial menu stayed dead from April to
 * September 2026. The code is what the UI translates; `groupTitle` is how the
 * author finds the group on the canvas.
 */
export const FlowCheckCode = z.enum([
  'unreachable_group',
  'menu_without_route',
  'question_without_route',
  'link_to_missing_flow',
  'link_cycle',
])
export type FlowCheckCode = z.infer<typeof FlowCheckCode>

export const FlowCheckDTO = z.object({
  code: FlowCheckCode,
  groupId: z.string(),
  groupTitle: z.string(),
})
export type FlowCheckDTO = z.infer<typeof FlowCheckDTO>

export const FlowPublishResultDTO = z.object({
  flow: FlowDTO,
  checks: z.array(FlowCheckDTO),
})
export type FlowPublishResultDTO = z.infer<typeof FlowPublishResultDTO>

export const FlowSummaryDTO = z.object({
  id: z.string(),
  name: z.string(),
  status: FlowStatus,
  hasPublished: z.boolean(),
  updatedAt: z.string(),
  // V1 typebot id — the key `Cosmoflow link` blocks reference sub-flows by.
  externalId: z.string().nullable(),
})
export type FlowSummaryDTO = z.infer<typeof FlowSummaryDTO>
