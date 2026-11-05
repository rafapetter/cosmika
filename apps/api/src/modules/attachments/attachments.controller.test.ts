// Integration tests for the attachments controllers.
//
// These boot a real Nest + Fastify app and drive it through `inject()` rather
// than calling the handlers with a mock reply. That is deliberate: the bug this
// suite pins down (a download redirect answering `200 OK` with a `location`
// header instead of `302 Found`) only reproduces through the real stack.
//
// Nest calls `reply.code(200)` on every route before the handler runs
// (RouterExecutionContext → RouterResponseController.setStatus, even for
// `@Res()` handlers), and Fastify v4's `redirect()` keeps whatever status is
// already on the reply: `code = this[kReplyHasStatusCode] ? raw.statusCode
// : 302`. So a bare `redirect(url)` inherits the 200 and the fallback never
// runs. A hand-rolled reply stub just records `redirect(url)` and reports
// success, which is why this shipped.
import 'reflect-metadata'

import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthGuard } from '../auth/auth.guard'
import type { SessionContext } from '../auth/auth.service'

import {
  AttachmentsController,
  AttachmentsFilesController,
} from './attachments.controller'
import { AttachmentsService } from './attachments.service'

const SIGNED_URL =
  'https://r2.example.com/bucket/acc-1/att-1-photo.png?X-Amz-Signature=deadbeef'

const SESSION: SessionContext = {
  sessionId: 'sess-1',
  user: { id: 'user-1' },
  membership: { id: 'mem-1' },
} as unknown as SessionContext

// Stand-ins for AuthGuard's two dependencies. It only calls
// `sessionFromToken` and `access`, so these keep the suite off Prisma/argon2
// and the billing API while still exercising the genuine guard — and
// therefore its real 401 behaviour.
class FakeAuthService {
  async sessionFromToken(token: string): Promise<SessionContext | null> {
    return token === 'good-token' ? SESSION : null
  }
}

class FakeBillingService {
  async access(_accountId: string): Promise<{ accessAllowed: boolean }> {
    return { accessAllowed: true }
  }
}

const attachments = {
  ingest: vi.fn(),
  toDTO: vi.fn(),
  getDownloadUrl: vi.fn(),
  openLocalStream: vi.fn(),
}

// esbuild (which Vitest uses to transform TS) does not implement
// `emitDecoratorMetadata`, so `design:paramtypes` — the thing Nest reads to
// resolve constructor injection — is never emitted here the way `tsc` emits it
// for the real build. Declare it by hand for the classes this module wires up.
Reflect.defineMetadata(
  'design:paramtypes',
  [AttachmentsService],
  AttachmentsController,
)
Reflect.defineMetadata(
  'design:paramtypes',
  [AttachmentsService],
  AttachmentsFilesController,
)
Reflect.defineMetadata(
  'design:paramtypes',
  [FakeAuthService, FakeBillingService],
  AuthGuard,
)

@Module({
  controllers: [AttachmentsController, AttachmentsFilesController],
  providers: [
    FakeAuthService,
    FakeBillingService,
    { provide: AttachmentsService, useValue: attachments },
  ],
})
class TestModule {}

let app: NestFastifyApplication

async function inject(opts: {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  payload?: string | Buffer
}) {
  return app.getHttpAdapter().getInstance().inject(opts)
}

beforeEach(() => {
  vi.clearAllMocks()
})

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(
    TestModule,
    new FastifyAdapter(),
    { logger: false },
  )
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  })
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /accounts/:accountId/attachments/:id/download', () => {
  it('answers 302 with the storage URL in `location`', async () => {
    attachments.getDownloadUrl.mockResolvedValueOnce(SIGNED_URL)

    const res = await inject({
      method: 'GET',
      url: '/accounts/acc-1/attachments/att-1/download',
      headers: { authorization: 'Bearer good-token' },
    })

    // The regression: Fastify v4 reuses the status Nest already set (200)
    // unless `redirect()` is given one, and browsers ignore `location` on a
    // 200. Assert the status, not just the header.
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(SIGNED_URL)
    expect(attachments.getDownloadUrl).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      'att-1',
    )
  })

  it('sends no body with the redirect', async () => {
    attachments.getDownloadUrl.mockResolvedValueOnce(SIGNED_URL)

    const res = await inject({
      method: 'GET',
      url: '/accounts/acc-1/attachments/att-1/download',
      headers: { authorization: 'Bearer good-token' },
    })

    expect(res.body).toBe('')
  })

  it('rejects an unauthenticated caller before touching storage', async () => {
    const res = await inject({
      method: 'GET',
      url: '/accounts/acc-1/attachments/att-1/download',
    })

    expect(res.statusCode).toBe(401)
    expect(attachments.getDownloadUrl).not.toHaveBeenCalled()
  })

  it('rejects a bad bearer token', async () => {
    const res = await inject({
      method: 'GET',
      url: '/accounts/acc-1/attachments/att-1/download',
      headers: { authorization: 'Bearer nope' },
    })

    expect(res.statusCode).toBe(401)
  })
})

describe('POST /accounts/:accountId/attachments', () => {
  const BOUNDARY = '----cosmikatestboundary'

  function multipartBody(filename: string, mimetype: string, body: string) {
    return Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n` +
        `${body}\r\n` +
        `--${BOUNDARY}--\r\n`,
    )
  }

  it('ingests a multipart upload and returns the DTO', async () => {
    const dto = {
      id: 'att-9',
      accountId: 'acc-1',
      messageId: null,
      fileType: 'IMAGE',
      fileUrl: 's3://bucket/acc-1/att-9-hi.txt',
      fileName: 'hi.txt',
      fileSize: 5,
      mimeType: 'text/plain',
      createdAt: '2026-07-28T00:00:00.000Z',
    }
    attachments.ingest.mockResolvedValueOnce({ id: 'att-9' })
    attachments.toDTO.mockReturnValueOnce(dto)

    const res = await inject({
      method: 'POST',
      url: '/accounts/acc-1/attachments',
      headers: {
        authorization: 'Bearer good-token',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody('hi.txt', 'text/plain', 'hello'),
    })

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual(dto)
    const [userId, accountId, file] = attachments.ingest.mock.calls.at(-1)!
    expect(userId).toBe('user-1')
    expect(accountId).toBe('acc-1')
    expect(file.filename).toBe('hi.txt')
    expect(file.mimetype).toBe('text/plain')
    expect(file.buffer.toString()).toBe('hello')
  })

  it('rejects a non-multipart body', async () => {
    const res = await inject({
      method: 'POST',
      url: '/accounts/acc-1/attachments',
      headers: {
        authorization: 'Bearer good-token',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ nope: true }),
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Use multipart/form-data')
  })

  it('rejects a multipart body with no file part', async () => {
    const res = await inject({
      method: 'POST',
      url: '/accounts/acc-1/attachments',
      headers: {
        authorization: 'Bearer good-token',
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="caption"\r\n\r\n` +
          `just a field\r\n` +
          `--${BOUNDARY}--\r\n`,
      ),
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('No file in request')
  })
})

describe('GET /attachments-files/:id', () => {
  it('streams the file with its stored content type', async () => {
    attachments.openLocalStream.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('file-bytes')]),
      att: { mimeType: 'image/png' },
    })

    const res = await inject({
      method: 'GET',
      url: '/attachments-files/att-1',
      headers: { authorization: 'Bearer good-token' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body).toBe('file-bytes')
    expect(attachments.openLocalStream).toHaveBeenCalledWith('user-1', 'att-1')
  })

  it('falls back to octet-stream when the mime type is unknown', async () => {
    attachments.openLocalStream.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('x')]),
      att: { mimeType: null },
    })

    const res = await inject({
      method: 'GET',
      url: '/attachments-files/att-2',
      headers: { authorization: 'Bearer good-token' },
    })

    expect(res.headers['content-type']).toBe('application/octet-stream')
  })
})
