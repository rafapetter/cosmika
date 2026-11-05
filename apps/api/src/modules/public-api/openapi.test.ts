import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildOpenApiDocument, swaggerHtml } from './openapi'
import { PublicApiDocsController } from './docs.controller'

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument('https://app.cosmobots.io/api')

  it('documents the three v1 reads, whoami and the conversation.resolved webhook', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/v1/contacts',
      '/v1/conversations',
      '/v1/conversations/{id}/messages',
      '/v1/whoami',
    ])
    expect(Object.keys(doc.webhooks)).toEqual(['conversation.resolved'])
    expect(doc.servers[0]!.url).toBe('https://app.cosmobots.io/api')
    expect(doc.security).toEqual([{ chaveApi: [] }])
  })

  it('every $ref points at a defined component schema', () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!)
    expect(refs.length).toBeGreaterThan(0)
    for (const r of refs) expect(doc.components.schemas).toHaveProperty(r)
  })

  it('turns the Zod query into typed, described query parameters', () => {
    const params = doc.paths['/v1/conversations'].get.parameters as Array<{
      name: string
      required: boolean
      schema: Record<string, unknown>
      description?: string
    }>
    expect(params.map((p) => p.name)).toEqual(['status', 'inboxId', 'from', 'to', 'cursor', 'limit'])
    expect(params.every((p) => p.required === false)).toBe(true)
    expect(params.find((p) => p.name === 'status')!.schema.enum).toEqual(['OPEN', 'RESOLVED', 'PENDING'])
    expect(params.find((p) => p.name === 'limit')!.schema).toMatchObject({ default: 25, maximum: 100 })
    expect(params.every((p) => p.description)).toBe(true)
    const msgParams = doc.paths['/v1/conversations/{id}/messages'].get.parameters as Array<{ name: string; in: string }>
    expect(msgParams[0]).toMatchObject({ name: 'id', in: 'path' })
    expect(msgParams.map((p) => p.name)).toContain('includePrivate')
  })

  it('documents the webhook body and signature header', () => {
    const post = doc.webhooks['conversation.resolved'].post
    expect(post.parameters.map((p) => p.name)).toContain('x-cosmika-signature')
    const body = doc.components.schemas.WebhookConversaEncerrada as { properties: Record<string, unknown> }
    expect(Object.keys(body.properties)).toEqual(['event', 'timestamp', 'data'])
  })

  it('keeps nullable fields nullable in the generated schemas', () => {
    const c = doc.components.schemas.Conversa as { properties: Record<string, { type?: unknown }> }
    expect(JSON.stringify(c.properties.resolvedAt)).toContain('"null"')
    expect(c.properties.lastMessageAt).toEqual(c.properties.resolvedAt)
  })
})

describe('the install name in the reference', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is Cosmika unless the install names itself', () => {
    vi.stubEnv('COSMIKA_BRAND_NAME', ' ')
    expect(buildOpenApiDocument('x').info.title).toBe('API pública Cosmika')
    expect(swaggerHtml('/spec')).toContain('<title>API pública Cosmika</title>')
    vi.stubEnv('COSMIKA_BRAND_NAME', 'Acme')
    const doc = buildOpenApiDocument('x')
    expect(doc.info.title).toBe('API pública Acme')
    expect(doc.info.description).toMatch(/^API REST pública da plataforma de atendimento Acme\./)
  })
})

describe('docs routes', () => {
  it('serve the Swagger UI shell pointing at the relative spec, and the spec itself', () => {
    const ctl = new PublicApiDocsController()
    expect(ctl.ui()).toContain('url: "docs/openapi.json"')
    expect(ctl.ui()).toContain('swagger-ui-dist@5.17.14')
    expect(ctl.spec().openapi).toBe('3.1.0')
  })

  it('escapes the spec url into the page', () => {
    expect(swaggerHtml('a"b')).toContain('url: "a\\"b"')
  })
})
