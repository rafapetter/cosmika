'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { FlowCheckDTO, FlowDTO } from '@cosmika/shared'
import { Badge, Button, Input, Textarea } from '@cosmika/ui'
import '@xyflow/react/dist/style.css'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useStoredSession } from '../../../lib/session-store'
import {
  BLOCK_TYPE_GROUPS,
  addBlock,
  addGroupAt,
  deleteBlock,
  deleteGroup,
  duplicateBlock,
  duplicateGroup,
  moveBlock,
  renameGroup,
  setBlockOptions,
  setStartGroup,
  type Def,
} from '../flow-edit'
import { blockTypeLabel, useFlowText } from '../_flow-text'

import { FlowCanvas, KIND_DOT, blockVisual, type BlockRef } from './_canvas'
import { PublishChecks } from './_publish-checks'
import { BlockEditor, VariablesPanel } from './_editors'
import { PreviewPanel } from './_preview'

type GroupShape = {
  id: string
  title?: string
  blocks: ({ id: string; type: string } & Record<string, unknown>)[]
}

export default function FlowEditorPage() {
  const t = useTranslations()
  const text = useFlowText()
  const { session } = useStoredSession()
  const params = useParams<{ id: string }>()
  const flowId = params.id
  const [flow, setFlow] = React.useState<FlowDTO | null>(null)
  const [name, setName] = React.useState('')
  const [def, setDef] = React.useState<Def | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [selected, setSelected] = React.useState<BlockRef | null>(null)
  const [addingTo, setAddingTo] = React.useState<string | null>(null)
  const [showJson, setShowJson] = React.useState(false)
  const [showPreview, setShowPreview] = React.useState(false)
  const [showVars, setShowVars] = React.useState(false)
  // Wiring defects reported by the last publish. Warnings, never a block.
  const [checks, setChecks] = React.useState<FlowCheckDTO[] | null>(null)

  React.useEffect(() => {
    if (!session) return
    api
      .getFlow(session.session.token, session.account.id, flowId)
      .then((f) => {
        setFlow(f)
        setName(f.name)
        setDef(f.definition as Def)
      })
      .catch((err) => setError(apiErrorText(t, err)))
  }, [session, flowId, t])

  // Undo/redo: linear history of definitions, capped so huge flows can't
  // exhaust memory. Refs keep `change` referentially stable.
  const historyRef = React.useRef<{ past: Def[]; future: Def[] }>({ past: [], future: [] })
  const defRef = React.useRef<Def | null>(null)
  React.useEffect(() => {
    defRef.current = def
  }, [def])

  const change = React.useCallback((d: Def) => {
    if (defRef.current) {
      historyRef.current.past.push(defRef.current)
      if (historyRef.current.past.length > 100) historyRef.current.past.shift()
      historyRef.current.future = []
    }
    setDef(d)
    setDirty(true)
    setNotice(null)
  }, [])

  const undo = React.useCallback(() => {
    const prev = historyRef.current.past.pop()
    if (!prev || !defRef.current) return
    historyRef.current.future.push(defRef.current)
    setDef(prev)
    setDirty(true)
    setNotice(null)
  }, [])

  const redo = React.useCallback(() => {
    const next = historyRef.current.future.pop()
    if (!next || !defRef.current) return
    historyRef.current.past.push(defRef.current)
    setDef(next)
    setDirty(true)
    setNotice(null)
  }, [])

  // Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z — but never hijack native undo in fields.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  async function save(auto = false): Promise<boolean> {
    if (!session || !def || saving) return false
    setSaving(true)
    setError(null)
    try {
      const f = await api.updateFlow(session.session.token, session.account.id, flowId, {
        name: name.trim() || undefined,
        definition: def,
      })
      setFlow(f)
      setDirty(false)
      setNotice(auto ? t('flows.saved_auto') : t('flows.saved'))
      return true
    } catch (err) {
      setError(apiErrorText(t, err))
      return false
    } finally {
      setSaving(false)
    }
  }

  // Autosave the draft 2s after the last change (publish stays explicit).
  const saveRef = React.useRef(save)
  saveRef.current = save
  React.useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => void saveRef.current(true), 2000)
    return () => clearTimeout(timer)
  }, [def, name, dirty])

  /** Bring a group named by a publish check into view on the canvas. */
  function focusGroup(groupId: string): void {
    document
      .querySelector(`[data-testid="canvas-group-${groupId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
  }

  async function publish() {
    if (!session) return
    if (!(await save())) return
    setSaving(true)
    try {
      const r = await api.publishFlow(session.session.token, session.account.id, flowId)
      setFlow(r.flow)
      setNotice(t('flows.published_notice'))
      setChecks(r.checks)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSaving(false)
    }
  }

  const ctx = React.useMemo(
    () => ({
      startGroupId: def ? (def as { startGroupId?: string }).startGroupId : undefined,
      selected,
      onSelectBlock: (ref: BlockRef) => {
        setSelected(ref)
        setAddingTo(null)
      },
      onRenameGroup: (groupId: string, title: string) => def && change(renameGroup(def, groupId, title)),
      onDeleteGroup: (groupId: string) => {
        if (!def) return
        change(deleteGroup(def, groupId))
        setSelected((s) => (s?.groupId === groupId ? null : s))
      },
      onDuplicateGroup: (groupId: string) => def && change(duplicateGroup(def, groupId, text)),
      onSetStart: (groupId: string) => def && change(setStartGroup(def, groupId)),
      onAddBlockClick: (groupId: string) => {
        setAddingTo(groupId)
        setSelected(null)
      },
    }),
    [def, selected, change, text],
  )

  if (!session) return null

  const selectedBlock: (GroupShape['blocks'][number] & { __group?: string }) | null = (() => {
    if (!def || !selected) return null
    const g = (def as unknown as { groups: GroupShape[] }).groups.find(
      (x) => x.id === selected.groupId,
    )
    return g?.blocks.find((b) => b.id === selected.blockId) ?? null
  })()

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="flow-editor">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Link href={{ pathname: '/flows' }} className="text-sm text-muted-foreground hover:underline">
          ← {t('flows.back')}
        </Link>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setDirty(true)
          }}
          className="h-8 w-64 text-sm font-medium"
          data-testid="editor-name"
        />
        {flow ? (
          <Badge variant={flow.hasPublished ? 'success' : 'outline'}>{t(`flows.status_${flow.status.toLowerCase()}` as never)}</Badge>
        ) : null}
        {dirty ? <span className="text-[11px] text-warning">{t('flows.unsaved')}</span> : null}
        {notice ? <span className="text-[11px] text-success" data-testid="editor-status">{notice}</span> : null}
        {error ? <span className="text-[11px] text-destructive" data-testid="editor-error">{error}</span> : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={undo}
            disabled={historyRef.current.past.length === 0}
            title={t('flows.undo')}
            aria-label={t('flows.undo')}
            data-testid="editor-undo"
          >
            ↩
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={redo}
            disabled={historyRef.current.future.length === 0}
            title={t('flows.redo')}
            aria-label={t('flows.redo')}
            data-testid="editor-redo"
          >
            ↪
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!def) return
              const center = (
                window as unknown as { __flowCanvasCenter?: () => { x: number; y: number } }
              ).__flowCanvasCenter?.() ?? { x: 100, y: 100 }
              change(addGroupAt(def, Math.round(center.x), Math.round(center.y), text))
            }}
            data-testid="editor-add-group"
          >
            + {t('flows.group')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowVars((v) => !v)} data-testid="editor-variables">
            {'{x}'} {t('flows.variables')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowJson((v) => !v)}>
            JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowPreview((v) => !v)}
            data-testid="editor-test"
          >
            ▶ {t('flows.test_bot')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving} data-testid="editor-save">
            {saving ? t('flows.saving') : t('common.save')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void publish()} disabled={saving} data-testid="editor-publish">
            {t('flows.publish')}
          </Button>
        </div>
      </div>

      {checks ? (
        <PublishChecks
          checks={checks}
          onFocusGroup={focusGroup}
          onDismiss={() => setChecks(null)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {def ? (
            <FlowCanvas def={def} onChange={change} ctx={ctx} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{error ?? t('common.loading')}</p>
          )}

          {showVars && def ? (
            <VariablesPanel def={def} onChange={change} onClose={() => setShowVars(false)} />
          ) : null}

          {addingTo && def ? (
            <div className="absolute left-1/2 top-4 z-10 max-h-[70vh] w-72 -translate-x-1/2 overflow-y-auto rounded-lg border border-border bg-card p-3 shadow-lg">
              <p className="mb-2 text-xs font-medium">{t('flows.add_block')}</p>
              {BLOCK_TYPE_GROUPS.map((cat) => (
                <div key={cat.key} className="mb-2">
                  <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span className={`h-2 w-2 rounded-full ${KIND_DOT[cat.kind]}`} />
                    {t(`flows.category_${cat.key}` as never)}
                  </p>
                  <div className="grid grid-cols-2 gap-1">
                    {cat.types.map((type) => {
                      const { Icon, cls } = blockVisual(type)
                      return (
                      <button
                        key={type}
                        type="button"
                        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-left text-[11px] hover:border-primary hover:text-primary"
                        onClick={() => {
                          const next = addBlock(def, addingTo, type, text)
                          change(next)
                          const g = (next as unknown as { groups: GroupShape[] }).groups.find(
                            (x) => x.id === addingTo,
                          )
                          const added = g?.blocks[g.blocks.length - 1]
                          if (added) setSelected({ groupId: addingTo, blockId: added.id })
                          setAddingTo(null)
                        }}
                      >
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${cls}`} strokeWidth={2} />
                        <span className="truncate">{blockTypeLabel(t, type)}</span>
                      </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="mt-1 w-full rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                onClick={() => setAddingTo(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : null}
        </div>

        {selectedBlock && def && selected ? (
          <BlockDrawer
            def={def}
            groupId={selected.groupId}
            block={selectedBlock}
            onChange={change}
            token={session.session.token}
            accountId={session.account.id}
            onClose={() => setSelected(null)}
            onDelete={() => {
              change(deleteBlock(def, selected.groupId, selected.blockId))
              setSelected(null)
            }}
          />
        ) : null}

        {showPreview ? (
          <PreviewPanel
            token={session.session.token}
            accountId={session.account.id}
            flowId={flowId}
            onClose={() => setShowPreview(false)}
          />
        ) : null}
      </div>

      {showJson && def ? (
        <div className="h-56 border-t border-border bg-card p-2">
          <RawJson def={def} onChange={change} onError={setError} />
        </div>
      ) : null}
    </div>
  )
}

function BlockDrawer({
  def,
  groupId,
  block,
  onChange,
  token,
  accountId,
  onClose,
  onDelete,
}: {
  def: Def
  groupId: string
  block: { id: string; type: string } & Record<string, unknown>
  onChange: (d: Def) => void
  token: string
  accountId: string
  onClose: () => void
  onDelete: () => void
}) {
  const t = useTranslations()
  const options = (block.options ?? {}) as Record<string, unknown>
  const optionsJson = JSON.stringify(options, null, 2)
  const [jsonText, setJsonText] = React.useState(optionsJson)
  const [jsonBad, setJsonBad] = React.useState(false)
  const [editingJson, setEditingJson] = React.useState(false)
  // Keep the raw view in sync with rich-editor changes, but never clobber the
  // textarea while the user is typing in it.
  React.useEffect(() => {
    if (!editingJson) {
      setJsonText(optionsJson)
      setJsonBad(false)
    }
  }, [optionsJson, editingJson])

  return (
    <div
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-card"
      data-testid="block-drawer"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
          {blockTypeLabel(t, block.type)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title={t('flows.move_up')}
            aria-label={t('flows.move_up')}
            onClick={() => onChange(moveBlock(def, groupId, block.id, -1))}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            data-testid="drawer-move-up"
          >
            ↑
          </button>
          <button
            type="button"
            title={t('flows.move_down')}
            aria-label={t('flows.move_down')}
            onClick={() => onChange(moveBlock(def, groupId, block.id, 1))}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            data-testid="drawer-move-down"
          >
            ↓
          </button>
          <button
            type="button"
            title={t('flows.duplicate_block')}
            aria-label={t('flows.duplicate_block')}
            onClick={() => onChange(duplicateBlock(def, groupId, block.id))}
            className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            data-testid="drawer-duplicate"
          >
            ⧉
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            data-testid="drawer-delete"
          >
            {t('common.delete')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            aria-label={t('flows.close')}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <BlockEditor
          def={def}
          groupId={groupId}
          block={block}
          onChange={onChange}
          token={token}
          accountId={accountId}
        />
        <details className="rounded-md border border-border/60">
          <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            {t('flows.advanced_json')}
          </summary>
          <div className="p-2 pt-0">
            <Textarea
              value={jsonText}
              onFocus={() => setEditingJson(true)}
              onBlur={() => setEditingJson(false)}
              onChange={(e) => {
                setJsonText(e.target.value)
                try {
                  const parsed = JSON.parse(e.target.value) as Record<string, unknown>
                  setJsonBad(false)
                  onChange(setBlockOptions(def, groupId, block.id, parsed))
                } catch {
                  setJsonBad(true)
                }
              }}
              className="min-h-[180px] p-2 font-mono text-[11px]"
              data-testid="drawer-json"
            />
            {jsonBad ? (
              <p className="mt-1 text-[11px] text-destructive">{t('flows.json_invalid_kept')}</p>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  )
}

function RawJson({
  def,
  onChange,
  onError,
}: {
  def: Def
  onChange: (d: Def) => void
  onError: (m: string | null) => void
}) {
  const t = useTranslations()
  const [text, setText] = React.useState(JSON.stringify(def, null, 2))
  return (
    <Textarea
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        try {
          onChange(JSON.parse(e.target.value) as Def)
          onError(null)
        } catch {
          onError(t('flows.json_invalid'))
        }
      }}
      className="h-full p-2 font-mono text-[11px]"
      data-testid="editor-json"
    />
  )
}
