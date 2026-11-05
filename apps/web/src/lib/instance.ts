/**
 * Contacts of the company running this install, baked in at build time
 * (Next.js inlines NEXT_PUBLIC_*). An open-source install must not send its
 * users to CosmoBots: unset, the screens leave the contact out.
 */
export function supportEmail(): string | null {
  return process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null
}

/** Billing questions go to finance when set, else to support. */
export function financeEmail(): string | null {
  return process.env.NEXT_PUBLIC_FINANCE_EMAIL?.trim() || supportEmail()
}
