import 'reflect-metadata'
// Sentry must be imported and initialized before any other imports that may
// throw at module load time — otherwise we miss early crashes.
import './sentry'

import { NestFactory } from '@nestjs/core'
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify'

import { AppModule } from './app.module'
import { corsAllowList, corsOptionsFor, type CorsDecision } from './common/cors-options'
import { RequestLogInterceptor } from './common/request-log.interceptor'
import { SentryExceptionFilter } from './common/sentry-exception.filter'
import { trustProxyFromEnv } from './common/trust-proxy'

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Fastify caps a single route parameter at 100 characters by default and
    // answers anything longer with a plain 404, as if the row did not exist.
    // Article ids are slugs imported from the old help site, and two of them
    // are over 100 chars: they could not be read, edited or retired through
    // the API at all, while still being served to the AI by search (which
    // never goes through the :id route). Found on 2026-09-23 trying to
    // unpublish "Como comprar e configurar um número na Twilio?".
    //
    // trustProxy: the client IP behind Caddy, so per-IP throttles are per
    // visitor and not one bucket for everyone. See trust-proxy.ts.
    new FastifyAdapter({ maxParamLength: 500, trustProxy: trustProxyFromEnv() }),
    {
      // Retain the raw JSON body on every request — used by third-party webhook
      // routes (WhatsApp Cloud API) for HMAC signature verification.
      rawBody: true,
    },
  )

  const allowList = corsAllowList(process.env.CORS_ORIGIN)
  // The widget's public routes are called from customers' websites; the
  // console API only from our own app. See cors-options.ts.
  await app.register(
    import('@fastify/cors'),
    () =>
      (req: { url?: string }, cb: (err: Error | null, opts: CorsDecision) => void) => {
        cb(null, corsOptionsFor(req.url, allowList))
      },
  )
  await app.register(import('@fastify/multipart'), {
    limits: {
      fileSize: Number(process.env.ATTACHMENTS_MAX_BYTES ?? 25 * 1024 * 1024),
      files: 1,
    },
  })

  app.useGlobalInterceptors(new RequestLogInterceptor())
  app.useGlobalFilters(new SentryExceptionFilter())

  const port = Number(process.env.PORT ?? 3110)
  await app.listen(port, '0.0.0.0')
  // eslint-disable-next-line no-console
  console.log(`[cosmika-api] listening on :${port}`)
}

void bootstrap()
