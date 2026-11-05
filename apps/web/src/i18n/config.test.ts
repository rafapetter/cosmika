import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCALE, MESSAGES, SUPPORTED_LOCALES, isLocale } from './config'

describe('i18n config exports', () => {
  it('SUPPORTED_LOCALES is a non-empty list', () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(0)
  })
  it('DEFAULT_LOCALE is one of SUPPORTED_LOCALES', () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE)
  })
  it('MESSAGES is keyed by locale', () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(MESSAGES).toHaveProperty(loc)
    }
  })
})

describe('isLocale', () => {
  it('returns false for undefined or empty string', () => {
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale('')).toBe(false)
  })
  it('returns true for a supported locale', () => {
    expect(isLocale(DEFAULT_LOCALE)).toBe(true)
  })
  it('returns false for an unsupported value', () => {
    expect(isLocale('klingon')).toBe(false)
  })
})
