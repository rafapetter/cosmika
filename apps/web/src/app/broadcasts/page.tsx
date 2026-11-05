'use client'

import * as React from 'react'
import { Megaphone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type {
  BroadcastDTO,
  InboxDTO,
  WhatsappTemplateDTO,
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

import { api } from '../../lib/api'
import { apiErrorText } from '../../lib/api-error'
import { useDateTime } from '../../lib/format-datetime'
import { useStoredSession } from '../../lib/session-store'

const STATUS_VARIANT: Record<
  string,
  'outline' | 'warning' | 'success' | 'destructive'
> = {
  DRAFT: 'outline',
  SENDING: 'warning',
  SENT: 'success',
  FAILED: 'destructive',
}

export default function BroadcastsPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [items, setItems] = React.useState<BroadcastDTO[] | null>(null)
  const [inboxes, setInboxes] = React.useState<InboxDTO[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [toSend, setToSend] = React.useState<BroadcastDTO | null>(null)

  const reload = React.useCallback(async () => {
    if (!session) return
    try {
      setItems(await api.listBroadcasts(session.session.token, session.account.id))
    } catch (err) {
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    if (!session) return
    api
      .listInboxes(session.session.token, session.account.id)
      .then((all) => setInboxes(all.filter((i) => i.channelType === 'WHATSAPP')))
      .catch(() => setInboxes([]))
    void reload()
  }, [session, reload])

  async function onSendConfirmed(b: BroadcastDTO) {
    if (!session) return
    setToSend(null)
    setBusyId(b.id)
    setError(null)
    try {
      await api.sendBroadcast(session.session.token, session.account.id, b.id)
      await reload()
    } catch (err) {
      setError(apiErrorText(t, err))
    } finally {
      setBusyId(null)
    }
  }

  if (!session) return null

  const statusLabel = (s: string) =>
    t(`broadcasts.status_${s.toLowerCase()}` as never)

  return (
    /* Twenty-style shell, same as the other record grids: full-bleed, only
       the content region scrolls. */
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Megaphone className="size-4 text-muted-foreground" />
          {t('broadcasts.title')}
          {items !== null ? (
            <span
              className="font-normal text-muted-foreground"
              data-testid="record-count"
            >
              · {items.length}
            </span>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">{t('broadcasts.subtitle')}</p>

        {error ? (
          <p
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {inboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('broadcasts.need_inbox')}</p>
        ) : (
          <CreateBroadcastForm
            inboxes={inboxes}
            onCreated={reload}
            onError={setError}
          />
        )}

        {items === null ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('broadcasts.empty')}</p>
        ) : (
          <Table
            className="text-[13px] [&_td]:py-1 [&_th]:h-8"
            data-testid="broadcast-list"
          >
            <TableHeader>
              <TableRow>
                <TableHead>{t('broadcasts.column_name')}</TableHead>
                <TableHead className="border-l border-border">
                  {t('broadcasts.column_status')}
                </TableHead>
                <TableHead className="hidden border-l border-border sm:table-cell">
                  {t('broadcasts.column_audience')}
                </TableHead>
                <TableHead className="hidden border-l border-border md:table-cell">
                  {t('broadcasts.column_results')}
                </TableHead>
                <TableHead className="hidden border-l border-border lg:table-cell">
                  {t('broadcasts.column_created')}
                </TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell className="border-l border-border">
                    <Badge variant={STATUS_VARIANT[b.status] ?? 'outline'}>
                      {statusLabel(b.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden border-l border-border sm:table-cell">
                    <span className="inline-flex max-w-full items-center gap-1 truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                      {b.audience.country
                        ? t('broadcasts.audience_country', { country: b.audience.country })
                        : t('broadcasts.audience_all')}
                    </span>
                  </TableCell>
                  <TableCell className="hidden border-l border-border text-xs text-muted-foreground md:table-cell">
                    {b.status === 'SENT' || b.status === 'FAILED' ? (
                      <>
                        {t('broadcasts.results_sent', { sent: b.sentCount })}
                        {b.failedCount
                          ? `, ${t('broadcasts.results_failed', { failed: b.failedCount })}`
                          : ''}
                      </>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell className="hidden border-l border-border text-xs text-muted-foreground lg:table-cell">
                    {fmt.date(b.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {b.status === 'DRAFT' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setToSend(b)}
                        disabled={busyId === b.id}
                        data-testid={`send-${b.id}`}
                      >
                        {busyId === b.id ? t('broadcasts.sending') : t('broadcasts.send')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Sending is irreversible and fans out to real phones — a proper
          confirm Dialog, never window.confirm. */}
      <Dialog open={toSend !== null} onOpenChange={(o) => !o && setToSend(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('broadcasts.send_title')}</DialogTitle>
            <DialogDescription>
              {toSend ? t('broadcasts.send_confirm', { name: toSend.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToSend(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => toSend && onSendConfirmed(toSend)}
              data-testid="send-confirm"
            >
              {t('broadcasts.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function CreateBroadcastForm({
  inboxes,
  onCreated,
  onError,
}: {
  inboxes: InboxDTO[]
  onCreated: () => Promise<void>
  onError: (msg: string) => void
}) {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [name, setName] = React.useState('')
  const [inboxId, setInboxId] = React.useState(inboxes[0]?.id ?? '')
  const [templates, setTemplates] = React.useState<WhatsappTemplateDTO[]>([])
  const [templateId, setTemplateId] = React.useState('')
  const [vars, setVars] = React.useState<string[]>([])
  const [country, setCountry] = React.useState('')
  const [count, setCount] = React.useState<number | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const template = templates.find((x) => x.id === templateId) ?? null

  // Load approved templates whenever the inbox changes.
  React.useEffect(() => {
    if (!session || !inboxId) return
    api
      .listWhatsappTemplates(session.session.token, session.account.id, inboxId)
      .then((all) => setTemplates(all.filter((x) => x.status === 'APPROVED')))
      .catch(() => setTemplates([]))
    setTemplateId('')
    setVars([])
    setCount(null)
  }, [session, inboxId])

  function pickTemplate(id: string) {
    setTemplateId(id)
    const picked = templates.find((x) => x.id === id)
    setVars(Array.from({ length: picked?.variableCount ?? 0 }, () => ''))
    setCount(null)
  }

  async function preview() {
    if (!session || !inboxId) return
    try {
      const r = await api.previewBroadcastAudience(
        session.session.token,
        session.account.id,
        { inboxId, audience: country ? { country } : {} },
      )
      setCount(r.count)
    } catch (err) {
      onError(apiErrorText(t, err))
    }
  }

  const ready =
    name.trim() &&
    inboxId &&
    template &&
    vars.every((v) => v.trim().length > 0) &&
    !submitting

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!session || !ready || !template) return
    setSubmitting(true)
    try {
      await api.createBroadcast(session.session.token, session.account.id, {
        name: name.trim(),
        inboxId,
        templateId: template.id,
        variables: vars,
        audience: country ? { country } : {},
      })
      setName('')
      setTemplateId('')
      setVars([])
      setCountry('')
      setCount(null)
      await onCreated()
    } catch (err) {
      onError(apiErrorText(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="broadcast-form"
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('broadcasts.form_name_placeholder')}
        data-testid="broadcast-name"
      />
      <div className="grid grid-cols-2 gap-2">
        <Select value={inboxId} onValueChange={setInboxId}>
          <SelectTrigger
            aria-label={t('broadcasts.form_inbox_label')}
            data-testid="broadcast-inbox"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inboxes.map((i) => (
              <SelectItem key={i.id} value={i.id}>
                {i.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={templateId} onValueChange={pickTemplate}>
          <SelectTrigger
            aria-label={t('broadcasts.form_template_label')}
            data-testid="broadcast-template"
          >
            <SelectValue placeholder={t('broadcasts.form_template_placeholder')} />
          </SelectTrigger>
          <SelectContent>
            {templates.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name} ({x.language})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {template ? (
        <div className="rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
          {template.body}
        </div>
      ) : null}

      {vars.map((v, i) => (
        <Input
          key={i}
          value={v}
          onChange={(e) =>
            setVars((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))
          }
          placeholder={t('broadcasts.form_variable', { n: i + 1 })}
          data-testid={`broadcast-var-${i + 1}`}
        />
      ))}

      <div className="flex items-center gap-2">
        <Input
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
          placeholder={t('broadcasts.form_country_placeholder')}
          className="uppercase"
          data-testid="broadcast-country"
        />
        <Button
          type="button"
          variant="outline"
          onClick={preview}
          data-testid="broadcast-preview"
        >
          {t('broadcasts.preview_audience')}
        </Button>
      </div>
      {count !== null ? (
        <p className="text-xs text-muted-foreground" data-testid="broadcast-count">
          {t('broadcasts.recipients_match', { count })}
        </p>
      ) : null}

      <Button type="submit" variant="primary" disabled={!ready} data-testid="broadcast-create">
        {submitting ? t('broadcasts.creating') : t('broadcasts.create')}
      </Button>
    </form>
  )
}
