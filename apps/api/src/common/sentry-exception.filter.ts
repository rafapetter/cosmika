import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import * as Sentry from '@sentry/node'

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('SentryFilter')

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const res = ctx.getResponse<{
      status: (code: number) => { send: (body: unknown) => void }
    }>()

    // Forward unexpected errors to Sentry. 4xx HttpExceptions are user errors,
    // not bugs — skip them so we don't drown in noise.
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR
    if (status >= 500) {
      Sentry.captureException(exception)
      const message = exception instanceof Error ? exception.message : String(exception)
      this.logger.error(`unhandled: ${message}`)
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse()
      res.status(status).send(body)
    } else {
      res.status(status).send({
        statusCode: status,
        message: 'Internal server error',
      })
    }
  }
}
