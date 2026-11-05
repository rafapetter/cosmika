'use client'

import * as React from 'react'
import type { Route } from 'next'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
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
  DropdownMenuTrigger,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  cn,
} from '@cosmika/ui'
import {
  Ban,
  Bot,
  Check,
  Download,
  FileText,
  History,
  Mail,
  Merge,
  Pencil,
  Phone,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react'
import type {
  AccountMemberDTO,
  AgentToolCallDTO,
  AiAgentSessionDTO,
  ContactDTO,
  ContactNoteDTO,
  ConversationDetailDTO,
  ConversationStatus,
  ConversationSummaryDTO,
  InboxDTO,
  LabelDTO,
  Priority,
  TeamDTO,
} from '@cosmika/shared'

import { api } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useDateTime, type DateTimeTools } from '../../../lib/format-datetime'
import { useStoredSession } from '../../../lib/session-store'

import { AiPanel } from './_ai-panel'

const STATUS_OPTIONS: ConversationStatus[] = ['OPEN', 'PENDING', 'RESOLVED']
const PRIORITY_OPTIONS: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT']

// Radix Select reserves the empty string, so "nobody yet" travels as a sentinel.
const NOBODY = '__none__'

export function ConversationSidebar({
  conversation,
  newConversationHref,
  onStatusChange,
  onPriorityChange,
  onAssignToMe,
  onAssign,
  onAssignTeam,
  onTransfer,
  onControlModeChange,
  meAssigned,
  aiSession,
  aiToolCalls,
  onConfirmTools,
  onRejectTools,
  confirmingTools,
  previousConversations,
  accountLabels,
  onToggleLabel,
}: {
  conversation: ConversationDetailDTO
  /** Where a new conversation with this contact starts; set once this one is closed. */
  newConversationHref: Route | null
  onStatusChange: (s: ConversationStatus) => Promise<void> | void
  onPriorityChange: (p: Priority) => Promise<void> | void
  onAssignToMe: () => Promise<void> | void
  /** Hand the conversation to another agent with a private note for them. */
  onTransfer: (
    to: { id: string; email: string; fullName: string | null },
    note: string,
  ) => Promise<void> | void
  onAssign: (
    assignee: { id: string; email: string; fullName: string | null } | null,
  ) => Promise<void> | void
  onAssignTeam: (teamId: string | null) => Promise<void> | void
  onControlModeChange: (mode: 'BOT' | 'HUMAN') => Promise<void> | void
  meAssigned: boolean
  aiSession: AiAgentSessionDTO | null
  aiToolCalls: AgentToolCallDTO[]
  onConfirmTools: (ids: string[]) => Promise<void> | void
  onRejectTools: (ids: string[]) => Promise<void> | void
  confirmingTools: boolean
  previousConversations: ConversationSummaryDTO[]
  accountLabels: LabelDTO[]
  onToggleLabel: (labelId: string, currentlyApplied: boolean) => Promise<void> | void
}) {
  const t = useTranslations()
  const fmt = useDateTime()
  const contact = conversation.contact
  const hasPendingTools = aiToolCalls.some((c) => c.status === 'PENDING')
  return (
    <aside className="hidden w-[340px] shrink-0 border-l border-border bg-surface lg:flex lg:flex-col">
      <ScrollArea className="flex-1">
        <div className="space-y-5 p-5">
          {/* An action waiting on a human goes first. Buried at the bottom of
              the sidebar, under a contact's whole attribute list, these sat
              unanswered for weeks. */}
          {hasPendingTools ? (
            <>
              <AiPanel
                session={aiSession}
                toolCalls={aiToolCalls}
                onConfirm={onConfirmTools}
                onReject={onRejectTools}
                confirming={confirmingTools}
              />
              <Separator />
            </>
          ) : null}

          {/* Contact — header (no avatar), action row, attributes editor */}
          <ContactPanel
            contact={contact}
            conversationId={conversation.id}
            displayId={conversation.displayId}
          />

          <Separator />

          {/* Forward */}
          <ForwardSection
            currentInboxId={conversation.inbox?.id ?? conversation.inboxId}
            conversationId={conversation.id}
          />

          {/* Bot / Human control */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('conversations.control_label')}
            </h3>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
                  conversation.controlMode === 'BOT'
                    ? 'bg-primary-subtle text-primary'
                    : 'bg-subtle text-foreground',
                )}
              >
                {conversation.controlMode === 'BOT' ? (
                  <Bot className="h-3.5 w-3.5" />
                ) : (
                  <UserIcon className="h-3.5 w-3.5" />
                )}
                {conversation.controlMode === 'BOT'
                  ? t('conversations.control_bot')
                  : t('conversations.control_human')}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  onControlModeChange(
                    conversation.controlMode === 'BOT' ? 'HUMAN' : 'BOT',
                  )
                }
                data-testid="toggle-control-mode"
              >
                {conversation.controlMode === 'BOT'
                  ? t('conversations.take_over')
                  : t('conversations.hand_to_bot')}
              </Button>
            </div>
          </section>

          {/* Status */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('conversations.sidebar_status')}
            </h3>
            <div className="flex flex-wrap gap-1">
              {STATUS_OPTIONS.map((s) => {
                // Closed is final: the other two statuses are shown, so the
                // choice is not a mystery, but they cannot be picked.
                const locked = conversation.status === 'RESOLVED' && s !== 'RESOLVED'
                return (
                  <button
                    key={s}
                    onClick={() => onStatusChange(s)}
                    disabled={locked}
                    title={locked ? t('conversations.closed_no_reopen') : undefined}
                    className={cn(
                      'rounded-md px-2 py-1 text-xs transition-colors',
                      conversation.status === s
                        ? 'bg-foreground text-background'
                        : 'border border-border text-muted-foreground hover:bg-muted',
                      locked && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                    )}
                    data-testid={`status-${s}`}
                  >
                    {t(`conversation.${s.toLowerCase() as 'open' | 'pending' | 'resolved'}`)}
                  </button>
                )
              })}
            </div>
            {conversation.status === 'RESOLVED' && newConversationHref ? (
              <p className="text-xs text-muted-foreground" data-testid="status-closed-hint">
                {t('conversations.closed_no_reopen')}{' '}
                <Link
                  href={newConversationHref}
                  className="font-medium text-primary hover:underline"
                  data-testid="status-new-conversation"
                >
                  {t('conversations.closed_start_new')}
                </Link>
              </p>
            ) : null}
          </section>

          {/* Priority */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('conversations.sidebar_priority')}
            </h3>
            <div className="flex flex-wrap gap-1">
              {PRIORITY_OPTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => onPriorityChange(p)}
                  className={cn(
                    'rounded-md px-2 py-1 text-xs transition-colors',
                    conversation.priority === p
                      ? 'bg-foreground text-background'
                      : 'border border-border text-muted-foreground hover:bg-muted',
                  )}
                  data-testid={`priority-${p}`}
                >
                  {t(`conversations.priority_${p.toLowerCase() as 'low' | 'normal' | 'high' | 'urgent'}`)}
                </button>
              ))}
            </div>
          </section>

          {/* Assignment — team + user pickers */}
          <AssignmentSection
            assigneeId={conversation.assigneeId}
            assignee={conversation.assignee}
            teamId={conversation.teamId}
            meAssigned={meAssigned}
            onAssign={onAssign}
            onAssignTeam={onAssignTeam}
            onAssignToMe={onAssignToMe}
            onTransfer={onTransfer}
          />

          {/* Labels */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('conversations.sidebar_labels')}
              </h3>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t('conversations.sidebar_labels')}
                    data-testid="apply-label-trigger"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>{t('conversations.sidebar_labels')}</DropdownMenuLabel>
                  {accountLabels.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      -
                    </p>
                  ) : (
                    accountLabels.map((l) => {
                      const applied = conversation.labels.some((x) => x.id === l.id)
                      return (
                        <DropdownMenuItem
                          key={l.id}
                          onClick={() => onToggleLabel(l.id, applied)}
                          data-testid={`label-${l.id}`}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: l.color }}
                          />
                          <span className="flex-1 truncate">{l.title}</span>
                          {applied ? (
                            <Check className="h-3 w-3 text-primary" />
                          ) : null}
                        </DropdownMenuItem>
                      )
                    })
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {conversation.labels.length === 0 && conversation.aiTags.length === 0 ? (
              <p className="text-xs text-muted-foreground">-</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {conversation.labels.map((l) => (
                  <Badge
                    key={l.id}
                    style={{
                      backgroundColor: `${l.color}22`,
                      color: l.color,
                      borderColor: `${l.color}55`,
                    }}
                    className="border"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: l.color }}
                    />
                    {l.title}
                  </Badge>
                ))}
                {conversation.aiTags.map((tag) => (
                  <Badge key={`ai-${tag}`} variant="primary">
                    <Sparkles className="h-3 w-3" /> {tag}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          {/* AI summary */}
          {conversation.aiSummary ? (
            <section className="space-y-1.5">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Sparkles className="h-3 w-3" /> {t('conversations.sidebar_ai_summary')}
                {conversation.aiSentiment ? (
                  <Badge
                    variant={sentimentVariant(conversation.aiSentiment)}
                    className="ml-auto text-[10px]"
                  >
                    {t(`reports.sentiment_${conversation.aiSentiment.toLowerCase()}` as never)}
                  </Badge>
                ) : null}
              </h3>
              <p className="text-xs leading-relaxed text-foreground">
                {conversation.aiSummary}
              </p>
            </section>
          ) : null}

          {/* Conversation-level custom attributes */}
          <ConversationAttributes conversation={conversation} />

          {/* AI panel (session + tool calls). Already rendered at the top
              when something is pending, so don't repeat it here. */}
          {hasPendingTools ? null : (
            <AiPanel
              session={aiSession}
              toolCalls={aiToolCalls}
              onConfirm={onConfirmTools}
              onReject={onRejectTools}
              confirming={confirmingTools}
            />
          )}

          {/* Previous conversations with same contact */}
          {previousConversations.length > 0 ? (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <History className="h-3 w-3" /> {t('conversations.sidebar_previous_conversations')}
              </h3>
              <ul className="space-y-1 text-xs">
                {previousConversations.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/conversations/${c.id}`}
                      prefetch={false}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 hover:bg-muted/60"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="mr-1 text-muted-foreground/70">
                          #{c.displayId}
                        </span>
                        {c.lastMessage?.content?.slice(0, 50) ||
                          t(`conversation.${c.status.toLowerCase() as 'open' | 'pending' | 'resolved'}`)}
                      </span>
                      <Badge
                        variant={statusBadgeVariant(c.status)}
                        className="shrink-0 text-[10px]"
                      >
                        {t(`conversation.${c.status.toLowerCase() as 'open' | 'pending' | 'resolved'}`)}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Lifecycle */}
          <section className="space-y-1.5 text-xs">
            <h3 className="font-medium uppercase tracking-wide text-muted-foreground">
              {t('conversations.sidebar_lifecycle')}
            </h3>
            <Row label={t('conversations.sidebar_created')} value={formatDateTime(conversation.createdAt, fmt)} />
            {conversation.firstReplyAt ? (
              <Row
                label={t('conversations.first_reply')}
                value={formatDateTime(conversation.firstReplyAt, fmt)}
              />
            ) : null}
            {conversation.resolvedAt ? (
              <Row
                label={t('conversations.resolved_at')}
                value={formatDateTime(conversation.resolvedAt, fmt)}
              />
            ) : null}
            {conversation.reopenedAt ? (
              <Row
                label={t('conversations.reopened_at')}
                value={formatDateTime(conversation.reopenedAt, fmt)}
              />
            ) : null}
          </section>
        </div>
      </ScrollArea>
    </aside>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

function formatDateTime(iso: string, fmt: DateTimeTools) {
  const sameYear = fmt.date(iso, { year: 'numeric' }) === fmt.date(new Date(), { year: 'numeric' })
  return fmt.date(iso, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sentimentVariant(s: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE') {
  if (s === 'POSITIVE') return 'success' as const
  if (s === 'NEGATIVE') return 'destructive' as const
  return 'default' as const
}

function statusBadgeVariant(s: ConversationStatus) {
  if (s === 'OPEN') return 'open' as const
  if (s === 'PENDING') return 'pending' as const
  return 'resolved' as const
}

function downloadText(filename: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

type SidebarContact = ConversationDetailDTO['contact']

function AssignmentSection({
  assigneeId,
  assignee,
  teamId,
  meAssigned,
  onAssign,
  onAssignTeam,
  onAssignToMe,
  onTransfer,
}: {
  assigneeId: string | null
  assignee: { id: string; email: string; fullName: string | null } | null
  teamId: string | null
  meAssigned: boolean
  onAssign: (
    a: { id: string; email: string; fullName: string | null } | null,
  ) => Promise<void> | void
  onAssignTeam: (teamId: string | null) => Promise<void> | void
  onAssignToMe: () => Promise<void> | void
  onTransfer: (
    to: { id: string; email: string; fullName: string | null },
    note: string,
  ) => Promise<void> | void
}) {
  const t = useTranslations()
  const [transferOpen, setTransferOpen] = React.useState(false)
  const [transferTo, setTransferTo] = React.useState('')
  const [transferNote, setTransferNote] = React.useState('')
  const [transferring, setTransferring] = React.useState(false)

  async function confirmTransfer() {
    const m = members.find((x) => x.user.id === transferTo)
    if (!m) return
    setTransferring(true)
    try {
      await onTransfer(
        { id: m.user.id, email: m.user.email, fullName: m.user.fullName },
        transferNote.trim(),
      )
      setTransferOpen(false)
      setTransferTo('')
      setTransferNote('')
    } finally {
      setTransferring(false)
    }
  }
  const { session } = useStoredSession()
  const [members, setMembers] = React.useState<AccountMemberDTO[]>([])
  const [teams, setTeams] = React.useState<TeamDTO[]>([])

  React.useEffect(() => {
    if (!session) return
    api
      .listAccountMembers(session.session.token, session.account.id)
      .then((m) => setMembers(m.filter((x) => x.isActive)))
      .catch(() => setMembers([]))
    api
      .listTeams(session.session.token, session.account.id)
      .then(setTeams)
      .catch(() => setTeams([]))
  }, [session])

  function pickUser(userId: string) {
    if (!userId) {
      void onAssign(null)
      return
    }
    const m = members.find((x) => x.user.id === userId)
    if (m) {
      void onAssign({ id: m.user.id, email: m.user.email, fullName: m.user.fullName })
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('conversations.sidebar_assignee')}
      </h3>

      {/* Agent (user) picker */}
      <Select
        value={assigneeId ?? NOBODY}
        onValueChange={(v) => pickUser(v === NOBODY ? '' : v)}
      >
        <SelectTrigger
          aria-label={t('conversations.sidebar_assignee')}
          data-testid="assignee-select"
          className="h-8 w-full px-2 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOBODY} className="text-xs">
            {t('conversations.no_assignee')}
          </SelectItem>
          {/* Keep the current assignee selectable even if not in the fetched list */}
          {assignee && !members.some((m) => m.user.id === assignee.id) ? (
            <SelectItem value={assignee.id} className="text-xs">
              {assignee.fullName ?? assignee.email}
            </SelectItem>
          ) : null}
          {members.map((m) => (
            <SelectItem key={m.user.id} value={m.user.id} className="text-xs">
              {m.user.fullName ?? m.user.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        data-testid="transfer-open"
        onClick={() => setTransferOpen(true)}
      >
        {t('conversations.transfer_with_note')}
      </Button>
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('conversations.transfer_with_note')}</DialogTitle>
            <DialogDescription>{t('conversations.transfer_help')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={transferTo} onValueChange={setTransferTo}>
              <SelectTrigger
                aria-label={t('conversations.transfer_to')}
                data-testid="transfer-to"
                className="h-9 w-full text-sm"
              >
                <SelectValue placeholder={t('conversations.transfer_to')} />
              </SelectTrigger>
              <SelectContent>
                {members
                  .filter((m) => m.user.id !== assigneeId)
                  .map((m) => (
                    <SelectItem key={m.user.id} value={m.user.id}>
                      {m.user.fullName ?? m.user.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <textarea
              aria-label={t('conversations.transfer_note')}
              data-testid="transfer-note"
              placeholder={t('conversations.transfer_note_placeholder')}
              maxLength={2000}
              rows={4}
              className="w-full rounded-md border border-input bg-background p-2 text-sm"
              value={transferNote}
              onChange={(e) => setTransferNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!transferTo || transferring}
              data-testid="transfer-confirm"
              onClick={() => void confirmTransfer()}
            >
              {t('conversations.transfer_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Team picker */}
      {teams.length > 0 ? (
        <Select
          value={teamId ?? NOBODY}
          onValueChange={(v) => onAssignTeam(v === NOBODY ? null : v)}
        >
          <SelectTrigger
            aria-label={t('conversations.sidebar_team')}
            data-testid="team-select"
            className="h-8 w-full px-2 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NOBODY} className="text-xs">
              {t('conversations.no_team')}
            </SelectItem>
            {teams.map((tm) => (
              <SelectItem key={tm.id} value={tm.id} className="text-xs">
                {tm.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {!meAssigned ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={onAssignToMe}
          data-testid="assign-to-me"
        >
          <UserIcon /> {t('conversations.assign_to_me')}
        </Button>
      ) : null}
    </section>
  )
}

function ContactPanel({
  contact,
  conversationId,
  displayId,
}: {
  contact: SidebarContact
  conversationId: string
  displayId: number
}) {
  const t = useTranslations()
  const router = useRouter()
  const { session } = useStoredSession()
  const [c, setC] = React.useState<SidebarContact>(contact)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState({ name: '', email: '', phoneNumber: '' })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // Merge mode
  const [merging, setMerging] = React.useState(false)
  const [mergeQuery, setMergeQuery] = React.useState('')
  const [mergeResults, setMergeResults] = React.useState<ContactDTO[] | null>(null)
  const [mergeSelected, setMergeSelected] = React.useState<string[]>([])

  React.useEffect(() => setC(contact), [contact])

  const name = c.name || c.email || c.phoneNumber || '-'
  const blocked = Boolean(c.blockedAt)

  function startEdit() {
    setDraft({
      name: c.name ?? '',
      email: c.email ?? '',
      phoneNumber: c.phoneNumber ?? '',
    })
    setEditing(true)
  }

  async function saveEdit() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api.updateContact(
        session.session.token,
        session.account.id,
        c.id,
        {
          name: draft.name.trim() || null,
          email: draft.email.trim() || null,
          phoneNumber: draft.phoneNumber.trim() || null,
        },
      )
      setC((prev) => ({ ...prev, ...updated }))
      setEditing(false)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function runMergeSearch() {
    if (!session) return
    try {
      const page = await api.listContacts(session.session.token, session.account.id, {
        q: mergeQuery.trim() || undefined,
        limit: 25,
      })
      // Never offer the current contact as a merge source.
      setMergeResults(page.data.filter((x) => x.id !== c.id))
    } catch {
      setMergeResults([])
    }
  }

  function toggleMergeSelect(id: string) {
    setMergeSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= 5 // merge endpoint caps the source list at 5
          ? prev
          : [...prev, id],
    )
  }

  async function doMerge() {
    if (!session || mergeSelected.length === 0) {
      setError(t('contacts.merge_empty_selection'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const merged = await api.mergeContacts(
        session.session.token,
        session.account.id,
        c.id,
        { sourceContactIds: mergeSelected },
      )
      // The survivor may have absorbed name/email/attributes from the sources.
      setC((prev) => ({ ...prev, ...merged }))
      setMerging(false)
      setMergeQuery('')
      setMergeResults(null)
      setMergeSelected([])
      // Sources' conversations now point at the survivor — refresh the list.
      window.dispatchEvent(new Event('cosmika:refresh-conversations'))
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleBlock() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api.setContactBlocked(
        session.session.token,
        session.account.id,
        c.id,
        !blocked,
      )
      setC((prev) => ({ ...prev, blockedAt: updated.blockedAt }))
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function downloadTranscript() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const tr = await api.getConversationTranscript(
        session.session.token,
        session.account.id,
        conversationId,
      )
      downloadText(tr.filename, tr.text)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function exportContact() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      const bundle = await api.exportContact(
        session.session.token,
        session.account.id,
        c.id,
      )
      downloadText(
        `contact-${c.id}.json`,
        JSON.stringify(bundle, null, 2),
        'application/json',
      )
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteConversation() {
    if (!session) return
    if (!window.confirm(t('conversations.confirm_delete_conversation', { id: displayId })))
      return
    setBusy(true)
    try {
      await api.deleteConversation(
        session.session.token,
        session.account.id,
        conversationId,
      )
      router.push('/conversations')
    } catch (err) {
      setError(apiErrorText(t, err))
      setBusy(false)
    }
  }

  async function deleteContact() {
    if (!session) return
    if (!window.confirm(t('conversations.confirm_delete_contact', { name }))) return
    setBusy(true)
    try {
      await api.deleteContact(session.session.token, session.account.id, c.id)
      router.push('/conversations')
    } catch (err) {
      setError(apiErrorText(t, err))
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3" data-testid="contact-panel">
      {/* Header — no avatar, left-aligned identity */}
      {editing ? (
        <div className="space-y-1.5">
          <Input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t('conversations.contact_name')}
            className="h-8 px-2 font-semibold"
            data-testid="edit-contact-name"
          />
          <Input
            value={draft.email}
            onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            placeholder={t('conversations.contact_email')}
            className="h-7 px-2 text-xs"
          />
          <Input
            value={draft.phoneNumber}
            onChange={(e) => setDraft((d) => ({ ...d, phoneNumber: e.target.value }))}
            placeholder={t('conversations.contact_phone')}
            className="h-7 px-2 text-xs"
          />
          <div className="flex gap-1.5">
            <Button size="sm" onClick={saveEdit} disabled={busy} data-testid="save-contact">
              <Check className="h-3.5 w-3.5" /> {t('common.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
              <X className="h-3.5 w-3.5" /> {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold">{name}</p>
            {blocked ? (
              <span className="inline-flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0 text-[10px] font-medium uppercase text-destructive">
                <Ban className="h-2.5 w-2.5" /> {t('conversations.blocked_badge')}
              </span>
            ) : null}
          </div>
          {c.email ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Mail className="h-3 w-3" /> {c.email}
            </p>
          ) : null}
          {c.phoneNumber ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Phone className="h-3 w-3" /> {c.phoneNumber}
            </p>
          ) : null}
          {c.identifier ? (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <UserIcon className="h-3 w-3" /> {c.identifier}
            </p>
          ) : null}
        </div>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {/* Action row */}
      <div className="flex flex-wrap gap-1">
        <ActionButton
          icon={<Pencil className="h-3.5 w-3.5" />}
          label={t('conversations.edit_contact')}
          onClick={startEdit}
          testid="action-edit-contact"
        />
        <ActionButton
          icon={<Ban className="h-3.5 w-3.5" />}
          label={blocked ? t('conversations.unblock_contact') : t('conversations.block_contact')}
          onClick={toggleBlock}
          disabled={busy}
          danger={!blocked}
          testid="action-block-contact"
        />
        <ActionButton
          icon={<FileText className="h-3.5 w-3.5" />}
          label={t('conversations.download_transcript')}
          onClick={downloadTranscript}
          disabled={busy}
          testid="action-transcript"
        />
        <ActionButton
          icon={<Download className="h-3.5 w-3.5" />}
          label={t('conversations.export_contact')}
          onClick={exportContact}
          disabled={busy}
          testid="action-export"
        />
        <ActionButton
          icon={<Merge className="h-3.5 w-3.5" />}
          label={t('conversations.merge_contact')}
          onClick={() => setMerging((m) => !m)}
          disabled={busy}
          testid="action-merge-contact"
        />
        <ActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label={t('conversations.delete_conversation')}
          onClick={deleteConversation}
          disabled={busy}
          danger
          testid="action-delete-conversation"
        />
        <ActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label={t('conversations.delete_contact')}
          onClick={deleteContact}
          disabled={busy}
          danger
          testid="action-delete-contact"
        />
      </div>

      {/* Merge — search other contacts and absorb them into this one */}
      {merging ? (
        <div
          className="space-y-2 rounded-md border border-border p-2"
          data-testid="merge-panel"
        >
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t('contacts.merge_title')}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void runMergeSearch()
            }}
            className="flex gap-1"
          >
            <Input
              value={mergeQuery}
              onChange={(e) => setMergeQuery(e.target.value)}
              placeholder={t('contacts.merge_picker_placeholder')}
              data-testid="merge-search-input"
              className="h-7 flex-1 px-2 text-xs"
            />
            <Button size="sm" type="submit" variant="outline" data-testid="merge-search">
              <Search className="h-3.5 w-3.5" />
            </Button>
          </form>
          {mergeResults ? (
            mergeResults.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/60">-</p>
            ) : (
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {mergeResults.map((r) => {
                  const checked = mergeSelected.includes(r.id)
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleMergeSelect(r.id)}
                      data-testid={`merge-result-${r.id}`}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                        checked ? 'bg-primary-subtle text-primary' : 'hover:bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                          checked ? 'border-primary bg-primary text-background' : 'border-border',
                        )}
                      >
                        {checked ? <Check className="h-2.5 w-2.5" /> : null}
                      </span>
                      <span className="truncate">
                        {r.name || r.email || r.phoneNumber || r.id}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          ) : null}
          <Button
            size="sm"
            className="w-full"
            onClick={doMerge}
            disabled={busy || mergeSelected.length === 0}
            data-testid="merge-submit"
          >
            <Merge className="h-3.5 w-3.5" /> {t('contacts.merge_submit')}
            {mergeSelected.length > 0 ? ` (${mergeSelected.length})` : ''}
          </Button>
        </div>
      ) : null}

      <NotesSection contactId={c.id} />

      <AttributesEditor
        attributes={(c.customAttributes ?? {}) as Record<string, unknown>}
        onSave={async (attrs) => {
          if (!session) return attrs
          const updated = await api.updateContact(
            session.session.token,
            session.account.id,
            c.id,
            { customAttributes: attrs },
          )
          const saved = (updated.customAttributes ?? {}) as Record<string, unknown>
          setC((prev) => ({ ...prev, customAttributes: saved }))
          return saved
        }}
      />
    </section>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  testid,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  testid: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      data-testid={testid}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors disabled:opacity-50',
        danger
          ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  )
}

function AttributesEditor({
  attributes,
  onSave,
  title,
}: {
  attributes: Record<string, unknown>
  // Persist the new attribute map; returns the saved map.
  onSave: (attrs: Record<string, unknown>) => Promise<Record<string, unknown>>
  title?: string
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [rows, setRows] = React.useState<Array<{ key: string; value: string }>>(
    () => Object.entries(attributes).map(([k, v]) => ({ key: k, value: String(v) })),
  )
  const [dirty, setDirty] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setRows(Object.entries(attributes).map(([k, v]) => ({ key: k, value: String(v) })))
    setDirty(false)
  }, [attributes])

  function setRow(i: number, patch: Partial<{ key: string; value: string }>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  function addRow() {
    setRows((rs) => [...rs, { key: '', value: '' }])
    setDirty(true)
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  async function save() {
    if (!session) return
    setBusy(true)
    setError(null)
    const obj: Record<string, unknown> = {}
    for (const r of rows) {
      const k = r.key.trim()
      if (k) obj[k] = r.value
    }
    try {
      await onSave(obj)
      setDirty(false)
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/60 p-2" data-testid="attributes-editor">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {title ?? t('conversations.sidebar_attributes')}
        </p>
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="add-attribute"
        >
          <Plus className="h-3 w-3" /> {t('conversations.add_attribute')}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground/60">
          {t('conversations.no_attributes')}
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={r.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                placeholder={t('conversations.attr_key')}
                className="h-6 w-2/5 px-1 text-[11px]"
              />
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder={t('conversations.attr_value')}
                className="h-6 flex-1 px-1 text-[11px]"
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label={t('common.cancel')}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
      {dirty ? (
        <Button
          size="sm"
          className="mt-2 h-6 w-full text-[11px]"
          onClick={save}
          disabled={busy}
          data-testid="save-attributes"
        >
          <Check className="h-3 w-3" /> {t('common.save')}
        </Button>
      ) : null}
    </div>
  )
}

function ConversationAttributes({
  conversation,
}: {
  conversation: ConversationDetailDTO
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [attrs, setAttrs] = React.useState<Record<string, unknown>>(
    (conversation.customAttributes ?? {}) as Record<string, unknown>,
  )
  React.useEffect(() => {
    setAttrs((conversation.customAttributes ?? {}) as Record<string, unknown>)
  }, [conversation.id, conversation.customAttributes])

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('conversations.conversation_attributes')}
      </h3>
      <AttributesEditor
        attributes={attrs}
        title={t('conversations.conversation_attributes')}
        onSave={async (next) => {
          if (!session) return next
          const updated = await api.updateConversation(
            session.session.token,
            session.account.id,
            conversation.id,
            { customAttributes: next },
          )
          const saved = (updated.customAttributes ?? {}) as Record<string, unknown>
          setAttrs(saved)
          return saved
        }}
      />
    </section>
  )
}

function NotesSection({ contactId }: { contactId: string }) {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [notes, setNotes] = React.useState<ContactNoteDTO[]>([])
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    if (!session) return
    try {
      setNotes(
        await api.listContactNotes(session.session.token, session.account.id, contactId),
      )
    } catch {
      setNotes([])
    }
  }, [session, contactId])

  React.useEffect(() => {
    void load()
  }, [load])

  async function add() {
    if (!session || !draft.trim()) return
    setBusy(true)
    try {
      await api.addContactNote(
        session.session.token,
        session.account.id,
        contactId,
        draft.trim(),
      )
      setDraft('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!session) return
    await api.deleteContactNote(session.session.token, session.account.id, contactId, id)
    await load()
  }

  return (
    <div className="rounded-md border border-border/60 bg-background/60 p-2" data-testid="notes-section">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {t('conversations.notes_title')}
      </p>
      <div className="mt-1.5 flex gap-1">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('conversations.notes_placeholder')}
          rows={2}
          data-testid="note-input"
          className="flex-1 resize-none rounded border border-border bg-background px-1.5 py-1 text-[11px]"
        />
        <Button
          size="sm"
          className="h-auto"
          onClick={add}
          disabled={busy || !draft.trim()}
          data-testid="note-add"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
      {notes.length > 0 ? (
        <ul className="mt-1.5 space-y-1.5">
          {notes.map((n) => (
            <li key={n.id} className="group rounded bg-muted/40 px-1.5 py-1" data-testid={`note-${n.id}`}>
              <p className="whitespace-pre-wrap text-[11px]">{n.body}</p>
              <div className="mt-0.5 flex items-center justify-between text-[9px] text-muted-foreground">
                <span>
                  {n.authorName ?? '-'} ·{' '}
                  {fmt.date(n.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(n.id)}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  aria-label={t('common.cancel')}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ForwardSection({
  currentInboxId,
  conversationId,
}: {
  currentInboxId: string
  conversationId: string
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [open, setOpen] = React.useState(false)
  const [inboxes, setInboxes] = React.useState<InboxDTO[] | null>(null)
  const [targetInboxId, setTargetInboxId] = React.useState('')
  const [note, setNote] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [forwarded, setForwarded] = React.useState<number | null>(null)

  async function onOpen() {
    setOpen(true)
    if (!session || inboxes) return
    try {
      const list = await api.listInboxes(session.session.token, session.account.id)
      setInboxes(list)
      const first = list.find((i) => i.id !== currentInboxId)
      if (first) setTargetInboxId(first.id)
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }

  async function onForward() {
    if (!session || !targetInboxId) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await api.forwardConversation(
        session.session.token,
        session.account.id,
        conversationId,
        { targetInboxId, note: note.trim() || undefined },
      )
      setForwarded(r.displayId)
      setNote('')
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <section>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onOpen}
          data-testid="open-forward"
        >
          <Send className="h-3.5 w-3.5" /> {t('conversations.sidebar_forward')}
        </Button>
      </section>
    )
  }

  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('conversations.forward_title')}
      </h3>
      {forwarded ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          {t('conversations.forward_success', { id: forwarded })}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('conversations.forward_target_inbox')}
        </span>
        <Select value={targetInboxId} onValueChange={setTargetInboxId}>
          <SelectTrigger
            className="h-8 px-2 text-xs"
            aria-label={t('conversations.forward_target_inbox')}
          >
            <SelectValue placeholder={inboxes === null ? t('common.loading') : undefined} />
          </SelectTrigger>
          <SelectContent>
            {(inboxes ?? [])
              .filter((i) => i.id !== currentInboxId)
              .map((i) => (
                <SelectItem key={i.id} value={i.id} className="text-xs">
                  {i.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('conversations.forward_note_optional')}
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={t('conversations.forward_note_placeholder')}
          className="resize-none rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
      </label>
      <div className="flex justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onForward}
          disabled={submitting || !targetInboxId}
          data-testid="forward-submit"
        >
          {submitting ? t('conversations.forward_submitting') : t('conversations.forward_submit')}
        </Button>
      </div>
    </section>
  )
}
