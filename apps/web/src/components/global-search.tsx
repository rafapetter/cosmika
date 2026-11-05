'use client'

import * as React from 'react'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { ApiError, api } from '../lib/api'
import { useStoredSession } from '../lib/session-store'

type Hit = Awaited<ReturnType<typeof api.search>>['hits'][number]

const ROUTE_PREFIX: Record<Hit['kind'], string> = {
  contact: '/contacts/',
  conversation: '/conversations/',
  article: '/knowledge-base/',
}

const LABEL_KEY: Record<Hit['kind'], string> = {
  contact: 'globalSearch.kind_contact',
  conversation: 'globalSearch.kind_conversation',
  article: 'globalSearch.kind_article',
}

/**
 * Compact search popover. Lives in the AppShell header. Debounced query +
 * arrow-key navigation kept off intentionally to keep complexity low — this
 * is a v1.
 */
export function GlobalSearch() {
  const t = useTranslations()
  const { session } = useStoredSession()
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [hits, setHits] = React.useState<Hit[]>([])
  const [loading, setLoading] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Reset cursor when results change.
  React.useEffect(() => {
    setActiveIndex(0)
  }, [hits.length, q])

  // Debounce the search.
  React.useEffect(() => {
    if (!session || q.trim().length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const r = await api.search(session.session.token, session.account.id, q)
        if (!cancelled) setHits(r.hits)
      } catch (err) {
        if (!cancelled && !(err instanceof ApiError)) {
          // eslint-disable-next-line no-console
          console.error(err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, session])

  // Click-outside closes the popover.
  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  if (!session) return null

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIndex((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              const target = hits[activeIndex]
              if (target) {
                e.preventDefault()
                window.location.href = `${ROUTE_PREFIX[target.kind]}${target.id}`
              }
            } else if (e.key === 'Escape') {
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          placeholder={t('globalSearch.placeholder')}
          aria-label={t('globalSearch.placeholder')}
          className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="global-search-input"
        />
      </div>
      {open && q.trim().length >= 2 ? (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          {loading ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('globalSearch.searching')}</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t('globalSearch.no_matches')}</p>
          ) : (
            <ul className="py-1">
              {hits.map((h, idx) => (
                <li key={`${h.kind}:${h.id}`}>
                  <a
                    href={`${ROUTE_PREFIX[h.kind]}${h.id}`}
                    className={`block px-3 py-1.5 text-sm ${
                      idx === activeIndex ? 'bg-muted' : 'hover:bg-muted'
                    }`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => setOpen(false)}
                  >
                    <p className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{h.title}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {t(LABEL_KEY[h.kind] as never)}
                      </span>
                    </p>
                    {h.subtitle ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {h.subtitle}
                      </p>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
