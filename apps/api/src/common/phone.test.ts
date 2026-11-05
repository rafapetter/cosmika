import { describe, expect, it } from 'vitest'

import { normalizePhone, phoneLookupVariants } from './phone'

describe('normalizePhone', () => {
  it('turns what people type into E.164', () => {
    expect(normalizePhone('(11) 99999-0000')).toBe('+5511999990000')
    expect(normalizePhone('011 3333-4444')).toBe('+551133334444')
    expect(normalizePhone('+55 11 99999-0000')).toBe('+5511999990000')
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671')
  })

  it('rejects what is not a phone', () => {
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone(null)).toBeNull()
    expect(normalizePhone(undefined)).toBeNull()
    expect(normalizePhone('abc')).toBeNull()
    expect(normalizePhone('+1234')).toBeNull()
    expect(normalizePhone('+1234567890123456')).toBeNull()
  })
})

describe('phoneLookupVariants', () => {
  it('covers + and the Brazilian ninth digit both ways', () => {
    expect(new Set(phoneLookupVariants('5511999990000'))).toEqual(
      new Set(['5511999990000', '+5511999990000', '551199990000', '+551199990000']),
    )
    expect(new Set(phoneLookupVariants('551199990000'))).toEqual(
      new Set(['551199990000', '+551199990000', '5511999990000', '+5511999990000']),
    )
  })

  it('leaves landlines and other countries alone', () => {
    expect(new Set(phoneLookupVariants('551133334444'))).toEqual(new Set(['551133334444', '+551133334444']))
    expect(new Set(phoneLookupVariants('+14155552671'))).toEqual(new Set(['+14155552671', '14155552671']))
    expect(phoneLookupVariants('bsuid-not-a-phone')).toEqual(['bsuid-not-a-phone'])
  })
})
