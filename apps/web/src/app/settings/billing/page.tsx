'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'

import { api, type UsageDTO, type UsageMeterDTO } from '../../../lib/api'
import { apiErrorText } from '../../../lib/api-error'
import { useDateTime } from '../../../lib/format-datetime'
import { PageContainer, PageHeader } from '../../../components/page'
import { useStoredSession } from '../../../lib/session-store'

/**
 * Reais, always written the Brazilian way whatever the interface language:
 * the invoice is in reais, and "R$ 1,234.50" is not a number anyone here
 * would recognise on a bill. Everything else (counts, dates) goes through
 * `useDateTime`, which follows the account's language AND its time zone.
 */
function brl(n: number): string {
  return n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
  })
}

export default function BillingPage() {
  const t = useTranslations()
  const fmt = useDateTime()
  const { session } = useStoredSession()
  const [usage, setUsage] = React.useState<UsageDTO | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    if (!session) return
    try {
      const u = await api.getUsage(session.session.token, session.account.id)
      setUsage(u)
    } catch (err) {
      // The API answers with a machine-readable `code`; this turns it into a
      // sentence in the operator's own language.
      setError(apiErrorText(t, err))
    }
  }, [session, t])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!session) return null

  const METER_LABELS: Record<UsageMeterDTO['key'], string> = {
    newConversations: t('usageLimits.meter_new_conversations'),
    totalConversations: t('usageLimits.meter_total_conversations'),
    contacts: t('usageLimits.meter_contacts'),
  }

  return (
    <PageContainer>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {usage === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('billing.current_plan')}
            </p>
            <p className="mt-1 text-2xl font-semibold">{usage.plan}</p>
            <p className="text-xs text-muted-foreground">
              {/* The old copy here said "hard cap, new entries will be
                  rejected", which described a behaviour the terms forbid and
                  the product no longer has. */}
              {usage.caps.overageFraction === null
                ? t('usageLimits.unlimited')
                : usage.caps.overageFraction === 0
                  ? t('usageLimits.no_overage_plan')
                  : t('usageLimits.never_blocked')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('usageLimits.cycle_resets', { date: fmt.date(usage.ai.resetsAt) })}
            </p>
            {usage.canManageBilling && usage.state === 'upgrade' ? (
              <UpgradeRequest
                token={session.session.token}
                accountId={session.account.id}
              />
            ) : null}
          </div>

          {usage.meters.map((m) => (
            <Meter
              key={m.key}
              label={METER_LABELS[m.key]}
              meter={m}
              billed={m.key !== 'totalConversations' || usage.totalConversationsBilled}
            />
          ))}

          <AiAllowance
            usage={usage}
            token={session.session.token}
            accountId={session.account.id}
            onSaved={load}
          />

          <EstimatedOverage usage={usage} />
        </div>
      )}
    </PageContainer>
  )
}

/**
 * One plan meter.
 *
 * Draws the position against the plan's cap, marks 90% (where the customer is
 * warned) and, on a plan with overage, the point above which we offer a
 * bigger plan instead of a bigger bill.
 */
function Meter({
  label,
  meter,
  billed,
}: {
  label: string
  meter: UsageMeterDTO
  /** False for a meter that is measured and deliberately not charged. */
  billed: boolean
}) {
  const t = useTranslations('usageLimits')
  const fmt = useDateTime()
  const { cap, used, percent, absoluteLimit, billableOver } = meter
  const pct = percent ?? 0
  const over = cap !== null && used > cap
  const warn = pct >= 90 && !over
  const color = over ? 'bg-amber-500' : warn ? 'bg-amber-400' : 'bg-primary'

  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs font-mono">
          {fmt.number(used)}
          {cap !== null ? (
            <>
              {' / '}
              <span className="text-muted-foreground">{fmt.number(cap)}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${color}`}
          style={{ width: cap === null ? '0%' : `${Math.min(100, pct)}%` }}
        />
        {cap !== null ? (
          <span
            className="absolute top-0 h-full w-px bg-foreground/30"
            style={{ left: '90%' }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {cap === null
          ? t('unlimited')
          : over
            ? `${t('over_limit', { n: fmt.number(used - cap) })} ${
                billed
                  ? billableOver > 0
                    ? t('billed_from', { n: fmt.number(billableOver) })
                    : ''
                  : t('not_billed')
              }`.trim()
            : warn
              ? t('near_limit', { pct })
              : t('of_limit', { pct })}
      </p>
      {!over && billed && absoluteLimit !== null && absoluteLimit > cap! ? (
        <p className="text-[10px] text-muted-foreground">
          {t('upgrade_room', { n: fmt.number(absoluteLimit) })}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The AI allowance: conversations the AI answered this month, out of the
 * plan's allowance, plus the one lever the customer has over AI cost.
 */
function AiAllowance({
  usage,
  token,
  accountId,
  onSaved,
}: {
  usage: UsageDTO
  token: string
  accountId: string
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('usageLimits')
  const fmt = useDateTime()
  const ai = usage.ai
  const counted = ai.included !== null
  const pct = counted
    ? Math.min(100, Math.round((ai.conversations / (ai.included as number)) * 100))
    : 0

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">{t('meter_ai')}</p>
        <p className="text-xs font-mono">
          {fmt.number(ai.conversations)}
          {counted ? (
            <>
              {' / '}
              <span className="text-muted-foreground">
                {fmt.number(ai.included as number)}
              </span>
            </>
          ) : null}
        </p>
      </div>
      {counted ? (
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full ${pct >= 100 ? 'bg-amber-500' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      <p className="text-[10px] text-muted-foreground">
        {counted
          ? t('ai_used', {
              used: fmt.number(ai.conversations),
              included: fmt.number(ai.included as number),
            })
          : t('ai_used_uncounted', { used: fmt.number(ai.conversations) })}{' '}
        {t('ai_resets', { date: fmt.date(ai.resetsAt) })}
      </p>
      <p className="text-[10px] text-muted-foreground">
        {ai.overagePriceBrl === null
          ? t('ai_no_overage')
          : t('ai_price', { price: brl(ai.overagePriceBrl) })}
      </p>

      {usage.canManageBilling && ai.overagePriceBrl !== null ? (
        <AiCapForm
          token={token}
          accountId={accountId}
          capBrl={ai.capBrl}
          pricePerConversation={ai.overagePriceBrl}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  )
}

/**
 * "Teto mensal de excedente de IA (R$)".
 *
 * Empty means no ceiling, which is the default and what the terms promise.
 * The equivalent in conversations is shown as the field is typed, because
 * "R$ 100" means nothing on its own and "R$ 100 buys 200 conversations" is
 * the number the customer is actually deciding about.
 */
function AiCapForm({
  token,
  accountId,
  capBrl,
  pricePerConversation,
  onSaved,
}: {
  token: string
  accountId: string
  capBrl: number | null
  pricePerConversation: number
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('usageLimits')
  const tRoot = useTranslations()
  const fmt = useDateTime()
  const [value, setValue] = React.useState(capBrl === null ? '' : String(capBrl))
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const parsed = value.trim() === '' ? null : Number(value.replace(',', '.'))
  const invalid =
    parsed !== null && (!Number.isFinite(parsed) || parsed < 0)
  const equivalent =
    parsed !== null && !invalid && pricePerConversation > 0
      ? Math.floor(parsed / pricePerConversation)
      : null

  async function save() {
    if (invalid) {
      setError(t('ai_cap_invalid'))
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.setAiOverageCap(token, accountId, parsed)
      setSaved(true)
      await onSaved()
    } catch (err) {
      setError(apiErrorText(tRoot, err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1 border-t border-border pt-3">
      <label className="text-xs font-medium" htmlFor="ai-cap">
        {t('ai_cap_label')}
      </label>
      <div className="flex items-center gap-2">
        <input
          id="ai-cap"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSaved(false)
            setError(null)
          }}
          placeholder={t('ai_cap_none')}
          className="w-32 rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {t('ai_cap_save')}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t('ai_cap_help')}</p>
      {equivalent !== null ? (
        <p className="text-[10px] text-muted-foreground">
          {t('ai_cap_equivalent', {
            value: brl(parsed as number),
            n: fmt.number(equivalent),
          })}
        </p>
      ) : null}
      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : saved ? (
        <p className="text-[10px] text-muted-foreground">{t('ai_cap_saved')}</p>
      ) : null}
    </div>
  )
}

/** What the month looks like it will add to the next invoice. */
function EstimatedOverage({ usage }: { usage: UsageDTO }) {
  const t = useTranslations('usageLimits')
  const plan = usage.estimatedPlanOverageBrl
  const ai = usage.ai.estimatedOverageBrl
  if (plan <= 0 && ai <= 0) return null
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-5">
      <p className="text-sm font-medium">{t('estimated_title')}</p>
      <dl className="space-y-0.5 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t('estimated_plan')}</dt>
          <dd className="font-mono">{brl(plan)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{t('estimated_ai')}</dt>
          <dd className="font-mono">{brl(ai)}</dd>
        </div>
      </dl>
      <p className="text-[10px] text-muted-foreground">{t('estimated_note')}</p>
    </div>
  )
}

/**
 * "Solicitar upgrade": a message to whoever handles billing, not a plan
 * change. Changing a plan means a pro-rata charge and a new subscription, and
 * a button in the product that silently changed what someone pays would be
 * the worst possible version of this feature.
 */
function UpgradeRequest({
  token,
  accountId,
}: {
  token: string
  accountId: string
}) {
  const t = useTranslations('usageLimits')
  const [sent, setSent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  if (sent) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">{t('upgrade_requested')}</p>
    )
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void api
          .requestPlanUpgrade(token, accountId)
          .then(() => setSent(true))
          .catch(() => setSent(true))
          .finally(() => setBusy(false))
      }}
      className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
    >
      {t('upgrade_request')}
    </button>
  )
}
