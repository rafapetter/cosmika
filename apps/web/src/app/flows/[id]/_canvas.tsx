'use client'

// Drag-and-drop flow canvas (React Flow). Groups render as nodes at their
// Typebot graphCoordinates — migrated flows keep the exact layout they had in
// Nebula's builder. Page-coupled component: exercised by e2e, not unit tests.

import * as React from 'react'
import { useTranslations } from 'next-intl'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  AtSign,
  Braces,
  Clock,
  Code2,
  CornerDownRight,
  ExternalLink,
  Film,
  FlaskConical,
  GalleryHorizontalEnd,
  Hash,
  Headphones,
  Image as ImageIcon,
  Link as LinkIcon,
  ListChecks,
  Mail,
  MessageCircle,
  MessageSquareText,
  Mic,
  Phone,
  Sheet,
  Sparkles,
  Split,
  SquarePower,
  StickyNote,
  Ticket,
  Type,
  Variable as VariableIcon,
  Webhook as WebhookIcon,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

import {
  blockHandle,
  blockItems,
  blockKind,
  canvasEdges,
  decodeHandle,
  describeBlock,
  groupPosition,
  itemHandle,
  itemSummary,
  removeEdge,
  setBlockNext,
  setGroupNext,
  setGroupPosition,
  setItemNext,
  type Def,
} from '../flow-edit'
import { useFlowText } from '../_flow-text'

type GroupShape = {
  id: string
  title?: string
  blocks: ({ id: string; type: string } & Record<string, unknown>)[]
}

export type BlockRef = { groupId: string; blockId: string }

type CanvasCtx = {
  startGroupId?: string
  selected: BlockRef | null
  onSelectBlock: (ref: BlockRef) => void
  onRenameGroup: (groupId: string, title: string) => void
  onDeleteGroup: (groupId: string) => void
  onDuplicateGroup: (groupId: string) => void
  onSetStart: (groupId: string) => void
  onAddBlockClick: (groupId: string) => void
}

export const KIND_DOT: Record<ReturnType<typeof blockKind>, string> = {
  bubble: 'bg-[#805AD5]',
  input: 'bg-[#DD6B20]',
  logic: 'bg-[#805AD5]',
  integration: 'bg-emerald-600',
}

// Typebot's icon language: purple for bubbles + logic, orange for inputs,
// brand-ish colors for integrations. Same palette as Nebula's builder
// (chakra purple.500 / orange.500).
const PURPLE = 'text-[#805AD5]'
const ORANGE = 'text-[#DD6B20]'

export function blockVisual(type: string): { Icon: LucideIcon; cls: string } {
  switch (type) {
    case 'text':
      return { Icon: MessageSquareText, cls: PURPLE }
    case 'image':
      return { Icon: ImageIcon, cls: PURPLE }
    case 'video':
      return { Icon: Film, cls: PURPLE }
    case 'audio':
      return { Icon: Mic, cls: PURPLE }
    case 'embed':
      return { Icon: Code2, cls: PURPLE }
    case 'cards':
      return { Icon: GalleryHorizontalEnd, cls: PURPLE }
    case 'text input':
      return { Icon: Type, cls: ORANGE }
    case 'number input':
      return { Icon: Hash, cls: ORANGE }
    case 'email input':
      return { Icon: AtSign, cls: ORANGE }
    case 'url input':
      return { Icon: LinkIcon, cls: ORANGE }
    case 'phone number input':
    case 'phone input':
      return { Icon: Phone, cls: ORANGE }
    case 'choice input':
      return { Icon: ListChecks, cls: ORANGE }
    case 'Condition':
      return { Icon: Split, cls: PURPLE }
    case 'Set variable':
      return { Icon: VariableIcon, cls: PURPLE }
    case 'Jump':
      return { Icon: CornerDownRight, cls: PURPLE }
    case 'AB test':
      return { Icon: FlaskConical, cls: PURPLE }
    case 'Wait':
      return { Icon: Clock, cls: PURPLE }
    case 'Redirect':
    case 'Webview':
      return { Icon: ExternalLink, cls: PURPLE }
    case 'Cosmoflow link':
      return { Icon: Workflow, cls: PURPLE }
    case 'note':
      return { Icon: StickyNote, cls: PURPLE }
    case 'end-session':
      return { Icon: SquarePower, cls: PURPLE }
    case 'Webhook':
    case 'webhook':
    case 'api_call':
    case 'API call':
      return { Icon: WebhookIcon, cls: 'text-foreground' }
    case 'OpenAI':
    case 'openai':
      return { Icon: Sparkles, cls: 'text-foreground' }
    case 'WhatsApp Template':
      return { Icon: MessageCircle, cls: 'text-[#25D366]' }
    case 'Cosmodesk':
    case 'cosmodesk':
      return { Icon: Headphones, cls: 'text-sky-600' }
    case 'Google Sheets':
      return { Icon: Sheet, cls: 'text-[#0F9D58]' }
    case 'Email':
      return { Icon: Mail, cls: 'text-foreground' }
    case 'Ticket Create':
    case 'Ticket Update':
    case 'Ticket Query':
      return { Icon: Ticket, cls: 'text-foreground' }
    default: {
      const kind = blockKind(type)
      if (kind === 'input') return { Icon: Type, cls: ORANGE }
      if (kind === 'integration') return { Icon: WebhookIcon, cls: 'text-foreground' }
      return { Icon: Braces, cls: PURPLE }
    }
  }
}

// Handle skin shared by every endpoint — Typebot's gray dot with a white ring.
const HANDLE_CLS = '!h-3 !w-3 !border-2 !border-white !bg-[#A0AEC0] !shadow-sm dark:!border-card'

function GroupNode({ data }: NodeProps<Node<{ group: GroupShape; ctx: CanvasCtx }>>) {
  const { group, ctx } = data
  const t = useTranslations()
  const text = useFlowText()
  const isStart = ctx.startGroupId === group.id
  return (
    <div
      className="group/gn w-[300px] rounded-xl border border-[#E2E8F0] bg-card shadow-md transition-shadow duration-200 hover:shadow-lg dark:border-border"
      data-testid={`canvas-group-${group.id}`}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLS} />
      <div className="flex items-center gap-1 px-3 pt-2.5">
        <input
          value={group.title ?? ''}
          placeholder={t('flows.group')}
          aria-label={t('flows.group_name')}
          onChange={(e) => ctx.onRenameGroup(group.id, e.target.value)}
          className="nodrag min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none"
        />
        {isStart ? (
          <span className="rounded-md bg-[#805AD5]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#805AD5]">
            {t('flows.start_badge')}
          </span>
        ) : (
          <button
            type="button"
            title={t('flows.set_start')}
            aria-label={t('flows.set_start')}
            onClick={() => ctx.onSetStart(group.id)}
            className="nodrag rounded px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/gn:opacity-100"
          >
            ▶
          </button>
        )}
        <button
          type="button"
          title={t('flows.duplicate_group')}
          aria-label={t('flows.duplicate_group')}
          onClick={() => ctx.onDuplicateGroup(group.id)}
          className="nodrag rounded px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/gn:opacity-100"
        >
          ⧉
        </button>
        <button
          type="button"
          title={t('flows.delete_group')}
          aria-label={t('flows.delete_group')}
          onClick={() => ctx.onDeleteGroup(group.id)}
          className="nodrag rounded px-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/gn:opacity-100"
        >
          ✕
        </button>
      </div>
      <ul className="space-y-2 p-3 pt-2">
        {group.blocks.map((b) => {
          const active =
            ctx.selected?.groupId === group.id && ctx.selected?.blockId === b.id
          const items = blockItems(b as never)
          const { Icon, cls } = blockVisual(b.type)
          return (
            <li key={b.id} className="relative">
              <div
                role="button"
                tabIndex={0}
                onClick={() => ctx.onSelectBlock({ groupId: group.id, blockId: b.id })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') ctx.onSelectBlock({ groupId: group.id, blockId: b.id })
                }}
                className={`nodrag cursor-pointer rounded-lg border bg-background px-3 py-2 transition-colors ${
                  active
                    ? 'border-[#805AD5] ring-1 ring-[#805AD5]/30'
                    : 'border-[#E2E8F0] hover:border-[#805AD5]/50 dark:border-border'
                }`}
              >
                <div className="flex items-start gap-2">
                  <Icon className={`mt-px h-4 w-4 shrink-0 ${cls}`} strokeWidth={2} />
                  <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug">
                    {describeBlock(b as never, text)}
                  </span>
                </div>
                {/* Choice options / condition branches / A-B buckets render as
                    stacked chips inside the block, Typebot-style. */}
                {items.length > 0 ? (
                  <div className="mt-2 space-y-1.5">
                    {items.map((it, idx) => {
                      const itemId = typeof it.id === 'string' ? it.id : String(idx)
                      const isChip = b.type === 'choice input' || typeof it.content === 'string'
                      return (
                        <div
                          key={itemId}
                          className={`relative px-2.5 py-1.5 text-xs ${
                            isChip
                              ? 'rounded-md bg-[#ED8936] font-medium text-white'
                              : 'rounded-md border border-[#E2E8F0] bg-card text-foreground dark:border-border'
                          }`}
                        >
                          <span className="block truncate pr-1">{itemSummary(it, idx, text)}</span>
                          <Handle
                            type="source"
                            id={itemHandle(b.id, itemId)}
                            position={Position.Right}
                            className={`${HANDLE_CLS} !right-[-31px]`}
                          />
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              {/* Block-level "next" handle — always present: it anchors the
                  block's own edge (plain next, or the else/fallthrough path
                  on choice/Condition blocks). */}
              <Handle
                type="source"
                id={blockHandle(b.id)}
                position={Position.Right}
                className={`${HANDLE_CLS} !right-[-19px] ${items.length > 0 ? '!top-4' : '!top-1/2'}`}
              />
            </li>
          )
        })}
        {group.blocks.length === 0 ? (
          <li className="rounded-lg border border-dashed border-[#E2E8F0] px-3 py-2 text-center text-xs text-muted-foreground dark:border-border">
            {t('flows.empty_group')}
          </li>
        ) : null}
        <li>
          <button
            type="button"
            onClick={() => ctx.onAddBlockClick(group.id)}
            className="nodrag w-full rounded-lg border border-dashed border-[#E2E8F0] px-2 py-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:border-[#805AD5] hover:text-[#805AD5] group-hover/gn:opacity-100 dark:border-border"
          >
            + {t('flows.add_block')}
          </button>
        </li>
      </ul>
    </div>
  )
}

// NB: keyed "flowGroup", NOT "group" — React Flow has a built-in "group" node
// type whose default chrome (150px width, dark border) bleeds through.
const nodeTypes = { flowGroup: GroupNode }

function CanvasInner({
  def,
  onChange,
  ctx,
}: {
  def: Def
  onChange: (d: Def) => void
  ctx: CanvasCtx
}) {
  const rf = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const groups = (def as unknown as { groups: GroupShape[] }).groups

  // React Flow measures a node's handles once at mount; block/item edits add
  // or remove handles afterwards, so re-measure whenever the handle topology
  // changes — otherwise edges to the new handles are silently dropped (#008).
  const handleSignature = React.useMemo(
    () =>
      groups
        .map((g) => `${g.id}:${g.blocks.map((b) => `${b.id}.${blockItems(b as never).length}`).join(',')}`)
        .join('|'),
    [groups],
  )
  React.useEffect(() => {
    updateNodeInternals(groups.map((g) => g.id))
  }, [handleSignature, groups, updateNodeInternals])

  const nodes: Node[] = React.useMemo(
    () =>
      groups.map((g) => ({
        id: g.id,
        type: 'flowGroup',
        position: groupPosition(def, g.id),
        data: { group: g, ctx },
      })),
    [def, groups, ctx],
  )

  const edges: Edge[] = React.useMemo(
    () =>
      canvasEdges(def).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        animated: false,
        // Typebot's edge: gray.400, 2px, closed arrowhead.
        style: { strokeWidth: 2, stroke: '#A0AEC0' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#A0AEC0' },
        // Branch edges carry the option/branch label.
        label: e.label,
        labelStyle: { fontSize: 10, fill: '#4A5568' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: '#fff', fillOpacity: 0.85 },
      })),
    [def],
  )

  const onNodeDragStop = React.useCallback(
    (_evt: unknown, node: Node) => {
      onChange(setGroupPosition(def, node.id, Math.round(node.position.x), Math.round(node.position.y)))
    },
    [def, onChange],
  )

  const onConnect = React.useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return
      const h = decodeHandle(conn.sourceHandle)
      if (h.kind === 'item') {
        onChange(setItemNext(def, conn.source, h.blockId, h.itemId, conn.target))
      } else if (h.kind === 'block') {
        onChange(setBlockNext(def, conn.source, h.blockId, conn.target))
      } else if (conn.source !== conn.target) {
        onChange(setGroupNext(def, conn.source, conn.target))
      }
    },
    [def, onChange],
  )

  const onEdgesDelete = React.useCallback(
    (deleted: Edge[]) => {
      let next = def
      for (const e of deleted) next = removeEdge(next, e.id)
      onChange(next)
    },
    [def, onChange],
  )

  // Expose the instance for e2e/debugging assertions.
  React.useEffect(() => {
    ;(window as unknown as { __rf?: unknown }).__rf = rf
  }, [rf])

  // Expose the viewport center so the page can place new groups where the user looks.
  React.useEffect(() => {
    ;(window as unknown as { __flowCanvasCenter?: () => { x: number; y: number } }).__flowCanvasCenter =
      () => {
        const el = document.querySelector('.react-flow')
        const rect = el?.getBoundingClientRect()
        return rf.screenToFlowPosition({
          x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
          y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2,
        })
      }
  }, [rf])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onEdgesDelete={onEdgesDelete}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      deleteKeyCode={['Backspace', 'Delete']}
      nodesConnectable
      elementsSelectable
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={24}
        size={1.5}
        color="#CBD5E0"
        className="!bg-[#F4F5F8] dark:!bg-transparent"
      />
      <MiniMap pannable zoomable className="!h-28 !w-40" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export function FlowCanvas(props: {
  def: Def
  onChange: (d: Def) => void
  ctx: CanvasCtx
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner def={props.def} onChange={props.onChange} ctx={props.ctx} />
    </ReactFlowProvider>
  )
}
