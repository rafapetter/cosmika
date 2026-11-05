'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { CsatPublicSurvey } from '@cosmika/shared'
import { Button, FormField, Textarea, cn } from '@cosmika/ui'

import { API_BASE } from '../../../lib/api'

export default function CsatPublicPage() {
  const t = useTranslations()
  const params = useParams<{ token: string }>()
  const token = Array.isArray(params?.token) ? params.token[0] : params?.token
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'already' }
    | { kind: 'ready'; survey: CsatPublicSurvey }
    | { kind: 'submitted' }
  >({ kind: 'loading' })
  const [rating, setRating] = React.useState<number | null>(null)
  const [hovered, setHovered] = React.useState<number | null>(null)
  const [comment, setComment] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/csat/${token}`, { method: 'GET' })
        if (cancelled) return
        if (res.status === 404) {
          setState({ kind: 'error', message: t('csatSurvey.invalid_link') })
          return
        }
        if (!res.ok) {
          setState({
            kind: 'error',
            message: t('csatSurvey.load_failed'),
          })
          return
        }
        const survey: CsatPublicSurvey = await res.json()
        if (survey.alreadyResponded) {
          setState({ kind: 'already' })
        } else {
          setState({ kind: 'ready', survey })
        }
      } catch {
        if (cancelled) return
        setState({ kind: 'error', message: t('csatSurvey.load_failed') })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, t])

  async function submit() {
    if (!token || rating === null) return
    setSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/csat/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rating,
          comment: comment.trim() ? comment.trim() : undefined,
        }),
      })
      if (!res.ok) {
        setState({ kind: 'error', message: t('csatSurvey.submit_failed') })
        return
      }
      setState({ kind: 'submitted' })
    } catch {
      setState({ kind: 'error', message: t('csatSurvey.submit_failed') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
        {state.kind === 'loading' ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : state.kind === 'error' ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.message}
          </p>
        ) : state.kind === 'already' ? (
          <div className="space-y-2 text-center">
            <h1 className="text-lg font-semibold">{t('csatSurvey.already_title')}</h1>
            <p className="text-sm text-muted-foreground">{t('csatSurvey.already_body')}</p>
          </div>
        ) : state.kind === 'submitted' ? (
          <div className="space-y-2 text-center">
            <h1 className="text-lg font-semibold">{t('csatSurvey.thanks_title')}</h1>
            <p className="text-sm text-muted-foreground">{t('csatSurvey.thanks_body')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <header className="space-y-1">
              <h1 className="text-lg font-semibold">
                {state.survey.type === 'NPS' ? t('csatSurvey.nps_title') : t('csatSurvey.title')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {state.survey.type === 'NPS'
                  ? t('csatSurvey.nps_question', { account: state.survey.accountName })
                  : t('csatSurvey.intro', {
                      account: state.survey.accountName,
                      id: state.survey.conversationDisplayId,
                    })}
              </p>
            </header>

            {state.survey.type === 'NPS' ? (
              <NpsScale value={rating} onChange={setRating} />
            ) : (
            <div className="flex justify-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHovered(n)}
                  onMouseLeave={() => setHovered(null)}
                  aria-label={t('csatSurvey.rate', { n })}
                  data-testid={`star-${n}`}
                  className={cn(
                    'text-3xl transition-colors',
                    (hovered ?? rating ?? 0) >= n
                      ? 'text-amber-400'
                      : 'text-muted-foreground/40 hover:text-amber-300',
                  )}
                >
                  ★
                </button>
              ))}
            </div>
            )}

            <FormField label={t('csatSurvey.comment')} htmlFor="csat-comment">
              <Textarea
                id="csat-comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder={t('csatSurvey.comment_placeholder')}
                className="resize-y"
              />
            </FormField>

            <Button
              variant="primary"
              className="w-full"
              onClick={submit}
              disabled={rating === null || submitting}
              data-testid="csat-submit"
            >
              {submitting ? t('csatSurvey.submitting') : t('csatSurvey.submit')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 0 to 10, as the NPS question asks; wraps to two rows on a phone. */
function NpsScale({ value, onChange }: { value: number | null; onChange: (n: number) => void }) {
  const t = useTranslations()
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={t('csatSurvey.nps_title')} className="grid grid-cols-6 gap-1 sm:grid-cols-11">
        {Array.from({ length: 11 }, (_, n) => (
          <Button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={t('csatSurvey.nps_rate', { n })}
            data-testid={`nps-${n}`}
            variant={value === n ? 'primary' : 'outline'}
            size="sm"
            className="px-0 tabular-nums"
            onClick={() => onChange(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{t('csatSurvey.nps_low')}</span>
        <span>{t('csatSurvey.nps_high')}</span>
      </div>
    </div>
  )
}
