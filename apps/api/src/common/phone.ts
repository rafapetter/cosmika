/**
 * Phone numbers as contacts type them and as WhatsApp reports them, made
 * comparable.
 *
 * A visitor types "(11) 99999-0000" in the website chat; WhatsApp later says
 * the same person is 5511999990000, or 551199990000 for an account registered
 * before Brazil's ninth digit. Matching all of those is what lets one contact
 * (and one protocol) span Webchat and WhatsApp.
 */

/** E.164 (`+5511999990000`) from whatever was typed, or null if it isn't a phone. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = raw.replace(/\D/g, '')
  if (raw.trim().startsWith('00')) digits = digits.slice(2)
  // A Brazilian number typed without the country code: DDD + 8 or 9 digits.
  if ((digits.length === 10 || digits.length === 11) && !raw.trim().startsWith('+')) {
    digits = `55${digits.replace(/^0/, '')}`
  }
  if (digits.length < 8 || digits.length > 15) return null
  return `+${digits}`
}

/**
 * Every stored form the same phone may have: with and without `+`, and for a
 * Brazilian mobile, with and without the ninth digit.
 */
export function phoneLookupVariants(raw: string): string[] {
  const e164 = normalizePhone(raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`)
  if (!e164) return [raw]
  const digits = e164.slice(1)
  const forms = new Set<string>([digits])
  const br = /^55(\d{2})(\d{8,9})$/.exec(digits)
  if (br) {
    const [, ddd, local] = br as unknown as [string, string, string]
    if (local.length === 9 && local.startsWith('9')) forms.add(`55${ddd}${local.slice(1)}`)
    if (local.length === 8 && /^[6-9]/.test(local)) forms.add(`55${ddd}9${local}`)
  }
  const out = new Set<string>([raw])
  for (const f of forms) {
    out.add(f)
    out.add(`+${f}`)
  }
  return [...out]
}
