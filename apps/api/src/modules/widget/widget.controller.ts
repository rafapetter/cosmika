import { Body, Controller, Get, Header, Headers, Param, Post, Query, Res } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { z } from 'zod'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'

import { WidgetService } from './widget.service'

const CreateSessionInput = z.object({
  visitorId: z.string().min(8).max(64).optional().nullable(),
  name: z.string().min(1).max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  // Pre-chat answers keyed by field key (max 10 keys, short string values).
  preChat: z.record(z.string().max(2000)).optional().nullable(),
})

const PostMessageInput = z.object({
  visitorToken: z.string().min(20),
  content: z.string().min(1).max(4000),
  // Id of the menu option the visitor tapped, so the flow follows that edge
  // instead of guessing from the label.
  interactiveReplyId: z.string().min(1).max(256).optional().nullable(),
})

const ListMessagesQuery = z.object({
  visitorToken: z.string().min(20),
})

@Controller('widget/:hash')
export class WidgetController {
  constructor(private readonly widget: WidgetService) {}

  @Post('sessions')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async createSession(
    @Param('hash') hash: string,
    @Headers('origin') origin: string | undefined,
    @Body(new ZodValidationPipe(CreateSessionInput))
    body: z.infer<typeof CreateSessionInput>,
  ) {
    return this.widget.createSession({
      hash,
      visitorId: body.visitorId ?? undefined,
      name: body.name ?? undefined,
      email: body.email ?? undefined,
      preChat: body.preChat ?? undefined,
      origin,
    })
  }

  @Get('config')
  @Header('cache-control', 'public, max-age=60')
  async config(@Param('hash') hash: string) {
    return this.widget.publicConfig(hash)
  }

  @Post('messages')
  async postMessage(
    @Param('hash') hash: string,
    @Headers('origin') origin: string | undefined,
    @Body(new ZodValidationPipe(PostMessageInput))
    body: z.infer<typeof PostMessageInput>,
  ) {
    return this.widget.postMessage({
      hash,
      token: body.visitorToken,
      content: body.content,
      interactiveReplyId: body.interactiveReplyId ?? null,
      origin,
    })
  }

  @Get('messages')
  async listMessages(
    @Param('hash') hash: string,
    @Headers('origin') origin: string | undefined,
    @Query(new ZodValidationPipe(ListMessagesQuery))
    query: z.infer<typeof ListMessagesQuery>,
  ) {
    return this.widget.listMessages({
      hash,
      token: query.visitorToken,
      origin,
    })
  }

  @Get('embed.js')
  async embed(
    @Param('hash') hash: string,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown; status(code: number): unknown },
  ): Promise<string> {
    // The headers are set here rather than with @Header: a decorator-declared
    // JavaScript content type made Fastify refuse the JSON error body of an
    // unknown hash and answer 500 instead of 404.
    reply.header('content-type', 'application/javascript')
    try {
      // Make sure the hash is real before serving JS for it.
      await this.widget.resolveInbox(hash)
    } catch {
      reply.status(404)
      return '/* Cosmika: unknown widget */'
    }
    reply.header('cache-control', 'public, max-age=60')
    // Only a fallback: the script derives the API base from its own URL, so
    // it works behind any proxy prefix without this being configured.
    const apiBase =
      process.env.API_PUBLIC_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:3110'
    return this.widget.embedScript(hash, apiBase)
  }
}
