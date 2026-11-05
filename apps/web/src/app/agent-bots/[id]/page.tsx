'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import type { AgentBotDTO, AgentBotModel } from '@cosmika/shared'
import { BUILT_IN_AGENT_TOOLS } from '@cosmika/shared'
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@cosmika/ui'

import { ApiError, api } from '../../../lib/api'
import { useStoredSession } from '../../../lib/session-store'
import { formatKnowledgeTags, parseKnowledgeTags } from '../knowledge-tags'

const MODELS: AgentBotModel[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-5.6-luna',
  'deepseek/deepseek-v4.1-flash',
]

export default function AgentBotDetailPage() {
  const t = useTranslations()
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const botId = params.id
  const { session, ready } = useStoredSession()

  const [bot, setBot] = useState<AgentBotDTO | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [knowledgeTags, setKnowledgeTags] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [model, setModel] = useState<AgentBotModel>('gpt-5.6-luna')
  const [dailyBudget, setDailyBudget] = useState('10')
  const [threshold, setThreshold] = useState('80')
  const [tools, setTools] = useState<string[]>([])
  const [isActive, setIsActive] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!session) return
    const b = await api.getAgentBot(session.session.token, session.account.id, botId)
    setBot(b)
    setName(b.name)
    setDescription(b.description ?? '')
    setKnowledgeTags(formatKnowledgeTags(b.knowledgeTags))
    setSystemPrompt(b.systemPrompt)
    setModel(b.model as AgentBotModel)
    setDailyBudget(String(b.dailyBudgetUsd))
    setThreshold(String(b.autoSafeConfidenceThreshold))
    // An empty list means "all built-ins" on the API; show that explicitly.
    setTools(
      b.toolsEnabled.length > 0
        ? b.toolsEnabled.map((x) => x.name)
        : [...BUILT_IN_AGENT_TOOLS],
    )
    setIsActive(b.isActive)
  }, [session, botId])

  useEffect(() => {
    if (!ready) return
    if (!session) {
      router.replace('/sign-in')
      return
    }
    refresh().catch((err) => {
      if (err instanceof ApiError && err.status === 403) {
        setLoadError(t('agentBots.forbidden'))
      } else if (err instanceof ApiError && err.status === 404) {
        router.replace('/agent-bots')
      } else {
        setLoadError(t('auth.generic_error'))
      }
    })
  }, [ready, session, router, refresh, t])

  if (!ready || !session) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }
  if (loadError) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
        <Link
          href="/agent-bots"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {t('agentBots.back_to_list')}
        </Link>
      </div>
      </main>
    )
  }
  if (!bot) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
      </main>
    )
  }

  async function onSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !bot) return
    setError(null)
    setSaving(true)
    try {
      await api.updateAgentBot(session.session.token, session.account.id, botId, {
        name,
        description: description || null,
        systemPrompt,
        knowledgeTags: parseKnowledgeTags(knowledgeTags),
        model,
        dailyBudgetUsd: Number(dailyBudget),
        autoSafeConfidenceThreshold: Number(threshold),
        toolsEnabled: tools.map((name) => ({ name })),
        isActive,
      })
      await refresh()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('agentBots.forbidden'))
      } else {
        setError(t('auth.generic_error'))
      }
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!session) return
    if (!window.confirm(t('agentBots.confirm_delete'))) return
    try {
      await api.deleteAgentBot(session.session.token, session.account.id, botId)
      router.push('/agent-bots')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('agentBots.forbidden'))
      } else {
        setError(t('auth.generic_error'))
      }
    }
  }

  const budgetPct = Math.min(
    100,
    Math.round((bot.costLast24hUsd / Math.max(bot.dailyBudgetUsd, 0.0001)) * 100),
  )

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('agentBots.edit_title')}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('agentBots.cost_last_24h')}: ${bot.costLast24hUsd.toFixed(4)} / $
            {bot.dailyBudgetUsd.toFixed(2)} ({budgetPct}%) ·{' '}
            {bot.inboxCount} {t('agentBots.inbox_count')}
          </p>
          <div className="mt-2 h-1.5 w-full rounded bg-secondary">
            <div
              className="h-1.5 rounded bg-primary"
              style={{ width: `${budgetPct}%` }}
            />
          </div>
        </header>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <form onSubmit={onSave} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('agentBots.name')}</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">{t('agentBots.description')}</Label>
            <Input
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="systemPrompt">{t('agentBots.system_prompt')}</Label>
            <Textarea
              id="systemPrompt"
              rows={10}
              required
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="knowledgeTags">{t('agentBots.knowledge_tags')}</Label>
            <Input
              id="knowledgeTags"
              value={knowledgeTags}
              placeholder={t('agentBots.knowledge_tags_placeholder')}
              onChange={(e) => setKnowledgeTags(e.target.value)}
              data-testid="bot-knowledge-tags"
            />
            <p className="text-xs text-muted-foreground">
              {t('agentBots.knowledge_tags_hint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="model">{t('agentBots.model')}</Label>
            <Select value={model} onValueChange={(v) => setModel(v as AgentBotModel)}>
              <SelectTrigger id="model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dailyBudget">{t('agentBots.daily_budget')}</Label>
            <Input
              id="dailyBudget"
              type="number"
              step="0.01"
              min="0"
              value={dailyBudget}
              onChange={(e) => setDailyBudget(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="threshold">{t('agentBots.confidence_threshold')}</Label>
            <Input
              id="threshold"
              type="number"
              step="1"
              min="0"
              max="100"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('agentBots.confidence_threshold_hint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t('agentBots.tools')}</Label>
            <div className="space-y-1">
              {BUILT_IN_AGENT_TOOLS.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={tools.includes(name)}
                    onCheckedChange={(v) =>
                      setTools((prev) =>
                        v === true ? [...prev, name] : prev.filter((x) => x !== name),
                      )
                    }
                  />
                  {t(`assistantTools.${name}` as never)}
                </label>
              ))}
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox
              checked={isActive}
              onCheckedChange={(v) => setIsActive(v === true)}
            />
            {t('agentBots.is_active')}
          </label>

          <div className="flex items-center justify-between">
            <Link
              href="/agent-bots"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('agentBots.back_to_list')}
            </Link>
            <Button type="submit" disabled={saving} data-testid="save-bot">
              {saving ? t('common.loading') : t('agentBots.save_changes')}
            </Button>
          </div>
        </form>

        <section className="rounded-md border border-destructive/30 p-4">
          <Button
            variant="destructive"
            onClick={onDelete}
            data-testid="delete-bot"
          >
            {t('agentBots.delete')}
          </Button>
        </section>
      </div>
    </div>
      </main>
  )
}
