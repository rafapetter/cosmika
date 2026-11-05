import { z } from 'zod'

import {
  ContentType,
  ConversationStatus,
  MessageStatus,
  Priority,
  SenderType,
} from './conversation'
import { ChannelType } from './inbox'

// Public REST API v1 (API key). These schemas are the contract: the routes
// validate with them and the OpenAPI document is generated from them, so the
// descriptions below are what an integrator reads in the Swagger UI.

const Limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe('Itens por página, de 1 a 100 (padrão 25).')
const Cursor = z
  .string()
  .min(1)
  .optional()
  .describe('Valor de `nextCursor` da página anterior. Omita para a primeira página.')
const From = z
  .string()
  .datetime({ offset: true })
  .optional()
  .describe('Início do período (inclusivo), ISO 8601. Ex.: 2026-10-01T00:00:00-03:00')
const To = z
  .string()
  .datetime({ offset: true })
  .optional()
  .describe('Fim do período (exclusivo), ISO 8601. Ex.: 2026-11-01T00:00:00-03:00')

const periodIsOrdered = (q: { from?: string; to?: string }) =>
  !q.from || !q.to || new Date(q.from) < new Date(q.to)
const periodMessage = { message: '`from` deve ser anterior a `to`', path: ['to'] }

export const PublicConversationsQuery = z
  .object({
    status: ConversationStatus.optional().describe(
      'Filtra pelo status: OPEN = aberta, PENDING = pendente, RESOLVED = encerrada.',
    ),
    inboxId: z.string().min(1).optional().describe('Filtra por canal (id da caixa de entrada).'),
    from: From,
    to: To,
    cursor: Cursor,
    limit: Limit,
  })
  .refine(periodIsOrdered, periodMessage)
export type PublicConversationsQuery = z.infer<typeof PublicConversationsQuery>

export const PublicMessagesQuery = z.object({
  includePrivate: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe('Inclui as notas internas dos atendentes (padrão false).'),
  cursor: Cursor,
  limit: Limit,
})
export type PublicMessagesQuery = z.infer<typeof PublicMessagesQuery>

export const PublicContactsQuery = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Busca por nome, e-mail, telefone ou identificador.'),
    from: From,
    to: To,
    cursor: Cursor,
    limit: Limit,
  })
  .refine(periodIsOrdered, periodMessage)
export type PublicContactsQuery = z.infer<typeof PublicContactsQuery>

export const PublicContactDTO = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phoneNumber: z.string().nullable().describe('Telefone em formato E.164 quando conhecido.'),
    identifier: z.string().nullable().describe('Identificador externo do contato no seu sistema.'),
    customAttributes: z.record(z.unknown()).describe('Atributos personalizados.'),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe('Contato (cliente) da conta.')
export type PublicContactDTO = z.infer<typeof PublicContactDTO>

export const PublicConversationDTO = z
  .object({
    id: z.string(),
    displayId: z.number().int().describe('Número da conversa exibido na tela (#123).'),
    protocol: z
      .string()
      .nullable()
      .describe('Protocolo de atendimento, o mesmo em todos os canais do mesmo caso (AAAAMMDD-NNNNNN).'),
    status: ConversationStatus,
    priority: Priority,
    inbox: z.object({ id: z.string(), name: z.string(), channelType: ChannelType }),
    contact: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      phoneNumber: z.string().nullable(),
    }),
    assignee: z
      .object({ id: z.string(), fullName: z.string().nullable(), email: z.string() })
      .nullable()
      .describe('Atendente responsável, ou null.'),
    team: z.object({ id: z.string(), name: z.string() }).nullable(),
    lastMessageAt: z.string().datetime().nullable(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe('Conversa (atendimento).')
export type PublicConversationDTO = z.infer<typeof PublicConversationDTO>

export const PublicMessageDTO = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    senderType: SenderType.describe(
      'CONTACT = cliente, USER = atendente, AGENT_BOT = robô ou IA, SYSTEM = sistema.',
    ),
    sender: z
      .object({ id: z.string(), name: z.string().nullable() })
      .nullable()
      .describe('Atendente ou contato que enviou, quando houver.'),
    content: z.string().nullable(),
    contentType: ContentType,
    status: MessageStatus,
    isPrivate: z.boolean().describe('true para nota interna (não vai ao cliente).'),
    attachments: z.array(
      z.object({
        id: z.string(),
        fileType: z.string(),
        fileUrl: z.string(),
        fileName: z.string().nullable(),
        mimeType: z.string().nullable(),
        fileSize: z.number().int().nullable(),
      }),
    ),
    createdAt: z.string().datetime(),
  })
  .describe('Mensagem de uma conversa.')
export type PublicMessageDTO = z.infer<typeof PublicMessageDTO>

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe('Passe em `cursor` para buscar a próxima página; null na última.'),
  })

export const PublicConversationsPage = page(PublicConversationDTO)
export type PublicConversationsPage = z.infer<typeof PublicConversationsPage>
export const PublicMessagesPage = page(PublicMessageDTO)
export type PublicMessagesPage = z.infer<typeof PublicMessagesPage>
export const PublicContactsPage = page(PublicContactDTO)
export type PublicContactsPage = z.infer<typeof PublicContactsPage>

export const PublicApiError = z
  .object({
    statusCode: z.number().int(),
    message: z.union([z.string(), z.array(z.string())]),
    code: z.string().optional(),
  })
  .describe('Erro da API.')

/** Body of every webhook POST (`x-cosmika-signature: sha256=<hmac>`). */
export const PublicWebhookConversationResolved = z
  .object({
    event: z.literal('conversation.resolved'),
    timestamp: z.string().datetime().describe('Momento do envio.'),
    data: z.object({
      conversationId: z.string(),
      displayId: z.number().int(),
      status: z.literal('RESOLVED'),
    }),
  })
  .describe('Corpo enviado quando uma conversa é encerrada.')
