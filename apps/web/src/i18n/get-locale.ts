import { cookies, headers } from 'next/headers'

import {
  AppLocale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isLocale,
} from './config'

const COOKIE_NAME = 'cosmika_locale'

export async function getLocale(): Promise<AppLocale> {
  const cookieStore = await cookies()
  const fromCookie = cookieStore.get(COOKIE_NAME)?.value
  if (isLocale(fromCookie)) return fromCookie

  const headerList = await headers()
  const accept = headerList.get('accept-language') ?? ''
  for (const entry of accept.split(',')) {
    const tag = entry.split(';')[0]?.trim()
    if (!tag) continue
    if (isLocale(tag)) return tag
    const root = tag.split('-')[0]
    const match = SUPPORTED_LOCALES.find((loc) => loc.split('-')[0] === root)
    if (match) return match
  }
  return DEFAULT_LOCALE
}

export const LOCALE_COOKIE_NAME = COOKIE_NAME
