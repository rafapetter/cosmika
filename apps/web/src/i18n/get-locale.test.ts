// Tests for the server-side locale resolver. next/headers is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cookiesGet = vi.fn()
const headersGet = vi.fn()
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookiesGet }),
  headers: async () => ({ get: headersGet }),
}))

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './config'
import { getLocale, LOCALE_COOKIE_NAME } from './get-locale'

beforeEach(() => {
  cookiesGet.mockReset()
  headersGet.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getLocale', () => {
  it('returns cookie value when it matches a supported locale', async () => {
    const someLocale = SUPPORTED_LOCALES[0]
    cookiesGet.mockReturnValueOnce({ value: someLocale })
    headersGet.mockReturnValueOnce('')
    expect(await getLocale()).toBe(someLocale)
  })

  it('ignores cookie value when it is not a supported locale', async () => {
    cookiesGet.mockReturnValueOnce({ value: 'klingon' })
    headersGet.mockReturnValueOnce('')
    expect(await getLocale()).toBe(DEFAULT_LOCALE)
  })

  it('matches Accept-Language header by exact tag', async () => {
    cookiesGet.mockReturnValueOnce(undefined)
    const supported = SUPPORTED_LOCALES[0]
    headersGet.mockReturnValueOnce(`${supported};q=0.9,en-US;q=0.5`)
    expect(await getLocale()).toBe(supported)
  })

  it('matches Accept-Language by language root (xx vs xx-YY)', async () => {
    cookiesGet.mockReturnValueOnce(undefined)
    const supported = SUPPORTED_LOCALES[0]
    const root = supported.split('-')[0]
    headersGet.mockReturnValueOnce(`${root}-ZZ;q=0.9`)
    expect(await getLocale()).toBe(supported)
  })

  it('skips empty / blank entries in Accept-Language', async () => {
    cookiesGet.mockReturnValueOnce(undefined)
    headersGet.mockReturnValueOnce(',, , ,')
    expect(await getLocale()).toBe(DEFAULT_LOCALE)
  })

  it('returns DEFAULT_LOCALE when nothing matches', async () => {
    cookiesGet.mockReturnValueOnce(undefined)
    headersGet.mockReturnValueOnce('xx-YY,zz-WW')
    expect(await getLocale()).toBe(DEFAULT_LOCALE)
  })

  it('returns DEFAULT_LOCALE when neither cookie nor Accept-Language is present', async () => {
    cookiesGet.mockReturnValueOnce(undefined)
    headersGet.mockReturnValueOnce(null)
    expect(await getLocale()).toBe(DEFAULT_LOCALE)
  })
})

describe('LOCALE_COOKIE_NAME', () => {
  it('matches the cookie key the rest of the app uses', () => {
    expect(LOCALE_COOKIE_NAME).toBe('cosmika_locale')
  })
})
