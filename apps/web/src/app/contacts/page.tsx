'use client'

import Link from 'next/link'
import { Link2, Mail, Phone, User } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BulkContactAction,
  ContactDTO,
  ContactFilter,
  ContactSortField,
  ContactViewConfig,
  SavedViewDTO,
} from '@cosmika/shared'
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  buttonVariants,
  avatarColor,
  initialsOf,
} from '@cosmika/ui'

import { ApiError, api } from '../../lib/api'
import { useStoredSession } from '../../lib/session-store'
import { useCellGrid } from '../../lib/use-cell-grid'
import { ViewSwitcher } from '../../components/view-switcher'
import { ContactRecordPanel } from './_record-panel'

const MUTATE_ROLES = ['ADMINISTRATOR', 'SUPERVISOR']

/** Columns the user can hide, and which are editable in place.
 *
 * `cellClass` is a COMPLETE literal Tailwind string. It was previously built
 * as `hidden ${breakpoint}:table-cell`, and Tailwind only generates CSS for
 * class names it can see literally in source — so `sm:table-cell` never
 * existed, `hidden` won at every width, and all three columns were invisible
 * on every screen while the Columns menu showed them as enabled. */
const COLUMNS = [
  {
    key: 'email',
    labelKey: 'contacts.column_email',
    editable: true,
    cellClass: 'hidden sm:table-cell',
  },
  {
    key: 'phoneNumber',
    labelKey: 'contacts.column_phone',
    editable: true,
    cellClass: 'hidden md:table-cell',
  },
  {
    key: 'identifier',
    labelKey: 'contacts.column_source',
    editable: false,
    cellClass: 'hidden lg:table-cell',
  },
] as const
type ColumnKey = (typeof COLUMNS)[number]['key']

/** Twenty-style muted icon next to each column label. */
const COLUMN_ICONS: Record<ColumnKey, React.ReactNode> = {
  email: <Mail className="size-3.5" />,
  phoneNumber: <Phone className="size-3.5" />,
  identifier: <Link2 className="size-3.5" />,
}

const SORTS: { field: ContactSortField; labelKey: string }[] = [
  { field: 'createdAt', labelKey: 'contacts.sort_created' },
  { field: 'name', labelKey: 'contacts.sort_name' },
  { field: 'email', labelKey: 'contacts.sort_email' },
  { field: 'lastActivityAt', labelKey: 'contacts.sort_activity' },
]

/** Field + operator metadata for the filter builder. */
const FILTER_FIELDS: { field: ContactFilter['field']; labelKey: string }[] = [
  { field: 'name', labelKey: 'contacts.column_name' },
  { field: 'email', labelKey: 'contacts.column_email' },
  { field: 'phoneNumber', labelKey: 'contacts.column_phone' },
  { field: 'identifier', labelKey: 'contacts.column_source' },
  { field: 'blocked', labelKey: 'contacts.filter_blocked' },
]
const TEXT_OPS: ContactFilter['op'][] = [
  'contains',
  'notContains',
  'is',
  'isNot',
  'isEmpty',
  'isNotEmpty',
]
const OP_NEEDS_VALUE = (op: ContactFilter['op']) =>
  op !== 'isEmpty' && op !== 'isNotEmpty'

export default function ContactsPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [items, setItems] = useState<ContactDTO[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [sort, setSort] = useState<ContactSortField>('createdAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [filters, setFilters] = useState<ContactFilter[]>([])
  // The filter being composed: field picked, operator/value pending.
  const [draft, setDraft] = useState<{
    field: ContactFilter['field']
    op: ContactFilter['op']
    value: string
  } | null>(null)
  // Column visibility is a per-user preference, so it belongs in localStorage
  // rather than the server — losing it costs nothing.
  const [hidden, setHidden] = useState<Set<ColumnKey>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const raw = window.localStorage.getItem('cosmika.contacts.hiddenColumns')
      return new Set(raw ? (JSON.parse(raw) as ColumnKey[]) : [])
    } catch {
      return new Set()
    }
  })
  // `seed` is set when an edit starts by typing over a focused cell: the
  // editor opens with the typed character replacing the value (spreadsheet
  // semantics), not appended to it.
  const [editing, setEditing] = useState<{
    id: string
    field: string
    seed?: string
  } | null>(null)
  const [views, setViews] = useState<SavedViewDTO[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [savingView, setSavingView] = useState(false)
  const [viewName, setViewName] = useState('')
  const [viewToDelete, setViewToDelete] = useState<SavedViewDTO | null>(null)
  const [savingCell, setSavingCell] = useState(false)
  // Which record the side panel shows. Derived from items so optimistic cell
  // saves update the panel too.
  const [panelId, setPanelId] = useState<string | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  function toggleColumn(key: ColumnKey) {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        window.localStorage.setItem(
          'cosmika.contacts.hiddenColumns',
          JSON.stringify([...next]),
        )
      } catch {
        /* private mode — the preference just won't persist */
      }
      return next
    })
  }

  const canMutate = Boolean(
    session && MUTATE_ROLES.includes(session.membership.role),
  )

  const visibleCols = COLUMNS.filter((c) => !hidden.has(c.key))
  const panelContact = panelId
    ? items?.find((c) => c.id === panelId) ?? null
    : null

  const grid = useCellGrid({
    rows: items?.length ?? 0,
    cols: visibleCols.length,
    editing: editing !== null,
    canEdit: (r, c) => canMutate && Boolean(visibleCols[c]?.editable && items?.[r]),
    onEdit: (r, c, seed) => {
      const contact = items?.[r]
      const col = visibleCols[c]
      if (contact && col) setEditing({ id: contact.id, field: col.key, seed })
    },
  })

  const load = useCallback(
    async (reset: boolean) => {
      if (!session) return
      setLoading(true)
      setError(null)
      try {
        const page = await api.listContacts(
          session.session.token,
          session.account.id,
          {
            q: appliedSearch || undefined,
            cursor: reset ? undefined : cursor ?? undefined,
            sort,
            dir,
            filters: filters.length ? filters : undefined,
          },
        )
        setCursor(page.nextCursor)
        setTotal(page.total)
        setItems((prev) => (reset || !prev ? page.data : [...prev, ...page.data]))
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('contacts.forbidden'))
        } else {
          setError(t('auth.generic_error'))
        }
      } finally {
        setLoading(false)
      }
    },
    [session, appliedSearch, cursor, sort, dir, filters, t],
  )

  // Seamless pagination: when the sentinel under the last row scrolls into
  // reach, fetch the next page. Guarded for jsdom (no IntersectionObserver).
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !cursor || loading || typeof IntersectionObserver === 'undefined')
      return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void load(false)
      },
      { rootMargin: '400px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [cursor, loading, load])

  useEffect(() => {
    if (!ready || !session) return
    api
      .listSavedViews(session.session.token, session.account.id, 'CONTACTS')
      .then(setViews)
      .catch(() => undefined) // tabs are an enhancement, never a blocker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.session.token])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    setSelected(new Set())
    load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session, router, appliedSearch, sort, dir, filters])

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }

  function onSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAppliedSearch(search.trim())
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = Boolean(
    items && items.length > 0 && items.every((c) => selected.has(c.id)),
  )

  function toggleAll() {
    setSelected((prev) => {
      if (!items) return prev
      if (items.every((c) => prev.has(c.id))) return new Set()
      return new Set(items.map((c) => c.id))
    })
  }

  /** Persist one edited cell. Optimistic: the row updates immediately and
      rolls back if the request fails, so typing never feels laggy. */
  async function saveCell(contact: ContactDTO, field: string, value: string) {
    setEditing(null)
    const trimmed = value.trim()
    const current = (contact as unknown as Record<string, string | null>)[field]
    if ((current ?? '') === trimmed) return
    if (!session) return
    const next = trimmed === '' ? null : trimmed
    setItems((prev) =>
      prev
        ? prev.map((c) => (c.id === contact.id ? { ...c, [field]: next } : c))
        : prev,
    )
    setSavingCell(true)
    try {
      await api.updateContact(session.session.token, session.account.id, contact.id, {
        [field]: next,
      } as never)
    } catch (err) {
      // Put the old value back rather than leaving a lie on screen.
      setItems((prev) =>
        prev
          ? prev.map((c) => (c.id === contact.id ? { ...c, [field]: current } : c))
          : prev,
      )
      setError(
        err instanceof ApiError && err.status === 403
          ? t('contacts.forbidden')
          : t('auth.generic_error'),
      )
    } finally {
      setSavingCell(false)
    }
  }

  async function rowAction(contact: ContactDTO, action: BulkContactAction) {
    if (!session) return
    if (
      action === 'delete' &&
      !window.confirm(t('contacts.bulk_confirm_delete', { count: 1 }))
    ) {
      return
    }
    try {
      await api.bulkContactAction(
        session.session.token,
        session.account.id,
        [contact.id],
        action,
      )
      await load(true)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? t('contacts.forbidden')
          : t('auth.generic_error'),
      )
    }
  }

  const activeFilterCount = filters.length

  /** The grid state a view snapshots. */
  function currentConfig(): ContactViewConfig {
    return { filters, sort, dir, hiddenColumns: [...hidden] }
  }

  function applyView(v: SavedViewDTO | null) {
    setActiveViewId(v?.id ?? null)
    setDraft(null)
    if (!v) {
      setFilters([])
      setSort('createdAt')
      setDir('desc')
      return
    }
    const cfg = v.filters as ContactViewConfig
    setFilters(cfg.filters ?? [])
    setSort(cfg.sort ?? 'createdAt')
    setDir(cfg.dir ?? 'desc')
    setHidden(new Set((cfg.hiddenColumns ?? []) as ColumnKey[]))
  }

  async function saveCurrentAsView() {
    if (!session || !viewName.trim()) return
    setSavingView(true)
    try {
      const created = await api.createSavedView(session.session.token, session.account.id, {
        name: viewName.trim(),
        entity: 'CONTACTS',
        filters: currentConfig(),
      } as never)
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

  async function runBulk(action: BulkContactAction) {
    if (!session || selected.size === 0) return
    const ids = [...selected]
    if (
      action === 'delete' &&
      !window.confirm(t('contacts.bulk_confirm_delete', { count: ids.length }))
    ) {
      return
    }
    setBulkBusy(true)
    setError(null)
    try {
      await api.bulkContactAction(
        session.session.token,
        session.account.id,
        ids,
        action,
      )
      setSelected(new Set())
      await load(true)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? t('contacts.forbidden')
          : t('auth.generic_error'),
      )
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    /* Twenty-style shell: the grid fills the viewport edge to edge; only the
       table region scrolls, and the record panel docks on the right. */
    <main className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <User className="size-4 text-muted-foreground" />
          {t('contacts.title')}
        </span>
        <Link
          href="/contacts/new"
          className={buttonVariants({ variant: 'default', size: 'sm' })}
          data-testid="create-contact"
        >
          {t('contacts.create')}
        </Link>
      </div>

      {/* View bar, Twenty layout: current view + count on the left; search,
          sort, filters and columns as quiet controls on the right. Sorting
          and filtering hit the API, so they apply across every page. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <ViewSwitcher
          views={views}
          activeViewId={activeViewId}
          count={total}
          dirty={
            activeViewId === null &&
            (filters.length > 0 || sort !== 'createdAt' || dir !== 'desc')
          }
          saving={savingView}
          viewName={viewName}
          labels={{
            defaultName: t('contacts.view_all'),
            save: t('contacts.view_save'),
            namePlaceholder: t('contacts.view_name_placeholder'),
            delete: t('contacts.view_delete'),
          }}
          onViewNameChange={setViewName}
          onSelect={applyView}
          onSave={() => void saveCurrentAsView()}
          onDelete={setViewToDelete}
        />
        <div className="flex items-center gap-1.5">
        <form onSubmit={onSearchSubmit}>
          <Input
            placeholder={t('contacts.search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 w-48 text-xs"
            data-testid="search-input"
          />
        </form>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" data-testid="sort-menu">
              {t('contacts.sort')}: {t(SORTS.find((x) => x.field === sort)!.labelKey)}
              {dir === 'asc' ? ' ↑' : ' ↓'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('contacts.sort')}</DropdownMenuLabel>
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
              {dir === 'asc' ? t('contacts.sort_desc') : t('contacts.sort_asc')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" data-testid="filter-menu">
              + {t('contacts.filters')}
              {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('contacts.filter_pick_field')}</DropdownMenuLabel>
            {FILTER_FIELDS.map((f) => (
              <DropdownMenuItem
                key={f.field}
                onSelect={() =>
                  setDraft(
                    f.field === 'blocked'
                      ? { field: 'blocked', op: 'is', value: 'true' }
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
              {t('contacts.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('contacts.columns')}</DropdownMenuLabel>
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

      {/* Active filters as removable chips, plus the one being composed.
          Filters are server-side, so each chip narrows all 7.5k rows and the
          record count follows. */}
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
              <span className="font-medium">{t(`contacts.op_${f.op}`)}</span>
              {OP_NEEDS_VALUE(f.op) ? (
                <span className="font-medium">
                  {f.field === 'blocked'
                    ? f.value === 'true'
                      ? t('common.yes')
                      : t('common.no')
                    : f.value}
                </span>
              ) : null}
              <button
                type="button"
                className="ml-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t('contacts.filter_remove')}
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
                setFilters((prev) => [
                  ...prev,
                  { field: draft.field, op: draft.op, value },
                ])
                setDraft(null)
              }}
            >
              <span className="text-xs text-muted-foreground">
                {t(FILTER_FIELDS.find((x) => x.field === draft.field)!.labelKey)}
              </span>
              {draft.field === 'blocked' ? (
                <Select
                  value={draft.value}
                  onValueChange={(v) => setDraft({ ...draft, value: v })}
                >
                  <SelectTrigger
                    className="h-6 w-20 px-1.5 text-xs"
                    aria-label={t('contacts.filter_blocked')}
                    data-testid="filter-draft-blocked"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">{t('common.yes')}</SelectItem>
                    <SelectItem value="false">{t('common.no')}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Select
                    value={draft.op}
                    onValueChange={(v) =>
                      setDraft({ ...draft, op: v as ContactFilter['op'] })
                    }
                  >
                    <SelectTrigger
                      className="h-6 w-32 px-1.5 text-xs"
                      aria-label={t('contacts.filter_pick_op')}
                      data-testid="filter-draft-op"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEXT_OPS.map((op) => (
                        <SelectItem key={op} value={op}>
                          {t(`contacts.op_${op}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {OP_NEEDS_VALUE(draft.op) ? (
                    <Input
                      autoFocus
                      className="h-6 w-36 text-xs"
                      value={draft.value}
                      onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                      aria-label={t('contacts.filter_value')}
                      data-testid="filter-draft-value"
                    />
                  ) : null}
                </>
              )}
              <Button type="submit" size="sm" className="h-6 px-2 text-xs" data-testid="filter-draft-apply">
                {t('contacts.filter_apply')}
              </Button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setDraft(null)}
                data-testid="filter-draft-cancel"
              >
                ×
              </button>
            </form>
          ) : null}

          {filters.length > 0 ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setFilters([])}
              data-testid="filter-clear-all"
            >
              {t('contacts.filters_clear')}
            </button>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="px-4 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {canMutate && selected.size > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2"
          data-testid="bulk-bar"
        >
          <span className="text-sm font-medium" data-testid="bulk-count">
            {t('contacts.bulk_selected', { count: selected.size })}
          </span>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => setSelected(new Set())}
            data-testid="bulk-clear"
          >
            {t('contacts.bulk_clear')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => runBulk('block')}
            data-testid="bulk-block"
          >
            {t('contacts.bulk_block')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => runBulk('unblock')}
            data-testid="bulk-unblock"
          >
            {t('contacts.bulk_unblock')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={bulkBusy}
            onClick={() => runBulk('delete')}
            data-testid="bulk-delete"
          >
            {t('contacts.bulk_delete')}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
      {items === null && loading ? (
        <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}

      {items && items.length === 0 && !loading ? (
        <p className="p-4 text-sm text-muted-foreground">
          {appliedSearch ? t('contacts.no_results') : t('contacts.empty')}
        </p>
      ) : null}

      {items && items.length > 0 ? (
        /* Record table (Twenty-style): one dense row per contact with real
           columns, not a card per record. Fields that were crammed into a
           single "a · b · c" line now each own a column, which is what makes
           a list of 5,000 contacts scannable. */
        <Table
          className="text-[13px] [&_td]:py-1 [&_th]:h-8"
          containerClassName="rounded-none border-0"
        >
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {canMutate ? (
                <TableHead className="w-10 pr-0">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label={t('contacts.select_all')}
                    data-testid="select-all"
                  />
                </TableHead>
              ) : null}
              <TableHead>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <User className="size-3.5" />
                  {t('contacts.column_name')}
                </span>
              </TableHead>
              {visibleCols.map((c) => (
                <TableHead
                  key={c.key}
                  className={`${c.cellClass} border-l border-border`}
                >
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
            {items.map((contact, rowIdx) => {
              // `??` alone misses empty strings, which is how blank-named
              // contacts ended up rendering as empty rows.
              const firstFilled = (...vals: (string | null)[]) =>
                vals.find((v) => v != null && v.trim() !== '')
              const display =
                firstFilled(
                  contact.name,
                  contact.email,
                  contact.phoneNumber,
                  contact.identifier,
                ) ?? contact.id
              return (
                <TableRow
                  key={contact.id}
                  data-state={selected.has(contact.id) ? 'selected' : undefined}
                >
                  {canMutate ? (
                    <TableCell className="pr-0">
                      <Checkbox
                        checked={selected.has(contact.id)}
                        onCheckedChange={() => toggleOne(contact.id)}
                        aria-label={display}
                        data-testid={`select-${contact.id}`}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="size-6 shrink-0">
                        <AvatarFallback
                          className="text-[10px]"
                          style={avatarColor(display)}
                        >
                          {initialsOf(display)}
                        </AvatarFallback>
                      </Avatar>
                      {/* One-page editing: the name opens the record side
                          panel; the full page stays reachable from there and
                          from the row actions menu. */}
                      <button
                        type="button"
                        onClick={() => setPanelId(contact.id)}
                        className="truncate font-medium hover:underline"
                        data-testid={`contact-${contact.id}`}
                      >
                        {display}
                      </button>
                      {contact.blockedAt ? (
                        <Badge
                          variant="destructive"
                          data-testid={`blocked-${contact.id}`}
                        >
                          {t('contacts.bulk_block')}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  {visibleCols.map((col, colIdx) => {
                    const raw = (contact as unknown as Record<string, string | null>)[
                      col.key
                    ]
                    const isEditing =
                      editing?.id === contact.id && editing.field === col.key
                    return (
                      <TableCell
                        key={col.key}
                        {...grid.cellProps(rowIdx, colIdx)}
                        data-testid={`cell-${col.key}-${contact.id}`}
                        className={`${col.cellClass} border-l border-border outline-none ${
                          grid.isFocused(rowIdx, colIdx)
                            ? 'ring-1 ring-inset ring-ring'
                            : ''
                        }`}
                        onClick={() =>
                          canMutate && col.editable && !isEditing
                            ? setEditing({ id: contact.id, field: col.key })
                            : undefined
                        }
                      >
                        {isEditing ? (
                          <Input
                            autoFocus
                            defaultValue={editing?.seed ?? raw ?? ''}
                            disabled={savingCell}
                            className="h-7 text-sm"
                            aria-label={t(col.labelKey)}
                            data-testid={`edit-${col.key}-${contact.id}`}
                            onBlur={(e) => saveCell(contact, col.key, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur()
                              // Escape must abandon the edit, not save it.
                              if (e.key === 'Escape') setEditing(null)
                            }}
                          />
                        ) : col.key === 'identifier' ? (
                          raw ? (
                            <Badge variant="outline" className="font-mono text-[11px]">
                              {raw}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )
                        ) : raw ? (
                          /* Twenty renders values as chips, not naked text.
                             The cell (not the chip) owns the double-click so
                             the whole area still enters edit mode. */
                          <span
                            className={`inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground ${
                              canMutate && col.editable ? 'cursor-text' : ''
                            }`}
                            title={
                              canMutate && col.editable
                                ? t('contacts.edit_hint')
                                : undefined
                            }
                          >
                            {COLUMN_ICONS[col.key]}
                            <span className="truncate">{raw}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    )
                  })}
                  <TableCell className="pl-0 text-right">
                    {canMutate ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-muted-foreground"
                            aria-label={t('contacts.row_actions')}
                            data-testid={`actions-${contact.id}`}
                          >
                            ⋯
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/contacts/${contact.id}`}>
                              {t('contacts.open')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              rowAction(contact, contact.blockedAt ? 'unblock' : 'block')
                            }
                            data-testid={`action-block-${contact.id}`}
                          >
                            {contact.blockedAt
                              ? t('contacts.bulk_unblock')
                              : t('contacts.bulk_block')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => rowAction(contact, 'delete')}
                            data-testid={`action-delete-${contact.id}`}
                          >
                            {t('contacts.bulk_delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      ) : null}

      <Dialog open={viewToDelete !== null} onOpenChange={(o) => !o && setViewToDelete(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('contacts.view_delete')}</DialogTitle>
            <DialogDescription>
              {viewToDelete
                ? t('contacts.view_delete_confirm', { name: viewToDelete.name })
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
              {t('contacts.view_delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {cursor ? (
        /* Sentinel for seamless pagination: scrolling near the end loads the
           next page. The button stays as the no-IntersectionObserver
           fallback and for keyboard users. */
        <div ref={loadMoreRef} className="flex justify-center py-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => load(false)}
            disabled={loading}
            data-testid="load-more"
          >
            {loading ? t('common.loading') : t('contacts.load_more')}
          </Button>
        </div>
      ) : null}
      </div>
      </div>

      {panelContact ? (
        <ContactRecordPanel
          contact={panelContact}
          canMutate={canMutate}
          busy={savingCell || bulkBusy}
          onClose={() => setPanelId(null)}
          onSaveField={saveCell}
          onToggleBlocked={(c) => void rowAction(c, c.blockedAt ? 'unblock' : 'block')}
        />
      ) : null}
      </main>
  )
}
