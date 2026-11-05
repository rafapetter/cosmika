import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'

import { errBody } from './app-error'

describe('errBody', () => {
  it('carries the code and keeps the English message on the exception', () => {
    const err = new ForbiddenException(errBody('admin_required', 'Administrator role required'))
    expect(err.getResponse()).toEqual({
      code: 'admin_required',
      message: 'Administrator role required',
    })
    // Nest lifts `message`, which is what logs and toThrow() assertions read.
    expect(err.message).toBe('Administrator role required')
    expect(err.getStatus()).toBe(403)
  })
})
