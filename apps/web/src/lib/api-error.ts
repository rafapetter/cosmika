'use client'

// One place that turns an API failure into words the viewer can read.
//
// The API answers with a stable `code` plus an English message for logs; the
// interface keys its wording off the code, falls back to a per-status
// sentence, and never shows the raw English message.

import { isApiErrorCode } from '@cosmika/shared'
import type { useTranslations } from 'next-intl'

import { ApiError } from './api'

type T = ReturnType<typeof useTranslations>

const STATUS_KEY: Record<number, string> = {
  400: 'errors.status_400',
  401: 'errors.status_401',
  402: 'errors.status_402',
  403: 'errors.status_403',
  404: 'errors.status_404',
  409: 'errors.status_409',
  413: 'errors.status_413',
  422: 'errors.status_400',
  429: 'errors.status_429',
}

/** The code the API sent, when it sent one we know. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const payload = err.payload
  const code =
    payload && typeof payload === 'object' && 'code' in payload
      ? (payload as { code: unknown }).code
      : null
  return isApiErrorCode(code) ? code : null
}

/** What to show the viewer for a failed request. */
export function apiErrorText(t: T, err: unknown): string {
  const code = apiErrorCode(err)
  if (code) return t(`errors.${code}` as never)
  if (err instanceof ApiError) {
    if (err.status >= 500) return t('errors.status_500')
    const key = STATUS_KEY[err.status]
    if (key) return t(key as never)
  }
  return t('errors.generic')
}
