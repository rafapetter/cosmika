import { defaultLocale, messages, supportedLocales } from '@cosmika/shared/i18n'

export const SUPPORTED_LOCALES = supportedLocales
export const DEFAULT_LOCALE = defaultLocale
export const MESSAGES = messages
export type AppLocale = (typeof supportedLocales)[number]

export function isLocale(value: string | undefined): value is AppLocale {
  if (!value) return false
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
