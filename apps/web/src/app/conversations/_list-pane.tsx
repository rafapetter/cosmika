'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
  initialsOf,
} from '@cosmika/ui'
import {
  Bookmark,
  Bot,
  CheckSquare,
  ChevronDown,
  Plus,
  Save,
  Search,
  SlidersHorizontal,
  Square,
  Tag,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react'
import type {
  BulkConversationActionInput,
  ConversationSort,
  ConversationStatus,
  ConversationSummaryDTO,
  InboxDTO,
  LabelDTO,
  Priority,
  SavedViewDTO,
  SavedViewFilters,
  TeamDTO,
} from '@cosmika/shared'

import { ApiError, api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { useDateTime, type DateTimeTools } from '../../lib/format-datetime'
import { useStoredSession } from '../../lib/session-store'
import { useRealtime } from '../../lib/use-realtime'
import { stripWhatsAppFormatting } from '../../lib/whatsapp-format'

type StatusFilter = 'ALL' | ConversationStatus
const STATUS_TABS: StatusFilter[] = ['ALL', 'OPEN', 'PENDING', 'RESOLVED']

function statusBadgeVariant(s: ConversationStatus) {
  return s === 'OPEN' ? 'open' : s === 'PENDING' ? 'pending' : 'resolved'
}

/**
 * The leftmost pane of /conversations. Lives in the route layout so it
 * persists while the user navigates between threads.
 */
// Radix Select reserves the empty string, so "no filter" travels as a sentinel.
const ANY = '__any__'

export function ConversationListPane() {
  const t = useTranslations()
  const fmt = useDateTime()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const sp = useSearchParams()
  const { session, ready } = useStoredSession()

  const [items, setItems] = React.useState<ConversationSummaryDTO[] | null>(null)
  const [inboxes, setInboxes] = React.useState<InboxDTO[]>([])
  const [labels, setLabels] = React.useState<LabelDTO[]>([])
  const [teams, setTeams] = React.useState<TeamDTO[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<StatusFilter>('ALL')
  const [controlMode, setControlMode] = React.useState<'ALL' | 'BOT' | 'HUMAN'>('ALL')
  const [inboxId, setInboxId] = React.useState<string>('')
  const [teamId, setTeamId] = React.useState<string>('')
  const [labelId, setLabelId] = React.useState<string>('')
  const [country, setCountry] = React.useState<string>('')
  const [createdAfter, setCreatedAfter] = React.useState<string>('')
  const [createdBefore, setCreatedBefore] = React.useState<string>('')
  const [lastActivityAfter, setLastActivityAfter] = React.useState<string>('')
  const [lastActivityBefore, setLastActivityBefore] = React.useState<string>('')
  const [sort, setSort] = React.useState<ConversationSort>('ACTIVITY_DESC')
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [appliedQ, setAppliedQ] = React.useState('')
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = React.useState(false)
  const [savedViews, setSavedViews] = React.useState<SavedViewDTO[]>([])
  const [activeViewId, setActiveViewId] = React.useState<string | null>(null)

  // selected conversation id from URL
  const selectedId = React.useMemo(() => {
    const m = pathname.match(/^\/conversations\/([^/]+)/)
    return m ? m[1] : null
  }, [pathname])

  React.useEffect(() => {
    if (!session) return
    api
      .listInboxes(session.session.token, session.account.id)
      .then(setInboxes)
      .catch(() => setInboxes([]))
    api
      .listLabels(session.session.token, session.account.id)
      .then(setLabels)
      .catch(() => setLabels([]))
    api
      .listTeams(session.session.token, session.account.id)
      .then(setTeams)
      .catch(() => setTeams([]))
    api
      .listSavedViews(session.session.token, session.account.id)
      .then(setSavedViews)
      .catch(() => setSavedViews([]))
  }, [session])

  const load = React.useCallback(
    async (reset: boolean) => {
      if (!session) return
      setLoading(true)
      setError(null)
      try {
        const page = await api.listConversations(
          session.session.token,
          session.account.id,
          {
            status: status === 'ALL' ? undefined : status,
            controlMode: controlMode === 'ALL' ? undefined : controlMode,
            inboxId: inboxId || undefined,
            teamId: teamId || undefined,
            labelId: labelId || undefined,
            country: country || undefined,
            createdAfter: createdAfter ? new Date(createdAfter) : undefined,
            createdBefore: createdBefore ? new Date(createdBefore) : undefined,
            lastActivityAfter: lastActivityAfter ? new Date(lastActivityAfter) : undefined,
            lastActivityBefore: lastActivityBefore
              ? new Date(lastActivityBefore)
              : undefined,
            sort: sort === 'ACTIVITY_DESC' ? undefined : sort,
            q: appliedQ || undefined,
            cursor: reset ? undefined : cursor ?? undefined,
            limit: 30,
          },
        )
        setCursor(page.nextCursor)
        setItems((prev) => (reset || !prev ? page.data : [...prev, ...page.data]))
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setError(t('conversations.forbidden'))
        } else {
          setError(t('auth.generic_error'))
        }
      } finally {
        setLoading(false)
      }
    },
    [
      session,
      status,
      controlMode,
      inboxId,
      teamId,
      labelId,
      country,
      createdAfter,
      createdBefore,
      lastActivityAfter,
      lastActivityBefore,
      sort,
      appliedQ,
      cursor,
      t,
    ],
  )

  React.useEffect(() => {
    setCursor(null)
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status,
    controlMode,
    inboxId,
    teamId,
    labelId,
    country,
    createdAfter,
    createdBefore,
    lastActivityAfter,
    lastActivityBefore,
    sort,
    appliedQ,
    session?.account.id,
  ])

  // If the user changes any filter manually, unselect the active view so the
  // UI doesn't lie about what's displayed.
  const activeView = savedViews.find((v) => v.id === activeViewId)
  React.useEffect(() => {
    if (!activeView) return
    const cur = {
      status: status === 'ALL' ? undefined : status,
      inboxId: inboxId || undefined,
      labelId: labelId || undefined,
      q: appliedQ || undefined,
    }
    const f = activeView.filters as SavedViewFilters
    const same =
      cur.status === f.status &&
      cur.inboxId === f.inboxId &&
      cur.labelId === f.labelId &&
      cur.q === f.q
    if (!same) setActiveViewId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, inboxId, labelId, appliedQ])

  // Live updates: any event that changes what this list shows (a new
  // message preview, a new conversation, a status flip) refetches it.
  // Throttled so a burst — a broadcast, a busy inbox — costs one reload,
  // not one per event.
  const refreshQueued = React.useRef(false)
  useRealtime(session?.session.token ?? null, (event) => {
    if (
      event.type !== 'MessageCreated' &&
      event.type !== 'ConversationCreated' &&
      event.type !== 'ConversationStatusChanged' &&
      event.type !== 'SlaBreached'
    ) {
      return
    }
    if (refreshQueued.current) return
    refreshQueued.current = true
    setTimeout(() => {
      refreshQueued.current = false
      void load(true)
    }, 800)
  })

  // Listen for an external refresh signal (after sending a message, etc.)
  React.useEffect(() => {
    function handler() {
      void load(true)
    }
    window.addEventListener('cosmika:refresh-conversations', handler)
    return () =>
      window.removeEventListener('cosmika:refresh-conversations', handler)
  }, [load])

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function clearSelection() {
    setSelectedIds(new Set())
  }
  function selectAllVisible() {
    if (!items) return
    setSelectedIds(new Set(items.map((c) => c.id)))
  }

  function currentFilters(): SavedViewFilters {
    return {
      ...(status !== 'ALL' ? { status } : {}),
      ...(inboxId ? { inboxId } : {}),
      ...(labelId ? { labelId } : {}),
      ...(appliedQ ? { q: appliedQ } : {}),
    }
  }

  function applyView(v: SavedViewDTO) {
    setActiveViewId(v.id)
    // This pane lists entity=CONVERSATIONS views only, so the payload is the
    // conversations shape; the DTO widened to unknown when contact views
    // gained their own payload.
    const f = v.filters as SavedViewFilters
    setStatus((f.status as StatusFilter) ?? 'ALL')
    setInboxId(f.inboxId ?? '')
    setLabelId(f.labelId ?? '')
    setQ(f.q ?? '')
    setAppliedQ(f.q ?? '')
    // A view defines a clean filter state — clear advanced filters it doesn't carry.
    setTeamId('')
    setCountry('')
    setCreatedAfter('')
    setCreatedBefore('')
    setLastActivityAfter('')
    setLastActivityBefore('')
  }

  // Advanced filters that live behind the "Advanced" disclosure. Used for the
  // count badge and the clear-all affordance.
  const advancedFilterCount =
    (inboxId ? 1 : 0) +
    (teamId ? 1 : 0) +
    (labelId ? 1 : 0) +
    (country ? 1 : 0) +
    (createdAfter ? 1 : 0) +
    (createdBefore ? 1 : 0) +
    (lastActivityAfter ? 1 : 0) +
    (lastActivityBefore ? 1 : 0)

  function clearAdvancedFilters() {
    setInboxId('')
    setTeamId('')
    setLabelId('')
    setCountry('')
    setCreatedAfter('')
    setCreatedBefore('')
    setLastActivityAfter('')
    setLastActivityBefore('')
  }

  async function onSaveCurrentAsView() {
    if (!session) return
    const name = window.prompt(t('conversations.save_view_name_prompt'))
    if (!name?.trim()) return
    try {
      const v = await api.createSavedView(
        session.session.token,
        session.account.id,
        {
          name: name.trim(),
          filters: currentFilters(),
        },
      )
      setSavedViews((prev) => [...prev, v])
      setActiveViewId(v.id)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onDeleteView(viewId: string) {
    if (!session) return
    if (!window.confirm(t('conversations.view_delete_confirm'))) return
    try {
      await api.deleteSavedView(session.session.token, session.account.id, viewId)
      setSavedViews((prev) => prev.filter((v) => v.id !== viewId))
      if (activeViewId === viewId) setActiveViewId(null)
    } catch {
      /* silent */
    }
  }

  async function runBulk(action: BulkConversationActionInput) {
    if (!session || selectedIds.size === 0) return
    setBulkBusy(true)
    try {
      await api.bulkConversations(session.session.token, session.account.id, {
        ids: Array.from(selectedIds),
        action,
      })
      clearSelection()
      await load(true)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBulkBusy(false)
    }
  }

  if (!ready || !session) {
    return (
      <div className="flex h-full w-full shrink-0 border-r border-border md:w-[340px]" />
    )
  }

  return (
    <div className="relative flex h-full w-full shrink-0 flex-col border-r border-border bg-surface md:w-[340px]">
      {/* Indeterminate loading bar — shows during refetch without blanking content */}
      {loading ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
        >
          <div className="h-full w-1/3 origin-left animate-[loading-bar_1.1s_ease-in-out_infinite] bg-primary" />
        </div>
      ) : null}
      {/* Header — switches to bulk-action bar when items are selected */}
      {selectedIds.size > 0 ? (
        <BulkActionBar
          count={selectedIds.size}
          busy={bulkBusy}
          labels={labels}
          onCancel={clearSelection}
          onAction={runBulk}
          t={t}
        />
      ) : (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
          <h2 className="text-sm font-semibold">
            {t('conversations.title')}
          </h2>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('conversations.select_all')}
              onClick={selectAllVisible}
              data-testid="select-all"
            >
              <CheckSquare />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('conversations.new_conversation')}
              onClick={() => router.push('/conversations/new')}
              data-testid="create-conversation"
            >
              <Plus />
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="space-y-2 border-b border-border px-3 py-2">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setAppliedQ(q.trim())
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('conversations.search_placeholder')}
            className="h-8 pl-8 text-xs"
          />
        </form>
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              data-testid={`status-tab-${s}`}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                status === s
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {s === 'ALL'
                ? t('conversations.status_all')
                : s === 'OPEN'
                  ? t('conversations.status_open')
                  : s === 'PENDING'
                    ? t('conversations.status_pending')
                    : t('conversations.status_resolved')}
            </button>
          ))}
        </div>

        {/* Bot/Human control filter — Nebula's "Controle do Bot / Controle
            Humano". Orthogonal to the status tabs above. */}
        <div className="flex flex-wrap gap-1">
          {(['ALL', 'BOT', 'HUMAN'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setControlMode(c)}
              data-testid={`control-tab-${c}`}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors',
                controlMode === c
                  ? 'bg-primary-subtle text-primary'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {c === 'BOT' ? (
                <Bot className="h-3 w-3" />
              ) : c === 'HUMAN' ? (
                <UserCheck className="h-3 w-3" />
              ) : null}
              {c === 'ALL'
                ? t('conversations.control_all')
                : c === 'BOT'
                  ? t('conversations.control_bot')
                  : t('conversations.control_human')}
            </button>
          ))}
        </div>

        {/* Saved views strip — always rendered so the "save current" affordance
            is visible even when the user has no saved views yet. */}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {savedViews.map((v) => (
            <div
              key={v.id}
              className={cn(
                'group inline-flex items-center gap-0.5 rounded-md text-xs transition-colors',
                activeViewId === v.id
                  ? 'bg-primary-subtle text-primary'
                  : 'border border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <button
                type="button"
                onClick={() => applyView(v)}
                className="flex items-center gap-1 px-2 py-0.5"
                data-testid={`view-${v.id}`}
              >
                <Bookmark className="h-3 w-3" />
                <span className="truncate">{v.name}</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void onDeleteView(v.id)
                }}
                className="rounded-md px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
                aria-label={t('conversations.view_delete')}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onSaveCurrentAsView}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            data-testid="save-view"
          >
            <Save className="h-3 w-3" /> {t('conversations.save_view')}
          </button>
        </div>

        {/* Sort + advanced-filters toggle */}
        <div className="flex items-center gap-1.5">
          <Select value={sort} onValueChange={(v) => setSort(v as ConversationSort)}>
            <SelectTrigger
              aria-label={t('conversations.sort_label')}
              data-testid="sort-select"
              className="h-7 flex-1 px-2 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVITY_DESC" className="text-xs">
                {t('conversations.sort_activity_desc')}
              </SelectItem>
              <SelectItem value="ACTIVITY_ASC" className="text-xs">
                {t('conversations.sort_activity_asc')}
              </SelectItem>
              <SelectItem value="CREATED_DESC" className="text-xs">
                {t('conversations.sort_created_desc')}
              </SelectItem>
              <SelectItem value="CREATED_ASC" className="text-xs">
                {t('conversations.sort_created_asc')}
              </SelectItem>
              <SelectItem value="PRIORITY_DESC" className="text-xs">
                {t('conversations.sort_priority_desc')}
              </SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            data-testid="advanced-filters-toggle"
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
              advancedFilterCount > 0
                ? 'border-primary/40 bg-primary-subtle text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            <SlidersHorizontal className="h-3 w-3" />
            {t('conversations.advanced_filters')}
            {advancedFilterCount > 0 ? (
              <span className="rounded-full bg-primary px-1 text-[10px] font-semibold text-background">
                {advancedFilterCount}
              </span>
            ) : null}
          </button>
        </div>

        {advancedOpen ? (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2">
            {inboxes.length > 1 ? (
              <Select
                value={inboxId === '' ? ANY : inboxId}
                onValueChange={(v) => setInboxId(v === ANY ? '' : v)}
              >
                <SelectTrigger
                  aria-label={t('conversations.inbox_filter')}
                  data-testid="inbox-filter"
                  className="h-7 w-full px-2 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY} className="text-xs">
                    {t('conversations.inbox_filter')}
                  </SelectItem>
                {inboxes.map((ib) => (
                  <SelectItem key={ib.id} value={ib.id} className="text-xs">
                    {ib.name}
                  </SelectItem>
                ))}
                </SelectContent>
              </Select>
            ) : null}
            {teams.length > 0 ? (
              <Select
                value={teamId === '' ? ANY : teamId}
                onValueChange={(v) => setTeamId(v === ANY ? '' : v)}
              >
                <SelectTrigger
                  aria-label={t('conversations.team_filter')}
                  data-testid="team-filter"
                  className="h-7 w-full px-2 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY} className="text-xs">
                    {t('conversations.team_filter')}
                  </SelectItem>
                {teams.map((tm) => (
                  <SelectItem key={tm.id} value={tm.id} className="text-xs">
                    {tm.name}
                  </SelectItem>
                ))}
                </SelectContent>
              </Select>
            ) : null}
            {labels.length > 0 ? (
              <Select
                value={labelId === '' ? ANY : labelId}
                onValueChange={(v) => setLabelId(v === ANY ? '' : v)}
              >
                <SelectTrigger
                  aria-label={t('conversations.label_filter')}
                  data-testid="label-filter"
                  className="h-7 w-full px-2 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY} className="text-xs">
                    {t('conversations.label_filter')}
                  </SelectItem>
                {labels.map((l) => (
                  <SelectItem key={l.id} value={l.id} className="text-xs">
                    {l.title}
                  </SelectItem>
                ))}
                </SelectContent>
              </Select>
            ) : null}
            <Input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
              placeholder={t('conversations.country_filter')}
              aria-label={t('conversations.country_filter')}
              data-testid="country-filter"
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs uppercase"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                {t('conversations.created_after')}
                <Input
                  type="date"
                  value={createdAfter}
                  onChange={(e) => setCreatedAfter(e.target.value)}
                  data-testid="created-after"
                  className="h-7 px-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                {t('conversations.created_before')}
                <Input
                  type="date"
                  value={createdBefore}
                  onChange={(e) => setCreatedBefore(e.target.value)}
                  data-testid="created-before"
                  className="h-7 px-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                {t('conversations.activity_after')}
                <Input
                  type="date"
                  value={lastActivityAfter}
                  onChange={(e) => setLastActivityAfter(e.target.value)}
                  data-testid="activity-after"
                  className="h-7 px-1.5 text-xs"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                {t('conversations.activity_before')}
                <Input
                  type="date"
                  value={lastActivityBefore}
                  onChange={(e) => setLastActivityBefore(e.target.value)}
                  data-testid="activity-before"
                  className="h-7 px-1.5 text-xs"
                />
              </label>
            </div>
            {advancedFilterCount > 0 ? (
              <button
                type="button"
                onClick={clearAdvancedFilters}
                data-testid="clear-filters"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" /> {t('conversations.clear_filters')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {error ? (
          <p className="p-4 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {items === null ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i} className="px-3 py-2.5">
                <div className="flex gap-2.5">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">
            {t('conversations.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((c) => {
              const isCurrent = c.id === selectedId
              const isChecked = selectedIds.has(c.id)
              const subtitle = stripWhatsAppFormatting(c.lastMessage?.content ?? '')
              const name = c.contact?.name || c.contact?.email || c.contact?.phoneNumber || '-'
              const inbox = inboxes.find((ib) => ib.id === c.inboxId)
              return (
                <li key={c.id} className="group relative">
                  {/* Checkbox — slides over the avatar on hover or when something is selected */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      toggleSelect(c.id)
                    }}
                    aria-label={isChecked ? t('conversations.deselect') : t('conversations.select')}
                    className={cn(
                      'absolute left-3 top-3 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-opacity',
                      isChecked || selectedIds.size > 0
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100',
                      isChecked && 'border-primary bg-primary text-primary-foreground',
                    )}
                    data-testid={`select-${c.id}`}
                  >
                    {isChecked ? (
                      <CheckSquare className="h-3.5 w-3.5" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <Link
                    href={`/conversations/${c.id}`}
                    data-testid={`conv-${c.id}`}
                    prefetch={false}
                    className={cn(
                      'flex w-full gap-2.5 px-3 py-2.5 transition-colors',
                      isChecked
                        ? 'bg-primary-subtle/40'
                        : isCurrent
                          ? 'bg-primary-subtle/70'
                          : 'hover:bg-subtle/60',
                    )}
                  >
                    <Avatar
                      className={cn(
                        'h-9 w-9 shrink-0 transition-opacity',
                        // Fade avatar when checkbox overlays it (selection mode active)
                        (isChecked || selectedIds.size > 0) && 'opacity-30 group-hover:opacity-30',
                      )}
                    >
                      <AvatarFallback>{initialsOf(name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">
                          <span className="mr-1.5 font-normal text-muted-foreground/70">
                            #{c.displayId}
                          </span>
                          {name}
                        </p>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatListTimestamp(c.lastActivityAt ?? c.updatedAt, fmt, t('conversations.yesterday_abbrev'))}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 flex-1 line-clamp-1 text-xs text-muted-foreground">
                          {subtitle || (
                            <span className="italic">
                              {t('conversations.no_messages_yet')}
                            </span>
                          )}
                        </p>
                        <Badge
                          variant={statusBadgeVariant(c.status)}
                          className="shrink-0 px-1.5 py-0 text-[10px]"
                        >
                          {t(`conversation.${c.status.toLowerCase()}` as const)}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        {c.controlMode === 'BOT' ? (
                          <span
                            title={t('conversations.control_bot')}
                            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary-subtle px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-primary"
                          >
                            <Bot className="h-2.5 w-2.5" />
                            {t('conversations.control_bot_short')}
                          </span>
                        ) : null}
                        {inbox ? (
                          <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">
                            {/* The channel first: one list holds WhatsApp, Instagram,
                                Messenger, Telegram and the website side by side. */}
                            <span data-testid="conversation-channel" className="font-semibold">
                              {t(`inboxes.channel_${inbox.channelType.toLowerCase()}` as never)}
                            </span>
                            <span aria-hidden> · </span>
                            <span>{inbox.name}</span>
                          </p>
                        ) : null}
                        {c.slaStatus && c.slaStatus.state !== 'NOT_APPLICABLE' && c.slaStatus.state !== 'ON_TRACK' ? (
                          <SlaBadge slaStatus={c.slaStatus} t={t} fmt={fmt} />
                        ) : null}
                        {c.labels && c.labels.length > 0 ? (
                          <div className="flex shrink-0 gap-0.5">
                            {c.labels.slice(0, 3).map((l) => (
                              <span
                                key={l.id}
                                title={l.title}
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: l.color }}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        {cursor && items && items.length > 0 ? (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => load(false)}
              disabled={loading}
            >
              {t('conversations.load_more')}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </div>
  )
}

function SlaBadge({
  slaStatus,
  t,
  fmt,
}: {
  slaStatus: NonNullable<ConversationSummaryDTO['slaStatus']>
  t: ReturnType<typeof useTranslations>
  fmt: DateTimeTools
}) {
  const palette =
    slaStatus.state === 'BREACHED'
      ? 'bg-destructive/15 text-destructive'
      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  const label =
    slaStatus.state === 'BREACHED'
      ? t('conversations.sla_breached')
      : `${t('conversations.sla_at_risk')}${
          // Second-level targets (a 60 s queue) read in seconds.
          slaStatus.secondsRemaining != null && slaStatus.secondsRemaining < 120
            ? ` (${slaStatus.secondsRemaining}s)`
            : slaStatus.minutesRemaining !== null
              ? ` (${slaStatus.minutesRemaining}m)`
              : ''
        }`
  return (
    <span
      title={
        slaStatus.targetAt
          ? `${t('conversations.sla_target')}: ${fmt.dateTime(slaStatus.targetAt)}`
          : undefined
      }
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${palette}`}
    >
      {label}
    </span>
  )
}

function formatListTimestamp(
  iso: string,
  fmt: DateTimeTools,
  yesterdayLabel: string,
): string {
  // Days are the account's days, so a late-evening conversation doesn't jump
  // to tomorrow for an operator in another zone.
  const now = new Date()
  const key = fmt.dayKey(iso)
  if (key === fmt.dayKey(now)) return fmt.time(iso)
  if (key === fmt.dayKey(new Date(now.getTime() - 86_400_000))) return yesterdayLabel
  const sameYear = fmt.date(iso, { year: 'numeric' }) === fmt.date(now, { year: 'numeric' })
  return fmt.date(iso, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : '2-digit',
  })
}

function BulkActionBar({
  count,
  busy,
  labels,
  onCancel,
  onAction,
  t,
}: {
  count: number
  busy: boolean
  labels: LabelDTO[]
  onCancel: () => void
  onAction: (a: BulkConversationActionInput) => void | Promise<void>
  t: ReturnType<typeof useTranslations>
}) {
  const statuses: ConversationStatus[] = ['OPEN', 'PENDING', 'RESOLVED']
  const priorities: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT']
  return (
    <div
      className="flex items-center gap-1.5 border-b border-border bg-primary-subtle/40 px-3 py-2.5"
      data-testid="bulk-action-bar"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onCancel}
        aria-label={t('conversations.bulk_clear_selection')}
        data-testid="bulk-cancel"
      >
        <X />
      </Button>
      <span className="text-sm font-medium">
        {t('conversations.bulk_selected', { count })}
      </span>

      <div className="ml-auto flex items-center gap-1">
        {/* Status */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
              data-testid="bulk-status"
            >
              {t('conversations.bulk_status')} <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('conversations.bulk_set_status')}</DropdownMenuLabel>
            {statuses.map((s) => (
              <DropdownMenuItem
                key={s}
                onClick={() => onAction({ type: 'STATUS', status: s })}
                data-testid={`bulk-status-${s}`}
              >
                {t(`conversation.${s.toLowerCase() as 'open' | 'pending' | 'resolved'}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Priority */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
              data-testid="bulk-priority"
            >
              {t('conversations.bulk_priority')} <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('conversations.bulk_set_priority')}</DropdownMenuLabel>
            {priorities.map((p) => (
              <DropdownMenuItem
                key={p}
                onClick={() => onAction({ type: 'PRIORITY', priority: p })}
              >
                {t(`conversations.priority_${p.toLowerCase() as 'low' | 'normal' | 'high' | 'urgent'}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Assign */}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => onAction({ type: 'ASSIGN', assigneeId: null })}
          aria-label={t('conversations.bulk_unassign')}
          title={t('conversations.bulk_unassign')}
        >
          <UserCheck className="h-3 w-3" /> {t('conversations.bulk_unassign')}
        </Button>

        {/* Labels */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              disabled={busy || labels.length === 0}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-muted disabled:opacity-50"
              data-testid="bulk-label"
            >
              <Tag className="h-3 w-3" /> {t('conversations.bulk_label')} <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('conversations.bulk_apply_label')}</DropdownMenuLabel>
            {labels.map((l) => (
              <DropdownMenuItem
                key={l.id}
                onClick={() =>
                  onAction({ type: 'APPLY_LABEL', labelId: l.id })
                }
                data-testid={`bulk-apply-label-${l.id}`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.title}
              </DropdownMenuItem>
            ))}
            {labels.length === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuLabel>{t('conversations.bulk_remove_label')}</DropdownMenuLabel>
            {labels.map((l) => (
              <DropdownMenuItem
                key={`rm-${l.id}`}
                onClick={() =>
                  onAction({ type: 'REMOVE_LABEL', labelId: l.id })
                }
              >
                <span
                  className="h-2 w-2 rounded-full opacity-50"
                  style={{ backgroundColor: l.color }}
                />
                {l.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
