import type { FlowDefinition, InteractiveContent } from '@cosmika/shared'

import { DATE_OPERATORS, compareFlowDates, formatFlowNow, parseFlowDate } from './flow-datetime'

// ─── Deterministic flow engine ────────────────────────────────────────
//
// A pure, side-effect-free port of Nebula's bot_engine FlowExecutor: a state
// machine that walks groups/edges, emits messages, waits on input blocks, and
// branches deterministically. No DB, no I/O — the caller persists `state` and
// performs the returned `intents` (handoff, note). Integration blocks that need
// I/O (webhook/sheets) come in Phase 3; the AI deviation layer in Phase 4.
//
// Block `type` strings match Nebula's block_processor (case-sensitive), incl.
// V1-import aliases ('phone input').

// Sentinel id for the root flow in the engine's def registry.
export const ROOT_FLOW = '$root'

export type FlowReturnFrame = {
  flowId: string
  returnEdgeId: string | null
}

export type FlowRuntimeState = {
  // Which flow definition is currently executing (ROOT_FLOW or a sub-flow id).
  currentFlowId: string
  currentGroupId: string | null
  // Set when paused on an input block awaiting the user's reply.
  currentBlockId: string | null
  variables: Record<string, unknown>
  // "flowId:groupId:blockId" -> failed-validation count
  retryCounts: Record<string, number>
  // "flowId:groupId" -> times entered (loop guard)
  visitCounts: Record<string, number>
  // Cosmoflow-link return stack: pop on sub-flow completion.
  stack: FlowReturnFrame[]
  // Set while an "AI agent" block holds the conversation: which block, since
  // when (its dialogue is every message after that), and how many customer
  // messages it has answered. Optional so states persisted before the block
  // existed still load.
  agent?: { blockId: string; since: string; turns: number }
}

export type FlowEmission =
  // `ai`: the text was written by a model (AI block), not by the flow author.
  // The desk labels it "AI agent"; scripted lines are labelled "Bot".
  | { kind: 'text'; text: string; ai?: true }
  | { kind: 'interactive'; content: InteractiveContent }
  | {
      kind: 'media'
      mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'
      url: string
      caption: string | null
    }

export type FlowIntent =
  | { type: 'handoff'; message: string | null; teamId: string | null }
  | { type: 'note'; body: string }
  | { type: 'template'; name: string; language: string; params: string[] }

export type FlowInput = { text: string; interactiveReplyId?: string | null }

export type FlowContext = {
  contact?: {
    name?: string | null
    email?: string | null
    phoneNumber?: string | null
  }
  // The account's IANA timezone. `now` and every date comparison read the
  // clock here, so "18:00" means 18:00 for the people who wrote the flow.
  timezone?: string | null
  // Fixed clock for tests and previews; the live runner leaves it unset.
  now?: Date
}

/** The system variable holding the current date and time. */
export const NOW_VARIABLE = 'now'

export type FlowHttpResult = { status: number; body: unknown }

// Side-effect port for blocks that do I/O (integrations). Kept as a narrow
// injectable interface so the engine stays unit-testable (mock it) while the
// FlowRunner wires real, SSRF-guarded implementations. Nebula runs these
// synchronously inline and swallows failures (the flow continues), which we
// mirror.
export type FlowIntegrationResult = {
  // variables to merge into flow state (for downstream branching)
  variables?: Record<string, unknown>
  // optional text to emit to the user
  text?: string
}

/**
 * What an AI block's model call produced.
 *
 * `blocked` is the runner refusing to spend, because the account's AI budget
 * is gone. The engine turns that into a handoff instead of continuing: walking
 * the rest of the flow on an answer the model never gave would branch on an
 * empty variable and leave the customer talking to nobody. The strings come
 * from the runner because only it knows the account's language.
 */
export type FlowLlmResult =
  | { kind: 'text'; text: string }
  | { kind: 'blocked'; message: string; note: string }

/** What the conversational agent of an "AI agent" block said this turn. */
export type FlowAgentResult =
  // `handoff`: the agent asked for a person (the customer wanted one, or the
  // subject is out of its scope and the block says to transfer).
  | { kind: 'reply'; text: string; handoff: boolean }
  // Same meaning as FlowLlmResult's: no budget, or no agent to run.
  | { kind: 'blocked'; message: string; note: string }

export type FlowAgentRequest = {
  agentBotId: string
  // null on the opening turn, when the block has no greeting of its own.
  userText: string | null
  // ISO instant the block took the conversation.
  since: string
  // Author's extra rules for this block (scope, tone, what to collect).
  instructions: string
  // What to do with a question outside the agent's subject.
  offTopic: 'refuse' | 'handoff'
  // Customer messages answered so far, this one included, and the cap.
  turn: number
  maxTurns: number
}

export interface FlowEffects {
  httpRequest(opts: {
    url: string
    method: string
    headers?: Record<string, string>
    body?: string
  }): Promise<FlowHttpResult>
  // LLM call for the OpenAI/AI block. `imageUrls` carries attachments the
  // author routed in via `imageVariableIds`; the runner fetches and encodes
  // them (the engine never does I/O). `silent` tells the runner the reply
  // only feeds a variable and the contact never reads it, which is the one
  // thing it needs to decide whether the call is worth paying for.
  llm(opts: {
    systemPrompt: string
    userText: string
    imageUrls?: string[]
    silent?: boolean
  }): Promise<FlowLlmResult>
  // Provider integrations (Google Sheets, email, Pipefy, ticket ops). The
  // engine stays provider-agnostic; the runner implements each `kind`.
  integration(
    kind: string,
    options: Record<string, unknown>,
    variables: Record<string, unknown>,
  ): Promise<FlowIntegrationResult>
  // Run an author-supplied Code block against the flow variables (exposed as
  // `user`), returning the (possibly mutated) variables. The runner sandboxes
  // this (isolated-vm); the engine never touches the JS itself.
  runCode(
    code: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  // One turn of an AI agent (AgentBot) conducting the conversation from an
  // "AI agent" block. The runner builds its history from the thread.
  agentTurn(opts: FlowAgentRequest): Promise<FlowAgentResult>
}

const NOOP_EFFECTS: FlowEffects = {
  httpRequest: async () => ({ status: 0, body: null }),
  llm: async () => ({ kind: 'text' as const, text: '' }),
  agentTurn: async () => ({ kind: 'reply' as const, text: '', handoff: false }),
  integration: async () => ({}),
  runCode: async (_code, variables) => variables,
}

export type FlowMode = 'STRICT' | 'GUIDED'

// 'deviation' (GUIDED only): the user's input didn't match the current input
// block deterministically — the caller hands the turn to the AI. The state
// keeps `currentBlockId` set so the AI knows which step it's on.
export type FlowStatus = 'waiting' | 'completed' | 'handoff' | 'deviation'

export type FlowStepResult = {
  emissions: FlowEmission[]
  intents: FlowIntent[]
  state: FlowRuntimeState
  status: FlowStatus
}

type Block = Record<string, unknown> & { id: string; type: string }
type Group = { id: string; title?: string; blocks: Block[] }

const MEDIA_TYPES: Record<string, 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  file: 'FILE',
}

const MAX_BLOCKS_PER_RUN = 200
const MAX_GROUP_VISITS = 5
const MAX_INPUT_RETRIES = 3
const MAX_SUBFLOW_DEPTH = 20

// The "AI agent" block: an AgentBot conducts a multi-turn conversation with
// its own persona and knowledge base, then leaves by the block's edge when it
// has answered `maxAiTurns` customer messages or asks for a person.
export const AI_AGENT_BLOCK = 'AI agent'
const DEFAULT_MAX_AI_TURNS = 3

const INPUT_TYPES = new Set([
  'text input',
  'email input',
  'number input',
  'url input',
  'phone number input',
  'phone input',
  'date input',
  'choice input',
  'picture choice input',
  'file input',
  'rating input',
])
const CHOICE_TYPES = new Set(['choice input', 'picture choice input'])
// Heads of a V1 "composite step" (see `companionInput`). `rating input` isn't
// a CHOICE_TYPE here (it takes a typed answer), but V1 paired it the same way.
const COMPOSITE_HEAD_TYPES = new Set([
  'choice input',
  'picture choice input',
  'rating input',
])

export function emptyFlowState(): FlowRuntimeState {
  return {
    currentFlowId: ROOT_FLOW,
    stack: [],
    currentGroupId: null,
    currentBlockId: null,
    variables: {},
    retryCounts: {},
    visitCounts: {},
  }
}

// WhatsApp interactive limits (Meta, 2026): reply buttons cap at 3 with
// 20-char titles; above that the message must be a list, capped at 10 rows
// with 24-char titles.
const WA_MAX_BUTTONS = 3
const WA_MAX_LIST_ROWS = 10
const WA_BUTTON_LABEL_MAX = 20
// Body caps differ by shape: reply buttons take 1024 chars, lists take 4096.
const WA_BUTTONS_BODY_MAX = 1024
const WA_LIST_BODY_MAX = 4096
const WA_LIST_ROW_TITLE_MAX = 24

export class FlowEngine {
  private readonly effects: FlowEffects
  // flowId → definition. Root under ROOT_FLOW; Cosmoflow-link sub-flows under
  // their cosmoflowId.
  private readonly defs = new Map<string, FlowDefinition>()
  // Sub-flow ids that are really the entry flow itself (see the constructor).
  private readonly rootAliases = new Set<string>()

  constructor(
    private readonly def: FlowDefinition,
    // GUIDED: a non-matching reply yields a `deviation` for the AI to handle,
    // instead of STRICT's retry/give-up.
    private readonly mode: FlowMode = 'STRICT',
    // Partial effects are merged over no-op defaults, so callers (and tests)
    // only supply the ports they exercise.
    effects: Partial<FlowEffects> = {},
    // Sub-flow definitions referenced by Cosmoflow-link blocks (cosmoflowId →
    // def). Enables cross-flow composition.
    subFlows: Map<string, FlowDefinition> = new Map(),
  ) {
    this.effects = { ...NOOP_EFFECTS, ...effects }
    for (const [id, d] of subFlows) {
      this.defs.set(id, d)
      // The entry flow is usually also reachable as a sub-flow (its own
      // cosmoflowId). Registered twice it looks like two different flows, so
      // the cycle guard below would never fire on root ⇄ sub recursion. The
      // runner hands us the SAME parsed object for that id, so identity is
      // what tells them apart.
      if (d === def) this.rootAliases.add(id)
    }
    this.defs.set(ROOT_FLOW, def)
  }

  /** Collapse an entry flow's own id onto ROOT_FLOW. */
  private canonicalFlowId(flowId: string): string {
    return this.rootAliases.has(flowId) ? ROOT_FLOW : flowId
  }

  private groupsOf(flowId: string): Group[] {
    return (this.defs.get(flowId)?.groups ?? []) as unknown as Group[]
  }
  private edgesOf(flowId: string): FlowDefinition['edges'] {
    return this.defs.get(flowId)?.edges ?? []
  }
  private startGroupOf(flowId: string): string | null {
    const d = this.defs.get(flowId)
    return d?.startGroupId ?? (d?.groups[0] as { id?: string } | undefined)?.id ?? null
  }

  /** Begin the flow at its start group. */
  async start(
    ctx: FlowContext = {},
    initialVars: Record<string, unknown> = {},
  ): Promise<FlowStepResult> {
    const state = emptyFlowState()
    state.variables = { ...initialVars }
    const startId = this.startGroupOf(ROOT_FLOW)
    if (!startId) {
      return { emissions: [], intents: [], state, status: 'completed' }
    }
    return this.runFrom(state, ctx, startId)
  }

  /** Resume after the user replied to the input block we paused on. */
  async resume(
    state: FlowRuntimeState,
    input: FlowInput,
    ctx: FlowContext = {},
  ): Promise<FlowStepResult> {
    const acc = newAcc()
    if (!state.currentGroupId || !state.currentBlockId) {
      // No pending input — nothing to resume.
      return finish(acc, state, 'completed')
    }
    const group = this.group(state.currentFlowId, state.currentGroupId)
    const block = group?.blocks.find((b) => b.id === state.currentBlockId)
    if (!group || !block) return finish(acc, state, 'completed')
    // An AI agent answers whatever the customer says: nothing to validate.
    if (block.type === AI_AGENT_BLOCK) return this.agentStep(block, group, input.text, state, ctx, acc)

    const routed = this.processReply(block, group, input, state, ctx, acc)
    if (routed.kind === 'wait') {
      return finish(acc, state, 'waiting')
    }
    if (routed.kind === 'deviation') {
      // Keep currentBlockId set so the AI knows which step we're on.
      return finish(acc, state, 'deviation')
    }
    state.currentBlockId = null
    if (routed.kind === 'edge') return this.followEdge(state, ctx, routed.edgeId, acc)
    if (routed.kind === 'resumeAfter') {
      return this.runFromBlock(state, ctx, group, indexOf(group, routed.blockId) + 1, acc)
    }
    // 'continue' → block's own edge, else next block in the group
    const edgeId = this.blockEdgeId(block, state)
    if (edgeId) return this.followEdge(state, ctx, edgeId, acc)
    return this.runFromBlock(state, ctx, group, indexOf(group, block.id) + 1, acc)
  }

  // ─── walk ───────────────────────────────────────────────────────────

  private async runFrom(
    state: FlowRuntimeState,
    ctx: FlowContext,
    groupId: string,
    startBlockId?: string,
    acc = newAcc(),
  ): Promise<FlowStepResult> {
    const group = this.group(state.currentFlowId, groupId)
    if (!group) return this.complete(state, ctx, acc)
    state.currentGroupId = groupId
    const visitKey = `${state.currentFlowId}:${groupId}`
    state.visitCounts[visitKey] = (state.visitCounts[visitKey] ?? 0) + 1
    if (state.visitCounts[visitKey] > MAX_GROUP_VISITS) {
      return this.complete(state, ctx, acc)
    }
    const startIdx = startBlockId ? Math.max(0, indexOf(group, startBlockId)) : 0
    return this.runFromBlock(state, ctx, group, startIdx, acc)
  }

  private async runFromBlock(
    state: FlowRuntimeState,
    ctx: FlowContext,
    group: Group,
    startIdx: number,
    acc: Acc,
  ): Promise<FlowStepResult> {
    for (let i = startIdx; i < group.blocks.length; i += 1) {
      if (++acc.steps > MAX_BLOCKS_PER_RUN) return this.complete(state, ctx, acc)
      const block = group.blocks[i]!
      if (block.type === AI_AGENT_BLOCK) return this.enterAgent(block, group, state, ctx, acc)
      if (INPUT_TYPES.has(block.type)) {
        this.emitInputPrompt(block, state, ctx, acc)
        state.currentGroupId = group.id
        state.currentBlockId = block.id
        return finish(acc, state, 'waiting')
      }
      const outcome = await this.executeBlock(block, state, ctx, acc)
      if (outcome.kind === 'complete') return this.complete(state, ctx, acc)
      if (outcome.kind === 'handoff') {
        acc.intents.push({
          type: 'handoff',
          message: outcome.message,
          teamId: outcome.teamId,
        })
        state.currentBlockId = null
        return finish(acc, state, 'handoff')
      }
      if (outcome.kind === 'edge') return this.followEdge(state, ctx, outcome.edgeId, acc)
      if (outcome.kind === 'jump') return this.runFrom(state, ctx, outcome.groupId, undefined, acc)
      if (outcome.kind === 'subflow') return this.enterSubFlow(state, ctx, outcome, acc)
      // continue: block's own edge wins, else fall through to next block
      const edgeId = this.blockEdgeId(block, state)
      if (edgeId) return this.followEdge(state, ctx, edgeId, acc)
    }
    // ran off the end of the group with no outgoing edge → flow ends
    return this.complete(state, ctx, acc)
  }

  // ─── AI agent block ─────────────────────────────────────────────────

  /**
   * The flow reaches an AI agent: it takes the conversation from here. With
   * a greeting the block says it and waits; without one the agent opens in
   * character, so the customer is never left looking at silence.
   */
  private async enterAgent(
    block: Block,
    group: Group,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): Promise<FlowStepResult> {
    state.agent = { blockId: block.id, since: this.clock(ctx).toISOString(), turns: 0 }
    state.currentGroupId = group.id
    state.currentBlockId = block.id
    const greeting = this.interpolate(asString(opt(block, 'greeting')) ?? '', state, ctx)
    if (greeting) {
      acc.emissions.push({ kind: 'text', text: greeting })
      return finish(acc, state, 'waiting')
    }
    return this.agentStep(block, group, null, state, ctx, acc)
  }

  /**
   * One agent turn. The limit is deterministic: once the agent has answered
   * `maxAiTurns` customer messages the flow leaves by the block's edge in the
   * same turn, whatever the model would have liked to do next. 0 = no limit.
   */
  private async agentStep(
    block: Block,
    group: Group,
    userText: string | null,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): Promise<FlowStepResult> {
    // A state saved by an older engine may lack the record: start one now.
    const agent =
      state.agent?.blockId === block.id
        ? state.agent
        : { blockId: block.id, since: this.clock(ctx).toISOString(), turns: 0 }
    state.agent = agent
    if (userText !== null) agent.turns += 1
    const maxTurns = maxAiTurns(block)
    let result: FlowAgentResult
    try {
      result = await this.effects.agentTurn({
        agentBotId: asString(opt(block, 'agentBotId')) ?? '',
        userText,
        since: agent.since,
        instructions: this.interpolate(asString(opt(block, 'instructions')) ?? '', state, ctx),
        offTopic: opt(block, 'offTopic') === 'handoff' ? 'handoff' : 'refuse',
        turn: agent.turns,
        maxTurns,
      })
    } catch {
      // No answer is worse than a transfer: leave by the exit.
      result = { kind: 'reply', text: '', handoff: true }
    }
    if (result.kind === 'blocked') {
      // Budget gone or agent missing: straight to a person, like the AI block,
      // to the team the author chose for this block when there is one.
      acc.intents.push({ type: 'note', body: result.note })
      delete state.agent
      state.currentBlockId = null
      acc.intents.push({ type: 'handoff', message: result.message, teamId: asString(opt(block, 'teamId')) })
      return finish(acc, state, 'handoff')
    }
    if (result.text) acc.emissions.push({ kind: 'text', text: result.text, ai: true })
    const limitReached = maxTurns > 0 && agent.turns >= maxTurns
    if (result.handoff || limitReached) return this.exitAgent(block, group, state, ctx, acc)
    return finish(acc, state, 'waiting')
  }

  /**
   * Leave the agent like any other block leaves: by its edge when the author
   * drew one (usually a transfer group), else the next block of the group,
   * else back to the parent flow. Only at the very end of the entry flow does
   * it hand straight to a person: completing there would give the customer
   * back to an AI that was just capped. Same conversation, whole history.
   */
  private async exitAgent(
    block: Block,
    group: Group,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): Promise<FlowStepResult> {
    delete state.agent
    state.currentBlockId = null
    const edgeId = this.blockEdgeId(block, state)
    if (edgeId) return this.followEdge(state, ctx, edgeId, acc)
    const next = indexOf(group, block.id) + 1
    if (next < group.blocks.length) return this.runFromBlock(state, ctx, group, next, acc)
    if (state.stack.length > 0) return this.complete(state, ctx, acc)
    const message = this.interpolate(asString(opt(block, 'handoffMessage')) ?? '', state, ctx) || null
    acc.intents.push({ type: 'handoff', message, teamId: asString(opt(block, 'teamId')) })
    return finish(acc, state, 'handoff')
  }

  /** Enter a Cosmoflow-link sub-flow: push a return frame, run its start. */
  private async enterSubFlow(
    state: FlowRuntimeState,
    ctx: FlowContext,
    outcome: { subId: string; returnEdgeId: string | null },
    acc: Acc,
  ): Promise<FlowStepResult> {
    const subId = this.canonicalFlowId(outcome.subId)
    if (state.stack.length >= MAX_SUBFLOW_DEPTH) {
      return this.complete(state, ctx, acc)
    }
    // Cycle guard. Two migrated flows that link to each other ("Boas vindas"
    // ⇄ "Ações de Templates") build a stack MAX_SUBFLOW_DEPTH deep, and the
    // unwind re-runs every frame's return edge — which walks back through the
    // greeting groups and sends the welcome message again instead of the
    // answer. Skip a link into a flow already running and carry on past it.
    if (subId === state.currentFlowId || state.stack.some((f) => f.flowId === subId)) {
      return outcome.returnEdgeId
        ? this.followEdge(state, ctx, outcome.returnEdgeId, acc)
        : this.complete(state, ctx, acc)
    }
    state.stack.push({
      flowId: state.currentFlowId,
      returnEdgeId: outcome.returnEdgeId,
    })
    state.currentFlowId = subId
    const startId = this.startGroupOf(subId)
    // empty sub-flow → unwind immediately (pop + follow the return edge)
    if (!startId) return this.complete(state, ctx, acc)
    return this.runFrom(state, ctx, startId, undefined, acc)
  }

  private async followEdge(
    state: FlowRuntimeState,
    ctx: FlowContext,
    edgeId: string,
    acc: Acc,
  ): Promise<FlowStepResult> {
    const edge = this.edgesOf(state.currentFlowId).find((e) => e.id === edgeId)
    if (!edge) return this.complete(state, ctx, acc)
    return this.runFrom(state, ctx, edge.to.groupId, edge.to.blockId ?? undefined, acc)
  }

  /**
   * End of the current flow. If we're inside a sub-flow, pop the return frame
   * and resume the parent via the return edge; otherwise the whole flow is done.
   */
  private async complete(
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): Promise<FlowStepResult> {
    const frame = state.stack.pop()
    if (frame) {
      state.currentFlowId = frame.flowId
      if (frame.returnEdgeId) return this.followEdge(state, ctx, frame.returnEdgeId, acc)
      return this.complete(state, ctx, acc)
    }
    state.currentFlowId = ROOT_FLOW
    state.currentGroupId = null
    state.currentBlockId = null
    return finish(acc, state, 'completed')
  }

  // ─── block execution (non-input) ─────────────────────────────────────

  private async executeBlock(
    block: Block,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): Promise<BlockOutcome> {
    switch (block.type) {
      case 'text': {
        const text = this.interpolate(textOf(block), state, ctx)
        if (text) acc.emissions.push({ kind: 'text', text })
        return { kind: 'continue' }
      }
      // A document (a PDF guide, a form): the channel sends the file itself,
      // under the name in its URL, where the others play or show it.
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        const url = this.interpolate(
          asString(opt(block, 'url')) ?? asString(opt(block, 'src')) ?? '',
          state,
          ctx,
        )
        if (!url) return { kind: 'continue' }
        const caption =
          this.interpolate(asString(opt(block, 'caption')) ?? '', state, ctx) ||
          null
        const mediaType = MEDIA_TYPES[block.type]!
        acc.emissions.push({ kind: 'media', mediaType, url, caption })
        return { kind: 'continue' }
      }
      case 'embed': {
        // No native chat embed — send the URL as text.
        const url = this.interpolate(asString(opt(block, 'url')) ?? '', state, ctx)
        if (url) acc.emissions.push({ kind: 'text', text: url })
        return { kind: 'continue' }
      }
      case 'cards': {
        // Carousel: emit each card's title as text (rich carousel rendering is
        // a channel follow-up).
        for (const it of asArray(opt(block, 'items'))) {
          const title = this.interpolate(
            asString((it as Record<string, unknown>).title) ?? '',
            state,
            ctx,
          )
          if (title) acc.emissions.push({ kind: 'text', text: title })
        }
        return { kind: 'continue' }
      }
      case 'Set variable': {
        const varId = asString(opt(block, 'variableId'))
        if (varId) {
          state.variables[varId] = this.interpolate(
            asString(opt(block, 'value')) ?? '',
            state,
            ctx,
          )
        }
        return { kind: 'continue' }
      }
      case 'Condition': {
        const edgeId = this.evalCondition(block, state, ctx)
        return edgeId ? { kind: 'edge', edgeId } : { kind: 'continue' }
      }
      case 'Jump': {
        const groupId = asString(opt(block, 'groupId'))
        return groupId ? { kind: 'jump', groupId } : { kind: 'continue' }
      }
      case 'note': {
        const body = this.interpolate(asString(opt(block, 'content')) ?? '', state, ctx)
        if (body) acc.intents.push({ type: 'note', body })
        return { kind: 'continue' }
      }
      case 'Cosmodesk':
      case 'cosmodesk': {
        // V1/V3 dual-form keys (project_v3_cosmodesk_v1_dual_form).
        const message =
          this.interpolate(
            asString(opt(block, 'assigningMessage')) ??
              asString(opt(block, 'message')) ??
              '',
            state,
            ctx,
          ) || null
        const teamId =
          asString(opt(block, 'teamId')) ?? asString(opt(block, 'team')) ?? null
        return { kind: 'handoff', message, teamId }
      }
      case 'end-session': {
        const msg = this.interpolate(asString(opt(block, 'message')) ?? '', state, ctx)
        if (msg) acc.emissions.push({ kind: 'text', text: msg })
        return { kind: 'complete' }
      }
      case 'Webhook':
      case 'webhook':
      case 'api_call':
      case 'API call': {
        // HTTP integration: call out, store the response into variables so
        // downstream Condition blocks can branch on it. Failures are swallowed
        // (status 0) and the flow continues — matching Nebula.
        const url = this.interpolate(asString(opt(block, 'url')) ?? '', state, ctx)
        if (!url) return { kind: 'continue' }
        const method = (asString(opt(block, 'method')) ?? 'POST').toUpperCase()
        const headers = this.resolveStringMap(opt(block, 'headers'), state, ctx)
        const bodyTpl = asString(opt(block, 'body'))
        const body = bodyTpl ? this.interpolate(bodyTpl, state, ctx) : undefined
        let result: FlowHttpResult
        try {
          result = await this.effects.httpRequest({ url, method, headers, body })
        } catch {
          result = { status: 0, body: null }
        }
        const mapping = opt(block, 'responseMapping') as
          | Record<string, unknown>
          | undefined
        const mapVar =
          asString(mapping?.variableId) ??
          asString(opt(block, 'responseVariableId'))
        if (mapVar) state.variables[mapVar] = result.body
        state.variables.response = result.body
        state.variables.status_code = result.status
        return { kind: 'continue' }
      }
      case 'OpenAI':
      case 'openai': {
        const userText = this.interpolate(
          asString(opt(block, 'prompt')) ?? asString(opt(block, 'message')) ?? '',
          state,
          ctx,
        )
        if (!userText) return { kind: 'continue' }
        const systemPrompt = this.interpolate(
          asString(opt(block, 'systemPrompt')) ?? '',
          state,
          ctx,
        )
        // Vision: `imageVariableIds` names variables holding attachment URLs
        // (typically saved by a file input block). A variable may hold one
        // URL or a list.
        const imageUrls = asArray(opt(block, 'imageVariableIds'))
          .flatMap((name) => {
            const v = state.variables[asString(name) ?? '']
            return Array.isArray(v) ? v : [v]
          })
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter((v) => v.length > 0)

        // Silent mode: the block acts as an internal classifier — the reply
        // lands in a variable for a downstream Condition and the customer
        // never sees it. Defaults to sending, so existing flows are unchanged.
        // Decided before the call, because the runner gates paid replies the
        // contact would read and lets silent classifiers through.
        const silent = opt(block, 'sendMessage') === false
        let result: FlowLlmResult = { kind: 'text', text: '' }
        try {
          result = await this.effects.llm({
            systemPrompt,
            userText,
            silent,
            ...(imageUrls.length > 0 ? { imageUrls } : {}),
          })
        } catch {
          result = { kind: 'text', text: '' }
        }
        if (result.kind === 'blocked') {
          acc.intents.push({ type: 'note', body: result.note })
          return { kind: 'handoff', message: result.message, teamId: null }
        }
        const reply = result.text
        const mapping = opt(block, 'responseMapping') as
          | Record<string, unknown>
          | undefined
        const mapVar =
          asString(mapping?.variableId) ??
          asString(opt(block, 'responseVariableId'))
        if (mapVar) state.variables[mapVar] = reply
        if (reply && !silent) acc.emissions.push({ kind: 'text', text: reply, ai: true })
        return { kind: 'continue' }
      }
      case 'Redirect':
      case 'Webview': {
        // No native in-chat redirect/webview — send the URL as text.
        const url = this.interpolate(asString(opt(block, 'url')) ?? '', state, ctx)
        if (url) acc.emissions.push({ kind: 'text', text: url })
        return { kind: 'continue' }
      }
      case 'Wait': {
        // Durable delays need a scheduler (follow-up); for now continue
        // immediately so the flow doesn't stall.
        return { kind: 'continue' }
      }
      case 'AB test': {
        const edgeId = this.pickAbTestEdge(block, state)
        return edgeId ? { kind: 'edge', edgeId } : { kind: 'continue' }
      }
      case 'Cosmoflow link': {
        // Cross-flow: enter the referenced sub-flow (registered by cosmoflowId)
        // and resume the parent via this block's outgoing edge on completion.
        const subId = asString(opt(block, 'cosmoflowId'))
        if (subId && this.defs.has(subId)) {
          return {
            kind: 'subflow',
            subId,
            returnEdgeId: this.blockEdgeId(block, state),
          }
        }
        // Legacy intra-flow link → jump to a group in the current flow.
        const groupId = asString(opt(block, 'groupId'))
        return groupId && this.group(state.currentFlowId, groupId)
          ? { kind: 'jump', groupId }
          : { kind: 'continue' }
      }
      case 'WhatsApp Template': {
        const name = asString(opt(block, 'name')) ?? asString(opt(block, 'templateName'))
        if (!name) return { kind: 'continue' }
        const language = asString(opt(block, 'language')) ?? 'pt_BR'
        const params = asArray(opt(block, 'params') ?? opt(block, 'variables')).map(
          (p) => this.interpolate(typeof p === 'string' ? p : String(p ?? ''), state, ctx),
        )
        acc.intents.push({ type: 'template', name, language, params })
        return { kind: 'continue' }
      }
      case 'Google Sheets':
      case 'Email':
      case 'Pipefy':
      case 'Ticket Create':
      case 'Ticket Update':
      case 'Ticket Query': {
        // Provider integrations: the runner owns the provider wiring; the
        // engine merges any returned variables + emits any returned text.
        // Options are interpolated first — migrated blocks carry `{{var}}`
        // placeholders in email bodies, ticket subjects and the like, and the
        // runner has no access to flow state to expand them itself.
        const options = this.interpolateDeep(
          (block.options ?? block) as Record<string, unknown>,
          state,
          ctx,
        ) as Record<string, unknown>
        let result: FlowIntegrationResult
        try {
          result = await this.effects.integration(block.type, options, state.variables)
        } catch {
          result = {}
        }
        if (result.variables) Object.assign(state.variables, result.variables)
        if (result.text) acc.emissions.push({ kind: 'text', text: result.text })
        return { kind: 'continue' }
      }
      case 'Code':
      case 'Script': {
        // Author JS, sandboxed by the runner (isolated-vm) via runCode. It
        // sees the flow variables as `user` and may mutate them. Failures are
        // swallowed so the flow continues with the prior variables.
        const code =
          asString(opt(block, 'content')) ?? asString(opt(block, 'code')) ?? ''
        if (!code) return { kind: 'continue' }
        try {
          state.variables = await this.effects.runCode(code, state.variables)
        } catch {
          /* sandbox error — keep existing variables, continue */
        }
        return { kind: 'continue' }
      }
      default:
        // Unknown block type: skip it so the flow continues.
        return { kind: 'continue' }
    }
  }

  /** Interpolate the string values of an options map (e.g. webhook headers). */
  /**
   * Interpolate every string reachable in a value, keeping the shape intact.
   * Non-strings (numbers, booleans, null) pass through untouched, so an
   * `isHtml: false` stays a boolean rather than becoming "false".
   */
  private interpolateDeep(
    v: unknown,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): unknown {
    if (typeof v === 'string') return this.interpolate(v, state, ctx)
    if (Array.isArray(v)) return v.map((e) => this.interpolateDeep(e, state, ctx))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = this.interpolateDeep(val, state, ctx)
      }
      return out
    }
    return v
  }

  private resolveStringMap(
    v: unknown,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): Record<string, string> | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = this.interpolate(val, state, ctx)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  // ─── input blocks ─────────────────────────────────────────────────────

  private emitInputPrompt(
    block: Block,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): void {
    if (!CHOICE_TYPES.has(block.type)) return // typed inputs just wait
    // `opt` falls back to the block itself, so this reads both the native
    // shape (options.items) and the V1 export shape (items at block level).
    const items = asArray(opt(block, 'items'))
    const choices = items.map((it) => {
      const item = it as Record<string, unknown>
      return {
        id: asString(item.id) ?? asString(item.outgoingEdgeId) ?? '',
        label: this.interpolate(asString(item.content) ?? '', state, ctx) || '·',
      }
    })
    if (choices.length === 0) return

    // A menu's body: the block's own message when it has one, otherwise the
    // text bubble immediately before it — V1-exported flows put the question
    // in a separate text block, which would otherwise leave the menu showing
    // a bare "·" placeholder next to it. Folding them also drops one billable
    // message per menu, which matters from 2026-10-01 when Meta starts
    // charging per message inside the 24h window.
    let body = this.interpolate(asString(opt(block, 'message')) ?? '', state, ctx)
    const cap = choices.length <= WA_MAX_BUTTONS ? WA_BUTTONS_BODY_MAX : WA_LIST_BODY_MAX
    if (!body) {
      const prev = acc.emissions[acc.emissions.length - 1]
      // Only fold when it fits the shape's cap — a fused menu Meta rejects
      // would take the question down with it.
      if (prev && prev.kind === 'text' && prev.text.length <= cap) {
        body = prev.text
        acc.emissions.pop()
      }
    }
    body = body.slice(0, cap) || '·'

    // WhatsApp reply buttons top out at 3. Above that the message has to be a
    // list, which Meta caps at 10 rows — an 11-row list is rejected outright,
    // so trim rather than let the whole prompt fail. Sending the first 3 as
    // buttons (the old behaviour) silently hid every option past the third.
    if (choices.length <= WA_MAX_BUTTONS) {
      acc.emissions.push({
        kind: 'interactive',
        content: {
          kind: 'buttons',
          body,
          buttons: choices.map((c) => ({
            ...c,
            label: c.label.slice(0, WA_BUTTON_LABEL_MAX),
          })),
        },
      })
      return
    }
    acc.emissions.push({
      kind: 'interactive',
      content: {
        kind: 'list',
        body,
        buttonText: (
          asString(opt(block, 'listButtonText')) ?? 'Menu'
        ).slice(0, WA_BUTTON_LABEL_MAX),
        sections: [
          {
            rows: choices.slice(0, WA_MAX_LIST_ROWS).map((c) => ({
              id: c.id,
              title: c.label.slice(0, WA_LIST_ROW_TITLE_MAX),
            })),
          },
        ],
      },
    })
  }

  private processReply(
    block: Block,
    group: Group,
    input: FlowInput,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): ReplyRoute {
    if (CHOICE_TYPES.has(block.type)) {
      return this.processChoice(block, group, input, state, ctx, acc)
    }
    return this.processTypedInput(block, group, input, state, acc)
  }

  private processChoice(
    block: Block,
    group: Group,
    input: FlowInput,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): ReplyRoute {
    // `opt` already falls back to the block itself, so this covers both the
    // native shape (options.items) and the V1 export shape (items).
    const items = asArray(opt(block, 'items')) as Array<Record<string, unknown>>
    const replyId = input.interactiveReplyId ?? null
    const text = input.text.trim().toLowerCase()
    // Match on the selected id (item id or edge id — WA dual-match), else label.
    const item =
      (replyId &&
        items.find(
          (it) =>
            asString(it.id) === replyId || asString(it.outgoingEdgeId) === replyId,
        )) ||
      items.find(
        (it) => (asString(it.content) ?? '').trim().toLowerCase() === text,
      )
    if (item) {
      // Store what they picked. A choice block carries a variableId just like
      // a text input does, and without this every downstream reference —
      // Conditions, a Ticket Create subject, an email body — reads empty.
      // Prefer the machine-readable `value` ("bug") over the label ("🐛 Bug"),
      // which is what a Condition would be written against.
      const varId = asString(opt(block, 'variableId'))
      if (varId) {
        state.variables[varId] =
          asString(item.value) ?? asString(item.content) ?? ''
      }
      const companion = companionInput(block, group)
      if (companion) this.fillCompanion(companion, input.text.trim(), state)
      const edgeId = this.itemEdgeId(item, state)
      if (edgeId) return { kind: 'edge', edgeId }
      // No per-item route: a composite hands over to its trailing input's
      // route (the Condition chain the flow branches on), skipping the input
      // itself — the customer already answered.
      return companion ? this.afterCompanion(companion, state) : { kind: 'continue' }
    }
    // No button matched. A composite whose answer the flow never branches on
    // is an open question with shortcut buttons: "your website, please, or
    // tap 'I don't have one'". What they typed IS the answer, as in Nebula.
    // Treating it as off-script asked a lead to pick between buttons after
    // he had typed exactly what was asked (conversation 8741, 2026-10-13).
    // A menu's answer is read by a Condition, so a menu still deviates.
    const companion = companionInput(block, group)
    const typed = input.text.trim()
    if (companion && typed && this.isOpenAnswer(companion)) {
      this.fillCompanion(companion, typed, state)
      this.resetRetry(state, block)
      return this.afterCompanion(companion, state)
    }
    // No match: GUIDED hands to the AI; STRICT retries / gives up.
    if (this.mode === 'GUIDED') return { kind: 'deviation' }
    return this.retryOrFail(block, state, ctx, acc)
  }

  /**
   * True when no Condition in any loaded flow compares this input's variable:
   * the buttons are then shortcuts for a free answer, not a menu to branch on.
   */
  private isOpenAnswer(companion: Block): boolean {
    const varId = asString(opt(companion, 'variableId'))
    if (!varId) return false
    for (const d of this.defs.values()) {
      for (const g of d.groups as unknown as Group[]) {
        for (const b of g.blocks) {
          if (b.type !== 'Condition') continue
          const items = asArray(opt(b, 'items') ?? (b as Record<string, unknown>).items) as Array<
            Record<string, unknown>
          >
          for (const item of items) {
            const content = (
              item.content && typeof item.content === 'object' ? item.content : {}
            ) as Record<string, unknown>
            const comparisons = [
              ...(asArray(item.comparisons) as Array<Record<string, unknown>>),
              ...(asArray(content.comparisons) as Array<Record<string, unknown>>),
            ]
            if (comparisons.some((c) => asString(c.variableId) === varId)) return false
          }
        }
      }
    }
    return true
  }

  /** The composite's answer belongs to the trailing input's variable. */
  private fillCompanion(
    companion: Block,
    value: string,
    state: FlowRuntimeState,
  ): void {
    const varId = asString(opt(companion, 'variableId'))
    if (varId) state.variables[varId] = value
  }

  /** Leave a composite by its trailing input's route, never stopping on it. */
  private afterCompanion(companion: Block, state: FlowRuntimeState): ReplyRoute {
    const edgeId = this.blockEdgeId(companion, state)
    return edgeId ? { kind: 'edge', edgeId } : { kind: 'resumeAfter', blockId: companion.id }
  }

  /**
   * The outgoing edge for a matched choice / condition / A-B item: the item's
   * own `outgoingEdgeId`, else an edge anchored to it via `from.itemId` in the
   * current flow. Migrated Typebot flows store the branch only on the edge
   * (~65% of choice items here), so the fallback keeps those branches live.
   */
  /**
   * The edge leaving a block.
   *
   * Native blocks carry `outgoingEdgeId`. Typebot/V1-exported flows don't —
   * they declare the link on the edge instead, as `edges[].from.blockId`.
   * Without this fallback such a flow runs its first group and then "ends"
   * silently at the first block that has no inline edge: the customer answers
   * one question and the conversation stops. `itemEdgeId` already does the
   * same lookup for choice items; this is the block-level twin.
   *
   * Edges that also carry an `itemId` belong to a specific choice option, not
   * to the block as a whole, so they're skipped here.
   */
  private blockEdgeId(
    block: Block,
    state: FlowRuntimeState,
  ): string | null {
    const direct = asString(block.outgoingEdgeId)
    if (direct) return direct
    const e = this.edgesOf(state.currentFlowId).find((edge) => {
      const from = edge.from as Record<string, unknown>
      return asString(from.blockId) === block.id && !asString(from.itemId)
    })
    return e ? e.id : null
  }

  private itemEdgeId(
    item: Record<string, unknown>,
    state: FlowRuntimeState,
  ): string | null {
    const direct = asString(item.outgoingEdgeId)
    if (direct) return direct
    const id = asString(item.id)
    if (!id) return null
    const e = this.edgesOf(state.currentFlowId).find(
      (edge) => asString((edge.from as Record<string, unknown>).itemId) === id,
    )
    return e ? e.id : null
  }

  private processTypedInput(
    block: Block,
    group: Group,
    input: FlowInput,
    state: FlowRuntimeState,
    acc: Acc,
  ): ReplyRoute {
    const value = input.text.trim()
    if (this.validateInput(block.type, value)) {
      const varId = asString(opt(block, 'variableId'))
      if (varId) state.variables[varId] = value
      this.resetRetry(state, block)
      // `rating input` is the other V1 composite head: it too can carry a
      // trailing text input that owns the variable and the route.
      const companion = companionInput(block, group)
      if (companion) {
        this.fillCompanion(companion, value, state)
        return this.afterCompanion(companion, state)
      }
      return { kind: 'continue' }
    }
    if (this.mode === 'GUIDED') return { kind: 'deviation' }
    return this.retryOrFail(block, state, {}, acc)
  }

  private validateInput(type: string, value: string): boolean {
    if (value.length === 0) return false
    switch (type) {
      case 'email input':
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
      case 'number input':
        return !Number.isNaN(Number(value))
      case 'phone number input':
      case 'phone input':
        return /^[+0-9()\-\s]{6,}$/.test(value)
      case 'url input':
        try {
          new URL(value)
          return true
        } catch {
          return false
        }
      default:
        return true // free text / date — accept
    }
  }

  private retryOrFail(
    block: Block,
    state: FlowRuntimeState,
    ctx: FlowContext,
    acc: Acc,
  ): ReplyRoute {
    const key = `${state.currentFlowId}:${state.currentGroupId}:${block.id}`
    const count = (state.retryCounts[key] ?? 0) + 1
    state.retryCounts[key] = count
    if (count > MAX_INPUT_RETRIES) {
      this.resetRetry(state, block)
      // Give up the strict path: follow the block's edge if any, else continue.
      const edgeId = this.blockEdgeId(block, state)
      return edgeId ? { kind: 'edge', edgeId } : { kind: 'continue' }
    }
    const retryMsg = this.interpolate(asString(opt(block, 'retryMessage')) ?? '', state, ctx)
    if (retryMsg) acc.emissions.push({ kind: 'text', text: retryMsg })
    return { kind: 'wait' }
  }

  private resetRetry(state: FlowRuntimeState, block: Block): void {
    delete state.retryCounts[`${state.currentFlowId}:${state.currentGroupId}:${block.id}`]
  }

  // ─── condition + interpolation ────────────────────────────────────────

  /** Weighted random pick of an A/B-test item's edge. */
  private pickAbTestEdge(block: Block, state: FlowRuntimeState): string | null {
    const weighted = (asArray(opt(block, 'items')) as Array<Record<string, unknown>>)
      .map((it) => ({
        edgeId: this.itemEdgeId(it, state),
        weight: Number(it.weight ?? it.percentage ?? 1) || 0,
      }))
      .filter((w): w is { edgeId: string; weight: number } => Boolean(w.edgeId))
    if (weighted.length === 0) return null
    const total = weighted.reduce((s, w) => s + w.weight, 0)
    if (total <= 0) return weighted[0]!.edgeId
    let point = Math.random() * total
    // Check all but the last bucket; the last is the natural fall-through.
    for (let i = 0; i < weighted.length - 1; i += 1) {
      point -= weighted[i]!.weight
      if (point < 0) return weighted[i]!.edgeId
    }
    return weighted[weighted.length - 1]!.edgeId
  }

  private evalCondition(
    block: Block,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): string | null {
    // Nebula business-hours gate: instead of comparisons, the block carries a
    // weekly schedule + timezone (`conditionType: 'business_hours'`). Its
    // single item is the "open" branch; the block's own outgoingEdgeId is the
    // closed/else branch. Without this, the item never matches and every
    // customer lands on the out-of-hours path regardless of the clock.
    if (asString(opt(block, 'conditionType')) === 'business_hours') {
      const open = isWithinBusinessHours(
        opt(block, 'businessHours') as Record<string, unknown> | undefined,
        asString(opt(block, 'timezone')) ?? 'UTC',
        this.clock(ctx),
      )
      if (!open) return null
      // Migrated blocks keep `items` at block level while `options` carries
      // the schedule — opt() stops at options, so fall through explicitly.
      const first = (
        asArray(
          opt(block, 'items') ?? (block as Record<string, unknown>).items,
        ) as Array<Record<string, unknown>>
      )[0]
      return first ? this.itemEdgeId(first, state) : null
    }
    const items = asArray(opt(block, 'items')) as Array<Record<string, unknown>>
    for (const item of items) {
      // Comparisons live flat on the item (builder-authored) or nested under
      // item.content (the Typebot/V1-import shape — 179/179 migrated items).
      const content = (
        item.content && typeof item.content === 'object' ? item.content : {}
      ) as Record<string, unknown>
      const flat = asArray(item.comparisons) as Array<Record<string, unknown>>
      const comparisons =
        flat.length > 0 ? flat : (asArray(content.comparisons) as Array<Record<string, unknown>>)
      const logical = (
        asString(item.logicalOperator) ??
        asString(content.logicalOperator) ??
        'AND'
      ).toUpperCase()
      let matched: boolean
      if (comparisons.length === 0) {
        // Nebula parity: an item with NO comparisons matches unconditionally,
        // unless the block carries a weekly schedule — then the item is the
        // "open" branch of a business-hours gate.
        const bh = opt(block, 'businessHours')
        matched =
          bh && typeof bh === 'object'
            ? isWithinBusinessHours(
                bh as Record<string, unknown>,
                asString(opt(block, 'timezone')) ?? 'UTC',
                this.clock(ctx),
              )
            : true
      } else {
        const results = comparisons.map((c) => this.evalComparison(c, state, ctx))
        matched = logical === 'OR' ? results.some(Boolean) : results.every(Boolean)
      }
      if (matched) {
        const edgeId = this.itemEdgeId(item, state)
        if (edgeId) return edgeId
      }
    }
    return null
  }

  private evalComparison(
    c: Record<string, unknown>,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): boolean {
    const varId = asString(c.variableId) ?? ''
    const op = (asString(c.comparisonOperator) ?? asString(c.operator) ?? 'Equal').toLowerCase()
    if (DATE_OPERATORS.has(op)) return this.evalDateComparison(op, varId, c, state, ctx)
    const raw = this.resolveVar(varId, state, ctx)
    const left = String(raw ?? '')
    // The Nebula builder persists some comparison values as ARRAYS
    // (`Equal ["Não Respondeu"]`) — any-element match, like Nebula's engine.
    const rights = (Array.isArray(c.value) ? c.value : [c.value]).map((v) =>
      this.interpolate(typeof v === 'string' ? v : v == null ? '' : String(v), state, ctx),
    )
    const right = rights[0] ?? ''
    const l = left.toLowerCase()
    // Rails blank? parity: Nebula's Is set / Is not set / Is empty use
    // actual.blank?, where boolean false IS blank. V1 Code blocks set flags
    // to false and rely on "Is not set" matching them (bloqueio_numero on
    // "Boas Vindas" 3351 routes every unblocked contact through this).
    const isBlank = raw === null || raw === undefined || raw === false || left.trim() === ''
    // V1 compat: "context" was cosmo-brain's global namespace — Equal against
    // variableId "context" matches ANY session variable value.
    if (varId === 'context' && op.startsWith('equal')) {
      return Object.values(state.variables).some(
        (v) => String(v ?? '').toLowerCase() === right.toLowerCase(),
      )
    }
    const anyRight = (f: (r: string) => boolean) => rights.some((v) => f(v.toLowerCase()))
    switch (op) {
      case 'equal':
      case 'equals':
      case 'equal to':
        return anyRight((r) => l === r)
      case 'not equal':
        return !anyRight((r) => l === r)
      case 'contains':
        return anyRight((r) => l.includes(r))
      case 'does not contain':
      case 'not contains':
        return !anyRight((r) => l.includes(r))
      case 'starts with':
        return anyRight((r) => l.startsWith(r))
      case 'does not start with':
        return !anyRight((r) => l.startsWith(r))
      case 'ends with':
        return anyRight((r) => l.endsWith(r))
      case 'does not end with':
        return !anyRight((r) => l.endsWith(r))
      case 'is set':
        return !isBlank
      case 'is not set':
      case 'is empty':
        return isBlank
      case 'greater than':
        return Number(left) > Number(right)
      case 'less than':
        return Number(left) < Number(right)
      case 'greater than or equal':
        return Number(left) >= Number(right)
      case 'less than or equal':
        return Number(left) <= Number(right)
      case 'is a number':
        return /^-?\d+(\.\d+)?$/.test(left.trim())
      case 'is not a number':
      case 'not a number':
        return !/^-?\d+(\.\d+)?$/.test(left.trim())
      default:
        return false
    }
  }

  /**
   * "Is before / Is after / Is between" in the account's timezone, at minute
   * precision. The left side is the real clock when the variable is `now`
   * (what a notice with an expiry tests) and otherwise whatever date the
   * variable holds, e.g. the answer to a date question. Values are
   * interpolated first, so an author can compare against `{{deadline}}`.
   */
  private evalDateComparison(
    op: string,
    varId: string,
    c: Record<string, unknown>,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): boolean {
    const tz = ctx.timezone ?? null
    const read = (v: unknown) =>
      parseFlowDate(this.interpolate(typeof v === 'string' ? v : '', state, ctx), tz)
    const left =
      varId === NOW_VARIABLE
        ? parseFlowDate(this.clock(ctx), tz)
        : parseFlowDate(this.resolveVar(varId, state, ctx), tz)
    const first = Array.isArray(c.value) ? c.value[0] : c.value
    return compareFlowDates(op, left, read(first), read(c.valueTo), tz)
  }

  private clock(ctx: FlowContext): Date {
    return ctx.now ?? new Date()
  }

  /** `{{var}}` / `{{var|default}}` interpolation. */
  private interpolate(text: string, state: FlowRuntimeState, ctx: FlowContext): string {
    if (!text) return ''
    return text.replace(/\{\{(.+?)\}\}/g, (_m, raw: string) => {
      const expr = raw.trim()
      const pipe = expr.indexOf('|')
      if (pipe >= 0) {
        const name = expr.slice(0, pipe).trim()
        const def = expr.slice(pipe + 1)
        const v = this.resolveVar(name, state, ctx)
        return v !== null && v !== undefined && String(v) !== '' ? String(v) : def
      }
      const v = this.resolveVar(expr, state, ctx)
      return v === null || v === undefined ? '' : String(v)
    })
  }

  private resolveVar(
    name: string,
    state: FlowRuntimeState,
    ctx: FlowContext,
  ): unknown {
    // System variable: always the live clock, never a stale copy a flow or
    // an import happened to store under the same name.
    if (name === NOW_VARIABLE) return formatFlowNow(this.clock(ctx), ctx.timezone)
    if (name in state.variables) return state.variables[name]
    const c = ctx.contact
    switch (name) {
      // `first_name` is V1's spelling; there is no separate first name here.
      case 'contact.name':
      case 'name':
      case 'contact_name':
      case 'first_name':
        return c?.name ?? null
      case 'contact.email':
      case 'email':
        return c?.email ?? null
      case 'contact.phone':
      case 'contact.phoneNumber':
      case 'phone':
      case 'whatsapp_number':
        return c?.phoneNumber ?? null
      default:
        return null
    }
  }

  private group(flowId: string, id: string): Group | undefined {
    return this.groupsOf(flowId).find((g) => g.id === id)
  }

  /** Look up a block by group + id (used by the GUIDED deviation handler). */
  blockAt(
    groupId: string | null,
    blockId: string | null,
    flowId: string = ROOT_FLOW,
  ): Record<string, unknown> | null {
    if (!groupId || !blockId) return null
    const g = this.group(flowId, groupId)
    return g?.blocks.find((b) => b.id === blockId) ?? null
  }
}

// ─── small helpers ──────────────────────────────────────────────────────

type Acc = { emissions: FlowEmission[]; intents: FlowIntent[]; steps: number }
function newAcc(): Acc {
  return { emissions: [], intents: [], steps: 0 }
}
function finish(acc: Acc, state: FlowRuntimeState, status: FlowStatus): FlowStepResult {
  return { emissions: acc.emissions, intents: acc.intents, state, status }
}

type BlockOutcome =
  | { kind: 'continue' }
  | { kind: 'edge'; edgeId: string }
  | { kind: 'jump'; groupId: string }
  | { kind: 'subflow'; subId: string; returnEdgeId: string | null }
  | { kind: 'complete' }
  | { kind: 'handoff'; message: string | null; teamId: string | null }

type ReplyRoute =
  | { kind: 'continue' }
  | { kind: 'edge'; edgeId: string }
  // Resume the group at the block AFTER `blockId` — a V1 composite step
  // consumed its own trailing input, so the walk must not stop on it again.
  | { kind: 'resumeAfter'; blockId: string }
  | { kind: 'wait' }
  | { kind: 'deviation' }

/**
 * The trailing `text input` of a V1 "composite step", or null.
 *
 * Cosmo-Flows exported one V1 menu as three blocks inside a single group:
 * the prompt text, a `choice input` that renders the buttons, and a
 * `text input` that owns the answer variable AND the step's outgoing edge.
 * The three are ONE question — the customer answers once.
 *
 * Without this pairing the engine parks twice: the tap satisfies the choice
 * block, nothing is emitted (a typed input has no prompt of its own) and the
 * flow sits waiting for the same answer a second time. The customer sees
 * dead air. That is exactly what happened to conversation 8739 on
 * 2026-09-23, on the first real lead to reach the commercial menu. Nebula's
 * engine pairs them the same way (`FlowExecutor#advance_in_group`).
 */
function companionInput(block: Block, group: Group): Block | null {
  if (!COMPOSITE_HEAD_TYPES.has(block.type)) return null
  const next = group.blocks[indexOf(group, block.id) + 1]
  return next && next.type === 'text input' ? next : null
}

/** The block's turn cap; absent or invalid means the default, 0 means none. */
function maxAiTurns(block: Block): number {
  const n = Number(opt(block, 'maxAiTurns'))
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_AI_TURNS
}

function opt(block: Block, key: string): unknown {
  const options = (block.options ?? block) as Record<string, unknown>
  return options[key]
}
function textOf(block: Block): string {
  const raw =
    opt(block, 'content') ??
    opt(block, 'text') ??
    (block as Record<string, unknown>).content
  if (typeof raw === 'string') return raw
  // Typebot/V1-import shape: `content` is an object carrying `plainText`
  // (every migrated Nebula text block) and optionally a `richText` node tree.
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.plainText === 'string') return o.plainText
    if (Array.isArray(o.richText)) return richTextToPlain(o.richText)
  }
  return ''
}

function richTextToPlain(nodes: unknown[]): string {
  const leaf = (n: unknown): string => {
    if (!n || typeof n !== 'object') return ''
    const node = n as Record<string, unknown>
    if (typeof node.text === 'string') return node.text
    return Array.isArray(node.children) ? node.children.map(leaf).join('') : ''
  }
  return nodes.map(leaf).join('\n')
}

/**
 * Is `now` within the weekly schedule? `hours` uses Nebula's shape:
 * `{ mon_1: '09:00', mon_2: '18:00', …, sun_1: null }` — `_1` opens, `_2`
 * closes, null/absent means closed all day. Evaluated in the block's IANA
 * `timezone`; an unknown timezone falls back to UTC rather than crashing
 * the flow mid-conversation.
 */
export function isWithinBusinessHours(
  hours: Record<string, unknown> | undefined,
  timezone: string,
  now: Date,
): boolean {
  if (!hours) return false
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = fmt(timezone)
  } catch {
    parts = fmt('UTC')
  }
  const byType: Record<string, string> = {}
  for (const p of parts) byType[p.type] = p.value
  const day = byType.weekday!.toLowerCase().slice(0, 3)
  const hhmm = `${byType.hour}:${byType.minute}`
  // `_1`/`_2` are the day's first opening and closing time. `_3`/`_4` are an
  // optional second shift, for a place that closes for lunch: without it a
  // "morning and afternoon" schedule could only be written as one long window
  // that calls the lunch break open.
  const within = (from: unknown, to: unknown): boolean =>
    typeof from === 'string' && !!from && typeof to === 'string' && !!to && hhmm >= from && hhmm < to
  return (
    within(hours[`${day}_1`], hours[`${day}_2`]) ||
    within(hours[`${day}_3`], hours[`${day}_4`])
  )
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function indexOf(group: Group, blockId: string): number {
  return group.blocks.findIndex((b) => b.id === blockId)
}
