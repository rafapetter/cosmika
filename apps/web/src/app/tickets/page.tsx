'use client'

import Link from 'next/link'
import { CalendarDays, Flag, Loader2, Tag, Ticket as TicketIcon, User } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import type {
  SavedViewDTO,
  SupportTicketDTO,
  TicketFilter,
  TicketSortField,
  TicketViewConfig,
} from '@cosmika/shared'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { useDateTime } from '../../lib/format-datetime'
import { useStoredSession } from '../../lib/session-store'
import { useCellGrid } from '../../lib/use-cell-grid'
import { ViewSwitcher } from '../../components/view-switcher'
import { TicketRecordPanel } from './_record-panel'

const MUTATE_ROLES = ['ADMINISTRATOR', 'SUPERVISOR']

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

/** Reuse the shared status palette so tickets read like conversations do. */
function statusVariant(s: string) {
  if (s === 'OPEN') return 'open' as const
  if (s === 'PENDING') return 'pending' as const
  if (s === 'RESOLVED') return 'resolved' as const
  return 'outline' as const
}

function priorityVariant(p: string) {
  if (p === 'URGENT' || p === 'HIGH') return 'destructive' as const
  return 'outline' as const
}

/** Hideable data columns; subject (with its #number) is the main column.
 *  `cellClass` must stay a COMPLETE literal string — Tailwind only emits CSS
 *  for class names it can see literally in source. */
const COLUMNS = [
  { key: 'contactName', labelKey: 'tickets.column_contact', editable: false, cellClass: 'hidden md:table-cell' },
  { key: 'category', labelKey: 'tickets.column_category', editable: true, cellClass: 'hidden lg:table-cell' },
  { key: 'priority', labelKey: 'tickets.column_priority', editable: true, cellClass: 'table-cell' },
  { key: 'status', labelKey: 'tickets.column_status', editable: true, cellClass: 'table-cell' },
  { key: 'createdAt', labelKey: 'tickets.column_created', editable: false, cellClass: 'hidden sm:table-cell' },
] as const
type ColumnKey = (typeof COLUMNS)[number]['key']

const COLUMN_ICONS: Record<ColumnKey, React.ReactNode> = {
  contactName: <User className="size-3.5" />,
  category: <Tag className="size-3.5" />,
  priority: <Flag className="size-3.5" />,
  status: <Loader2 className="size-3.5" />,
  createdAt: <CalendarDays className="size-3.5" />,
}

const SORTS: { field: TicketSortField; labelKey: string }[] = [
  { field: 'createdAt', labelKey: 'tickets.sort_created' },
  { field: 'number', labelKey: 'tickets.sort_number' },
  { field: 'subject', labelKey: 'tickets.sort_subject' },
  { field: 'priority', labelKey: 'tickets.sort_priority' },
  { field: 'status', labelKey: 'tickets.sort_status' },
]

const FILTER_FIELDS: { field: TicketFilter['field']; labelKey: string }[] = [
  { field: 'subject', labelKey: 'tickets.column_subject' },
  { field: 'category', labelKey: 'tickets.column_category' },
  { field: 'status', labelKey: 'tickets.column_status' },
  { field: 'priority', labelKey: 'tickets.column_priority' },
]
const TEXT_OPS: TicketFilter['op'][] = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'isEmpty',
  'isNotEmpty',
]
const isEnumField = (f: TicketFilter['field']) => f === 'status' || f === 'priority'
const OP_NEEDS_VALUE = (op: TicketFilter['op']) =>
  op !== 'isEmpty' && op !== 'isNotEmpty'

export default function TicketsPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session, ready } = useStoredSession()
  const [items, setItems] = useState<SupportTicketDTO[] | null>(null)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<TicketSortField>('createdAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [filters, setFilters] = useState<TicketFilter[]>([])
  const [draft, setDraft] = useState<{
    field: TicketFilter['field']
    op: TicketFilter['op']
    value: string
  } | null>(null)
  const [hidden, setHidden] = useState<Set<ColumnKey>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const raw = window.localStorage.getItem('cosmika.tickets.hiddenColumns')
      return new Set(raw ? (JSON.parse(raw) as ColumnKey[]) : [])
    } catch {
      return new Set()
    }
  })
  // `seed` carries the typed character for type-over edits (category only —
  // the enum columns open a picker, where a seed has no meaning).
  const [editing, setEditing] = useState<{
    id: string
    field: string
    seed?: string
  } | null>(null)
  const [savingCell, setSavingCell] = useState(false)
  const [views, setViews] = useState<SavedViewDTO[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [savingView, setSavingView] = useState(false)
  const [viewName, setViewName] = useState('')
  const [viewToDelete, setViewToDelete] = useState<SavedViewDTO | null>(null)
  // Which record the side panel shows; derived from items so optimistic
  // saves update the panel too.
  const [panelId, setPanelId] = useState<string | null>(null)

  const canMutate = Boolean(
    session && MUTATE_ROLES.includes(session.membership.role),
  )

  const visibleCols = COLUMNS.filter((c) => !hidden.has(c.key))
  const panelTicket = panelId ? items?.find((x) => x.id === panelId) ?? null : null

  const grid = useCellGrid({
    rows: items?.length ?? 0,
    cols: visibleCols.length,
    editing: editing !== null,
    canEdit: (r, c) => canMutate && Boolean(visibleCols[c]?.editable && items?.[r]),
    onEdit: (r, c, seed) => {
      const ticket = items?.[r]
      const col = visibleCols[c]
      if (ticket && col) setEditing({ id: ticket.id, field: col.key, seed })
    },
  })

  function toggleColumn(key: ColumnKey) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(
          'cosmika.tickets.hiddenColumns',
          JSON.stringify([...next]),
        )
      } catch {
        /* private mode — the preference just won't persist */
      }
      return next
    })
  }

  const load = useCallback(async () => {
    if (!session) return
    try {
      const r = await api.listTickets(session.session.token, session.account.id, {
        q: appliedSearch || undefined,
        sort,
        dir,
        filters: filters.length ? filters : undefined,
      })
      setItems(r)
      setError(null)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, appliedSearch, sort, dir, filters, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!ready || !session) return
    api
      .listSavedViews(session.session.token, session.account.id, 'TICKETS')
      .then(setViews)
      .catch(() => undefined) // tabs are an enhancement, never a blocker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.session.token])

  /** Persist one edited cell. Optimistic with rollback, like contacts. */
  async function saveCell(ticket: SupportTicketDTO, field: string, value: string) {
    setEditing(null)
    if (!session) return
    const current = (ticket as unknown as Record<string, string | null>)[field]
    const next = field === 'category' ? value.trim() || null : value
    if ((current ?? null) === next) return
    setItems((prev) =>
      prev
        ? prev.map((x) => (x.id === ticket.id ? { ...x, [field]: next } : x))
        : prev,
    )
    setSavingCell(true)
    try {
      await api.updateTicket(session.session.token, session.account.id, ticket.id, {
        [field]: next,
      } as never)
    } catch (err) {
      setItems((prev) =>
        prev
          ? prev.map((x) => (x.id === ticket.id ? { ...x, [field]: current } : x))
          : prev,
      )
      setError(
        err instanceof ApiError && err.status === 403
          ? t('tickets.forbidden')
          : t('auth.generic_error'),
      )
    } finally {
      setSavingCell(false)
    }
  }

  function currentConfig(): TicketViewConfig {
    return { filters, sort, dir, hiddenColumns: [...hidden] }
  }

  function applyView(v: SavedViewDTO | null) {
    setActiveViewId(v?.id ?? null)
    const cfg = (v?.filters ?? null) as TicketViewConfig | null
    setFilters(cfg?.filters ?? [])
    setSort((cfg?.sort as TicketSortField) ?? 'createdAt')
    setDir(cfg?.dir ?? 'desc')
    const cols = new Set((cfg?.hiddenColumns ?? []) as ColumnKey[])
    setHidden(cols)
    setDraft(null)
  }

  async function saveCurrentAsView() {
    if (!session || !viewName.trim()) return
    setSavingView(true)
    try {
      const created = await api.createSavedView(session.session.token, session.account.id, {
        name: viewName.trim(),
        entity: 'TICKETS',
        filters: currentConfig(),
      })
      setViews((prev) => [...prev, created])
      setActiveViewId(created.id)
      setViewName('')
    } catch {
      setError(t('auth.generic_error'))
    } finally {
      setSavingView(false)
    }
  }

  async function deleteView(v: SavedViewDTO) {
    if (!session) return
    try {
      await api.deleteSavedView(session.session.token, session.account.id, v.id)
      setViews((prev) => prev.filter((x) => x.id !== v.id))
      if (activeViewId === v.id) applyView(null)
    } catch {
      setError(t('auth.generic_error'))
    } finally {
      setViewToDelete(null)
    }
  }

  const activeFilterCount = filters.length
  const isFiltered = activeFilterCount > 0 || appliedSearch !== ''

  if (!ready) return null

  return (
    /* Twenty-style shell: full-bleed grid, only the table region scrolls,
       record panel docked right. */
    <main className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <TicketIcon className="size-4 text-muted-foreground" />
          {t('tickets.title')}
        </span>
      </div>

      {/* View bar, Twenty layout: current view + count left; search, sort,
          filters and columns as quiet controls right. All server-side. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <ViewSwitcher
          views={views}
          activeViewId={activeViewId}
          count={items?.length ?? null}
          dirty={
            activeViewId === null &&
            (filters.length > 0 || sort !== 'createdAt' || dir !== 'desc')
          }
          saving={savingView}
          viewName={viewName}
          labels={{
            defaultName: t('tickets.all'),
            save: t('tickets.view_save'),
            namePlaceholder: t('tickets.view_name_placeholder'),
            delete: t('tickets.view_delete'),
          }}
          onViewNameChange={setViewName}
          onSelect={applyView}
          onSave={() => void saveCurrentAsView()}
          onDelete={setViewToDelete}
        />
        <div className="flex items-center gap-1.5">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setAppliedSearch(search.trim())
          }}
        >
          <Input
            placeholder={t('tickets.search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-48 text-xs"
            data-testid="search-input"
          />
        </form>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" data-testid="sort-menu">
              {t('tickets.sort')}: {t(SORTS.find((x) => x.field === sort)!.labelKey)}
              {dir === 'asc' ? ' ↑' : ' ↓'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('tickets.sort')}</DropdownMenuLabel>
            {SORTS.map((o) => (
              <DropdownMenuItem
                key={o.field}
                onSelect={() => setSort(o.field)}
                data-testid={`sort-${o.field}`}
              >
                {t(o.labelKey)}
                {sort === o.field ? ' ✓' : ''}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
              data-testid="sort-direction"
            >
              {dir === 'asc' ? '↓' : '↑'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" data-testid="filter-menu">
              + {t('tickets.filters')}
              {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('tickets.filter_pick_field')}</DropdownMenuLabel>
            {FILTER_FIELDS.map((f) => (
              <DropdownMenuItem
                key={f.field}
                onSelect={() =>
                  setDraft(
                    isEnumField(f.field)
                      ? {
                          field: f.field,
                          op: 'is',
                          value: f.field === 'status' ? 'OPEN' : 'NORMAL',
                        }
                      : { field: f.field, op: 'contains', value: '' },
                  )
                }
                data-testid={`filter-field-${f.field}`}
              >
                {t(f.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" data-testid="columns-menu">
              {t('tickets.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('tickets.columns')}</DropdownMenuLabel>
            {COLUMNS.map((c) => (
              <DropdownMenuItem
                key={c.key}
                onSelect={(e) => {
                  e.preventDefault()
                  toggleColumn(c.key)
                }}
                data-testid={`column-${c.key}`}
              >
                {t(c.labelKey)}
                {hidden.has(c.key) ? '' : ' ✓'}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>

      {/* Active filters as removable chips, plus the one being composed. */}
      {(filters.length > 0 || draft) && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
          data-testid="filter-chips"
        >
          {filters.map((f, i) => (
            <span
              key={`${f.field}-${f.op}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-1 text-xs"
              data-testid={`filter-chip-${f.field}`}
            >
              <span className="text-muted-foreground">
                {t(FILTER_FIELDS.find((x) => x.field === f.field)!.labelKey)}
              </span>
              <span className="font-medium">{t(`tickets.op_${f.op}` as never)}</span>
              {OP_NEEDS_VALUE(f.op) ? (
                <span className="font-medium">
                  {f.field === 'status'
                    ? t(`tickets.status_${(f.value ?? '').toLowerCase()}` as never)
                    : f.field === 'priority'
                      ? t(`tickets.priority_${(f.value ?? '').toLowerCase()}` as never)
                      : f.value}
                </span>
              ) : null}
              <button
                type="button"
                className="ml-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t('tickets.filter_remove')}
                onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
                data-testid={`filter-remove-${i}`}
              >
                ×
              </button>
            </span>
          ))}

          {draft ? (
            <form
              className="inline-flex items-center gap-1.5 rounded-sm border border-dashed border-border px-2 py-1"
              data-testid="filter-draft"
              onSubmit={(e) => {
                e.preventDefault()
                const value = OP_NEEDS_VALUE(draft.op) ? draft.value.trim() : undefined
                if (OP_NEEDS_VALUE(draft.op) && !value) return
                setFilters((prev) => [...prev, { field: draft.field, op: draft.op, value }])
                setDraft(null)
              }}
            >
              <span className="text-xs text-muted-foreground">
                {t(FILTER_FIELDS.find((x) => x.field === draft.field)!.labelKey)}
              </span>
              {isEnumField(draft.field) ? (
                <>
                  <Select
                    value={draft.op}
                    onValueChange={(v) =>
                      setDraft({ ...draft, op: v as TicketFilter['op'] })
                    }
                  >
                    <SelectTrigger
                      className="h-6 w-24 px-1.5 text-xs"
                      aria-label={t('tickets.filter_pick_op')}
                      data-testid="filter-draft-op"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="is">{t('tickets.op_is')}</SelectItem>
                      <SelectItem value="isNot">{t('tickets.op_isNot')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={draft.value}
                    onValueChange={(v) => setDraft({ ...draft, value: v })}
                  >
                    <SelectTrigger
                      className="h-6 w-28 px-1.5 text-xs"
                      aria-label={t('tickets.filter_value')}
                      data-testid="filter-draft-value"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(draft.field === 'status' ? STATUSES : PRIORITIES).map((v) => (
                        <SelectItem key={v} value={v}>
                          {draft.field === 'status'
                            ? t(`tickets.status_${v.toLowerCase()}` as never)
                            : t(`tickets.priority_${v.toLowerCase()}` as never)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <Select
                    value={draft.op}
                    onValueChange={(v) =>
                      setDraft({ ...draft, op: v as TicketFilter['op'] })
                    }
                  >
                    <SelectTrigger
                      className="h-6 w-32 px-1.5 text-xs"
                      aria-label={t('tickets.filter_pick_op')}
                      data-testid="filter-draft-op"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEXT_OPS.filter(
                        (op) =>
                          draft.field !== 'subject' ||
                          !['isEmpty', 'isNotEmpty'].includes(op),
                      ).map((op) => (
                        <SelectItem key={op} value={op}>
                          {t(`tickets.op_${op}` as never)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {OP_NEEDS_VALUE(draft.op) ? (
                    <Input
                      autoFocus
                      value={draft.value}
                      onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                      placeholder={t('tickets.filter_value')}
                      className="h-6 w-32 text-xs"
                      data-testid="filter-draft-value"
                    />
                  ) : null}
                </>
              )}
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                data-testid="filter-apply"
              >
                {t('tickets.filter_apply')}
              </Button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('tickets.filter_remove')}
                onClick={() => setDraft(null)}
              >
                ×
              </button>
            </form>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="px-4 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
      {items === null ? (
        <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t('tickets.empty')}</p>
      ) : (
        <Table
          className="text-[13px] [&_td]:py-1 [&_th]:h-8"
          containerClassName="rounded-none border-0"
        >
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  {t('tickets.column_subject')}
                </span>
              </TableHead>
              {visibleCols.map((c) => (
                <TableHead key={c.key} className={`${c.cellClass} border-l border-border`}>
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    {COLUMN_ICONS[c.key]}
                    {t(c.labelKey)}
                  </span>
                </TableHead>
              ))}
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((tk, rowIdx) => (
              <TableRow key={tk.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{tk.number}
                    </span>
                    {/* One-page editing: the subject opens the record side
                        panel; the conversation stays reachable from there
                        and from the row actions menu. */}
                    <button
                      type="button"
                      onClick={() => setPanelId(tk.id)}
                      className="truncate text-left font-medium hover:underline"
                      data-testid={`ticket-${tk.id}`}
                    >
                      {tk.subject}
                    </button>
                  </div>
                </TableCell>
                {visibleCols.map((col, colIdx) => {
                  const isEditing = editing?.id === tk.id && editing.field === col.key
                  const cellShell = (children: React.ReactNode) => (
                    <TableCell
                      key={col.key}
                      {...grid.cellProps(rowIdx, colIdx)}
                      data-testid={`cell-${col.key}-${tk.id}`}
                      className={`${col.cellClass} border-l border-border outline-none ${
                        grid.isFocused(rowIdx, colIdx)
                          ? 'ring-1 ring-inset ring-ring'
                          : ''
                      }`}
                      onClick={
                        col.key === 'category'
                          ? () =>
                              canMutate && !isEditing
                                ? setEditing({ id: tk.id, field: col.key })
                                : undefined
                          : undefined
                      }
                    >
                      {children}
                    </TableCell>
                  )

                  if (col.key === 'priority' || col.key === 'status') {
                    const isStatus = col.key === 'status'
                    const value = isStatus ? tk.status : tk.priority
                    const options = isStatus ? STATUSES : PRIORITIES
                    const label = (v: string) =>
                      t(
                        `tickets.${isStatus ? 'status' : 'priority'}_${v.toLowerCase()}` as never,
                      )
                    // Fully controlled menu: the grid's Enter/type-over opens
                    // it via `editing`; a plain click opens it through
                    // onOpenChange. Either path closes back into the cell.
                    return (
                      <DropdownMenu
                        key={col.key}
                        open={isEditing}
                        onOpenChange={(o) =>
                          canMutate
                            ? setEditing(o ? { id: tk.id, field: col.key } : null)
                            : undefined
                        }
                      >
                        {cellShell(
                          <>
                            <DropdownMenuTrigger asChild disabled={!canMutate}>
                              <button
                                type="button"
                                className="inline-flex max-w-full"
                                title={canMutate ? t('tickets.edit_hint') : undefined}
                                data-testid={`pick-${col.key}-${tk.id}`}
                              >
                                <Badge
                                  variant={
                                    isStatus
                                      ? statusVariant(value)
                                      : priorityVariant(value)
                                  }
                                >
                                  {label(value)}
                                </Badge>
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {options.map((v) => (
                                <DropdownMenuItem
                                  key={v}
                                  disabled={savingCell}
                                  onSelect={() => saveCell(tk, col.key, v)}
                                  data-testid={`option-${col.key}-${v}-${tk.id}`}
                                >
                                  {label(v)}
                                  {v === value ? ' ✓' : ''}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </>,
                        )}
                      </DropdownMenu>
                    )
                  }

                  if (col.key === 'category') {
                    const raw = tk.category
                    return cellShell(
                      isEditing ? (
                        <Input
                          autoFocus
                          defaultValue={editing?.seed ?? raw ?? ''}
                          disabled={savingCell}
                          className="h-7 text-sm"
                          aria-label={t(col.labelKey)}
                          data-testid={`edit-category-${tk.id}`}
                          onBlur={(e) => saveCell(tk, 'category', e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                            // Escape must abandon the edit, not save it.
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                      ) : raw ? (
                        <span
                          className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground ${
                            canMutate ? 'cursor-text' : ''
                          }`}
                          title={canMutate ? t('tickets.edit_hint') : undefined}
                        >
                          {COLUMN_ICONS.category}
                          <span className="truncate">{raw}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      ),
                    )
                  }

                  if (col.key === 'contactName') {
                    return cellShell(
                      tk.contactName ? (
                        <span className="inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground">
                          {COLUMN_ICONS.contactName}
                          <span className="truncate">{tk.contactName}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      ),
                    )
                  }

                  // createdAt
                  return cellShell(
                    <span className="text-xs text-muted-foreground">
                      {fmt.date(tk.createdAt)}
                    </span>,
                  )
                })}
                <TableCell className="pl-0 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-muted-foreground"
                        aria-label={t('tickets.title')}
                        data-testid={`actions-${tk.id}`}
                      >
                        ⋯
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {tk.conversationId ? (
                        <DropdownMenuItem asChild>
                          <Link href={`/conversations/${tk.conversationId}`}>
                            {t('tickets.open_conversation')}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {canMutate ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            saveCell(
                              tk,
                              'status',
                              tk.status === 'CLOSED' ? 'OPEN' : 'CLOSED',
                            )
                          }
                          data-testid={`action-toggle-${tk.id}`}
                        >
                          {tk.status === 'CLOSED'
                            ? t('tickets.reopen')
                            : t('tickets.close')}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={viewToDelete !== null} onOpenChange={(o) => !o && setViewToDelete(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('tickets.view_delete')}</DialogTitle>
            <DialogDescription>
              {viewToDelete
                ? t('tickets.view_delete_confirm', { name: viewToDelete.name })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewToDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => viewToDelete && deleteView(viewToDelete)}
              data-testid="view-delete-confirm"
            >
              {t('tickets.view_delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
      </div>

      {panelTicket ? (
        <TicketRecordPanel
          ticket={panelTicket}
          canMutate={canMutate}
          busy={savingCell}
          onClose={() => setPanelId(null)}
          onSaveField={saveCell}
        />
      ) : null}
      </main>
  )
}
