import { describe, expect, it } from 'vitest'

import { corsAllowList, corsOptionsFor } from './cors-options'

describe('corsOptionsFor', () => {
  it('lets any site call the public widget routes, without credentials', () => {
    expect(corsOptionsFor('/widget/abc/messages', ['https://app'])).toEqual({
      origin: true,
      credentials: false,
    })
  })

  it('keeps the console API on the allow list, with credentials', () => {
    expect(corsOptionsFor('/accounts/1/conversations', ['https://app'])).toEqual({
      origin: ['https://app'],
      credentials: true,
    })
    expect(corsOptionsFor(undefined, ['https://app']).credentials).toBe(true)
  })
})

describe('corsAllowList', () => {
  it('splits and trims CORS_ORIGIN, defaulting to the local web app', () => {
    expect(corsAllowList(' https://a , ,https://b ')).toEqual(['https://a', 'https://b'])
    expect(corsAllowList(undefined)).toEqual(['http://localhost:3100'])
  })
})
