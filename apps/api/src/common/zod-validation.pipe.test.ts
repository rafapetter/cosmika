import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ZodValidationPipe } from './zod-validation.pipe'

describe('ZodValidationPipe', () => {
  it('returns parsed value when input matches schema', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string(), age: z.number() }))
    expect(pipe.transform({ name: 'Hana', age: 28 })).toEqual({ name: 'Hana', age: 28 })
  })

  it('throws BadRequestException with issues array on Zod failure', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string(), age: z.number() }))
    try {
      pipe.transform({ name: 'Hana', age: 'not-a-number' })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException)
      const body = (e as BadRequestException).getResponse() as {
        message: string
        issues: Array<{ path: string; message: string }>
      }
      expect(body.message).toBe('Invalid input')
      expect(body.issues).toHaveLength(1)
      expect(body.issues[0]!.path).toBe('age')
      expect(body.issues[0]!.message).toMatch(/expected number/i)
    }
  })

  it('joins nested path arrays with "."', () => {
    const pipe = new ZodValidationPipe(
      z.object({ user: z.object({ email: z.string().email() }) }),
    )
    try {
      pipe.transform({ user: { email: 'not-an-email' } })
      expect.fail('should have thrown')
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: Array<{ path: string }>
      }
      expect(body.issues[0]!.path).toBe('user.email')
    }
  })

  it('reports multiple issues for multiple failures', () => {
    const pipe = new ZodValidationPipe(
      z.object({ a: z.string(), b: z.number(), c: z.boolean() }),
    )
    try {
      pipe.transform({ a: 1, b: 'x', c: 'no' })
      expect.fail('should have thrown')
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: Array<{ path: string }>
      }
      expect(body.issues.map((i) => i.path).sort()).toEqual(['a', 'b', 'c'])
    }
  })

  it('rethrows non-Zod errors unchanged (defensive)', () => {
    const pipe = new ZodValidationPipe({
      parse: () => {
        throw new Error('not a Zod error')
      },
    } as never)
    expect(() => pipe.transform({})).toThrow('not a Zod error')
  })
})
