/**
 * The handful of Telegram Bot API calls the channel needs, as plain fetches.
 * https://core.telegram.org/bots/api
 *
 * `TELEGRAM_API_BASE` exists for tests and self-hosted Bot API servers.
 */
export function telegramApiBase(): string {
  return (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/+$/, '')
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`)
  }
}

type TgResponse<T> = { ok: boolean; result?: T; description?: string }

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export type TgSentMessage = { message_id: number; chat: { id: number } }

/** POST a Bot API method with a JSON or multipart body. */
export async function tgCall<T>(
  token: string,
  method: string,
  body?: Record<string, unknown> | FormData,
): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
    method: 'POST',
    ...(isForm
      ? { body: body as FormData }
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }),
  })
  let data: TgResponse<T>
  try {
    data = (await res.json()) as TgResponse<T>
  } catch {
    throw new TelegramApiError(method, res.status, 'non-JSON response')
  }
  if (!res.ok || !data.ok || data.result === undefined) {
    throw new TelegramApiError(method, res.status, data.description ?? 'unknown error')
  }
  return data.result
}

/** Download a file the contact sent: getFile, then the file URL. */
export async function tgDownload(
  token: string,
  fileId: string,
): Promise<{ buffer: Buffer; filePath: string }> {
  const file = await tgCall<{ file_path?: string }>(token, 'getFile', { file_id: fileId })
  if (!file.file_path) throw new TelegramApiError('getFile', 200, 'no file_path (file over 20MB?)')
  const res = await fetch(`${telegramApiBase()}/file/bot${token}/${file.file_path}`)
  if (!res.ok) throw new TelegramApiError('file download', res.status, res.statusText)
  return { buffer: Buffer.from(await res.arrayBuffer()), filePath: file.file_path }
}
