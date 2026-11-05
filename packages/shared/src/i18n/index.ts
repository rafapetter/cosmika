import type { Locale } from '../schemas/account'

import pt from './pt'
import es from './es'
import en from './en'


export const messages = {
  'pt-BR': pt,
  es,
  en,
} as const

export const defaultLocale: Locale = 'pt-BR'
export const supportedLocales: Locale[] = ['pt-BR', 'es', 'en']

export type Messages = (typeof messages)[Locale]
