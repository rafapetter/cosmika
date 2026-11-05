'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import type { AgentBotModel, CreateAgentBotInput } from '@cosmika/shared'
import {
  Button,
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
import { parseKnowledgeTags } from '../knowledge-tags'

const MODELS: AgentBotModel[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'gpt-5.6-luna',
  'deepseek/deepseek-v4.1-flash',
]

export default function NewAgentBotPage() {
  const t = useTranslations()
  const router = useRouter()
  const { session, ready } = useStoredSession()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [knowledgeTags, setKnowledgeTags] = useState('')
  // Starts in the operator's language so the agent answers customers in it too.
  const [systemPrompt, setSystemPrompt] = useState(() => t('agentBots.default_system_prompt'))
  const [model, setModel] = useState<AgentBotModel>('gpt-5.6-luna')
  const [dailyBudget, setDailyBudget] = useState('10')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!ready) {
    return (
      <main className="container flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
      </main>
    )
  }
  if (!session) {
    router.replace('/sign-in')
    return null
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return
    const dailyBudgetUsd = Number(dailyBudget)
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
      setError(t('auth.generic_error'))
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: CreateAgentBotInput = {
        name,
        description: description || null,
        systemPrompt,
        knowledgeTags: parseKnowledgeTags(knowledgeTags),
        model,
        dailyBudgetUsd,
      }
      const bot = await api.createAgentBot(
        session.session.token,
        session.account.id,
        body,
      )
      router.push(`/agent-bots/${bot.id}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('agentBots.forbidden'))
      } else {
        setError(t('auth.generic_error'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl p-8 space-y-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('agentBots.new_title')}
          </h1>
        </header>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">{t('agentBots.name')}</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
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
              rows={8}
              required
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('agentBots.system_prompt_help')}
            </p>
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
            <p className="text-xs text-muted-foreground">
              {t('agentBots.daily_budget_help')}
            </p>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between">
            <Link
              href="/agent-bots"
              className="text-sm text-muted-foreground hover:underline"
            >
              ← {t('agentBots.back_to_list')}
            </Link>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.loading') : t('agentBots.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
      </main>
  )
}
