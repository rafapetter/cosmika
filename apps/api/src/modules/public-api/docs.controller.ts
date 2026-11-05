import { Controller, Get, Header } from '@nestjs/common'

import { buildOpenApiDocument, swaggerHtml } from './openapi'

/**
 * Public, unauthenticated API reference: app.cosmobots.io/api/docs (Caddy
 * strips `/api`, so it arrives as /docs). The document is built once from
 * the shared Zod schemas, the same ones the v1 routes validate with.
 */
@Controller(['docs', 'api/docs'])
export class PublicApiDocsController {
  private readonly document = buildOpenApiDocument(
    process.env.API_PUBLIC_URL?.replace(/\/+$/, '') || 'http://localhost:3110',
  )

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  ui(): string {
    return swaggerHtml('docs/openapi.json')
  }

  @Get('openapi.json')
  spec() {
    return this.document
  }
}
