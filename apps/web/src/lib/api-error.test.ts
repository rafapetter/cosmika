// The point of this module: an operator never reads the API's English.
import { describe, expect, it } from 'vitest'

import { ApiError } from './api'
import { apiErrorCode, apiErrorText } from './api-error'

const t = ((k: string) => k) as never

describe('apiErrorCode', () => {
  it('reads a known code off the payload', () => {
    expect(apiErrorCode(new ApiError(403, 'Administrator role required', { code: 'admin_required' }))).toBe(
      'admin_required',
    )
  })

  it('ignores a code this build does not know, and non-API errors', () => {
    expect(apiErrorCode(new ApiError(400, 'x', { code: 'from_the_future' }))).toBeNull()
    expect(apiErrorCode(new ApiError(400, 'x', null))).toBeNull()
    expect(apiErrorCode(new ApiError(400, 'x', 'plain text body'))).toBeNull()
    expect(apiErrorCode(new Error('boom'))).toBeNull()
  })
})

describe('apiErrorText', () => {
  it('prefers the code', () => {
    expect(apiErrorText(t, new ApiError(409, 'Shortcode already exists', { code: 'shortcode_taken' }))).toBe(
      'errors.shortcode_taken',
    )
  })

  it('falls back to the status when there is no usable code', () => {
    expect(apiErrorText(t, new ApiError(403, 'Forbidden', null))).toBe('errors.status_403')
    expect(apiErrorText(t, new ApiError(422, 'Unprocessable', null))).toBe('errors.status_400')
    expect(apiErrorText(t, new ApiError(503, 'Service Unavailable', null))).toBe('errors.status_500')
    expect(apiErrorText(t, new ApiError(418, "I'm a teapot", null))).toBe('errors.generic')
  })

  it('falls back to the generic message for anything that is not an API error', () => {
    expect(apiErrorText(t, new Error('network down'))).toBe('errors.generic')
    expect(apiErrorText(t, 'nope')).toBe('errors.generic')
  })
})
