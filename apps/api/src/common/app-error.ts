import type { ApiErrorCode } from '@cosmika/shared'

/**
 * Body for an HTTP exception that the interface can translate.
 *
 * Nest lifts `message` onto the exception, so `toThrow('…')` assertions and
 * logs keep reading the English sentence while the client keys its wording
 * off `code`.
 */
export function errBody(
  code: ApiErrorCode,
  message: string,
): { code: ApiErrorCode; message: string } {
  return { code, message }
}
