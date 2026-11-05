import { BadRequestException, PipeTransform } from '@nestjs/common'
import { ZodError, ZodType, ZodTypeDef } from 'zod'
import type { ApiErrorCode } from '@cosmika/shared'

// Second/third generics let a schema TRANSFORM its input (e.g. a JSON string
// query param parsed into a validated array) — ZodSchema<T> alone forces
// input === output and rejects such schemas at the type level.
export class ZodValidationPipe<T, Def extends ZodTypeDef = ZodTypeDef, In = unknown>
  implements PipeTransform<unknown, T>
{
  constructor(private readonly schema: ZodType<T, Def, In>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value)
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          code: 'invalid_input' satisfies ApiErrorCode,
          message: 'Invalid input',
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        })
      }
      throw error
    }
  }
}
