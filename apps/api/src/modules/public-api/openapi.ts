import {
  PublicApiError,
  PublicContactDTO,
  PublicContactsPage,
  PublicContactsQuery,
  PublicConversationDTO,
  PublicConversationsPage,
  PublicConversationsQuery,
  PublicMessageDTO,
  PublicMessagesPage,
  PublicMessagesQuery,
  PublicWebhookConversationResolved,
} from '@cosmika/shared'
import type { ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type JsonSchema = Record<string, unknown>

// zod-to-json-schema's generics recurse past tsc's depth limit on these
// schemas (TS2589); the result is plain JSON anyway.
const toJsonSchema = zodToJsonSchema as unknown as (s: ZodTypeAny, o: object) => JsonSchema

/** JSON Schema (draft 7, which OpenAPI 3.1 accepts) inlined, no $refs. */
function schema(s: ZodTypeAny): JsonSchema {
  const { $schema: _drop, ...rest } = toJsonSchema(s, { $refStrategy: 'none' })
  return rest
}

/** A Zod query object → OpenAPI `in: query` parameters, one per field. */
function queryParams(s: ZodTypeAny) {
  const json = schema(s) as { properties?: Record<string, JsonSchema>; required?: string[] }
  return Object.entries(json.properties ?? {}).map(([name, prop]) => {
    const { description, ...rest } = prop
    return {
      name,
      in: 'query',
      required: Boolean(json.required?.includes(name) && rest.default === undefined),
      ...(description ? { description } : {}),
      schema: rest,
    }
  })
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (name: string) => ({ 'application/json': { schema: ref(name) } })

const errors = {
  '400': { description: 'Parâmetros inválidos.', content: json('Erro') },
  '401': { description: 'Chave de API ausente, inválida ou revogada.', content: json('Erro') },
  '429': { description: 'Limite de requisições excedido. Tente de novo em alguns segundos.' },
}

// The install's name in the reference (COSMIKA_BRAND_NAME), Cosmika by default.
const brand = () => process.env.COSMIKA_BRAND_NAME?.trim() || 'Cosmika'

const description = () => `API REST pública da plataforma de atendimento ${brand()}.

**Autenticação.** Crie uma chave em *Configurações, Chaves de API* (somente administradores) e envie em todas as chamadas:

\`Authorization: Bearer cosmika_<prefixo>_<segredo>\`

A chave dá acesso de leitura a todos os dados da conta. Revogue-a na mesma tela se vazar.

**Paginação.** As listas devolvem \`{ data, nextCursor }\`. Para a próxima página, repita a chamada com \`cursor=<nextCursor>\`. \`nextCursor\` é \`null\` na última página. \`limit\` vai de 1 a 100 (padrão 25).

**Datas.** Sempre ISO 8601. Nos filtros de período, \`from\` é inclusivo e \`to\` é exclusivo; informe o fuso (ex.: \`-03:00\`).

**Webhooks.** Eventos (como o encerramento de uma conversa) são enviados por POST para a URL cadastrada em *Configurações, Webhooks*. O cabeçalho \`x-cosmika-signature: sha256=<hex>\` é o HMAC-SHA256 do corpo bruto com o segredo do webhook; confira antes de confiar no conteúdo. Respostas fora da faixa 2xx são reenviadas com espera crescente. Veja a seção *Webhooks* abaixo.`

export function buildOpenApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: `API pública ${brand()}`,
      version: '1.0.0',
      description: description(),
    },
    servers: [{ url: serverUrl, description: 'Produção' }],
    security: [{ chaveApi: [] }],
    tags: [
      { name: 'Conversas', description: 'Atendimentos e suas mensagens.' },
      { name: 'Contatos', description: 'Clientes da conta.' },
      { name: 'Conta', description: 'Verificação da chave.' },
    ],
    paths: {
      '/v1/whoami': {
        get: {
          tags: ['Conta'],
          summary: 'Valida a chave e mostra a conta',
          operationId: 'whoami',
          responses: {
            '200': {
              description: 'Conta dona da chave.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      account: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          slug: { type: 'string' },
                          name: { type: 'string' },
                          plan: { type: 'string' },
                          status: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errors['401'],
          },
        },
      },
      '/v1/conversations': {
        get: {
          tags: ['Conversas'],
          summary: 'Lista conversas',
          description:
            'Conversas da conta, das mais recentes para as mais antigas (data de criação). Filtre por status, canal e período.',
          operationId: 'listConversations',
          parameters: queryParams(PublicConversationsQuery),
          responses: {
            '200': { description: 'Uma página de conversas.', content: json('PaginaConversas') },
            ...errors,
          },
        },
      },
      '/v1/conversations/{id}/messages': {
        get: {
          tags: ['Conversas'],
          summary: 'Lista as mensagens de uma conversa',
          description: 'Em ordem cronológica. Notas internas só com `includePrivate=true`.',
          operationId: 'listConversationMessages',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'Id da conversa ou o número exibido na tela (ex.: 123).',
              schema: { type: 'string' },
            },
            ...queryParams(PublicMessagesQuery),
          ],
          responses: {
            '200': { description: 'Uma página de mensagens.', content: json('PaginaMensagens') },
            ...errors,
            '404': { description: 'Conversa não encontrada nesta conta.', content: json('Erro') },
          },
        },
      },
      '/v1/contacts': {
        get: {
          tags: ['Contatos'],
          summary: 'Lista contatos',
          description: 'Contatos da conta, dos mais recentes para os mais antigos. Busca opcional por texto.',
          operationId: 'listContacts',
          parameters: queryParams(PublicContactsQuery),
          responses: {
            '200': { description: 'Uma página de contatos.', content: json('PaginaContatos') },
            ...errors,
          },
        },
      },
    },
    webhooks: {
      'conversation.resolved': {
        post: {
          summary: 'Conversa encerrada',
          description:
            'Enviado quando um atendente encerra uma conversa. Responda 2xx em até 10 segundos; outras respostas são reenviadas.',
          operationId: 'webhookConversationResolved',
          parameters: [
            { name: 'x-cosmika-event', in: 'header', required: true, schema: { type: 'string', const: 'conversation.resolved' } },
            {
              name: 'x-cosmika-signature',
              in: 'header',
              required: true,
              description: '`sha256=` seguido do HMAC-SHA256 (hex) do corpo bruto com o segredo do webhook.',
              schema: { type: 'string' },
            },
            {
              name: 'x-cosmika-attempt',
              in: 'header',
              required: true,
              description: 'Número da tentativa, a partir de 1.',
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('WebhookConversaEncerrada') } },
          },
          responses: { '200': { description: 'Recebido.' } },
        },
      },
    },
    components: {
      securitySchemes: {
        chaveApi: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'cosmika_<prefixo>_<segredo>',
          description: 'Chave de API da conta, criada em Configurações, Chaves de API.',
        },
      },
      schemas: {
        Conversa: schema(PublicConversationDTO),
        Mensagem: schema(PublicMessageDTO),
        Contato: schema(PublicContactDTO),
        PaginaConversas: schema(PublicConversationsPage),
        PaginaMensagens: schema(PublicMessagesPage),
        PaginaContatos: schema(PublicContactsPage),
        Erro: schema(PublicApiError),
        WebhookConversaEncerrada: schema(PublicWebhookConversationResolved),
      },
    },
  }
}

/** Swagger UI shell; assets from a pinned CDN build so the API ships no UI bundle. */
export function swaggerHtml(specUrl: string): string {
  const v = '5.17.14'
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API pública ${brand()}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui.css" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${v}/swagger-ui-bundle.js" crossorigin></script>
<script>
window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: true })
</script>
</body>
</html>`
}
