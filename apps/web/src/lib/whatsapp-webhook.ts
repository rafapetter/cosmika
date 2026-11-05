/**
 * Where Meta must deliver this inbox's events. The address was nowhere in the
 * app, so connecting a customer's own Meta app meant asking us for it.
 */
export function whatsappWebhookUrl(apiBase: string, origin: string, inboxId: string): string {
  // API_BASE is relative ("/api") behind the production proxy; Meta needs an
  // absolute URL.
  const base = new URL(apiBase.replace(/\/+$/, ''), origin).toString().replace(/\/+$/, '')
  return `${base}/webhooks/whatsapp/${inboxId}`
}
