/**
 * The billing month.
 *
 * Every meter the customer is billed on has to agree with the invoice, and
 * the invoice is issued from Brazil. Counting in UTC put the first three
 * hours of every Brazilian day in the previous month, which is enough to
 * move a conversation across an invoice boundary and make a bill impossible
 * to reconcile against what the customer sees on their own screen. Nebula's
 * AI ledger already counts in `America/Sao_Paulo`; this is the same rule for
 * Cosmika (decision 14 of the approved plan).
 *
 * Keep the timezone here and nowhere else: a second copy is a second answer.
 */
export const BILLING_TIMEZONE = 'America/Sao_Paulo'

/**
 * How far the billing timezone runs ahead of UTC at a given instant, in
 * milliseconds (negative for Brazil). Derived from `Intl` rather than
 * hard-coded at -3h so the numbers stay right if Brazil ever brings back
 * daylight saving, which it did until 2019.
 */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  /* c8 ignore start -- the `??` arms are unreachable: this formatter is
     constructed right above with every one of these fields requested, so ICU
     always emits them. They exist so a future options change cannot turn a
     missing field into NaN, which would silently move a month boundary. */
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(map.hour ?? '0') % 24
  const asIfUtc = Date.UTC(
    Number(map.year ?? '1970'),
    Number(map.month ?? '1') - 1,
    Number(map.day ?? '1'),
    hour,
    Number(map.minute ?? '0'),
    Number(map.second ?? '0'),
  )
  /* c8 ignore stop */
  return asIfUtc - at.getTime()
}

/** The instant local midnight of `year-month-01` happens, as a UTC Date. */
function localMonthStart(year: number, month: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, 1, 0, 0, 0)
  // First pass uses the offset at the wall-clock instant, which is off by an
  // hour when a DST transition sits between the two; the second pass reads
  // the offset at (nearly) the right instant and settles it.
  const first = wall - offsetMs(new Date(wall), timeZone)
  return new Date(wall - offsetMs(new Date(first), timeZone))
}

/** `YYYY-MM` of `at` as read in the billing timezone. */
export function billingMonthOf(
  at: Date = new Date(),
  timeZone: string = BILLING_TIMEZONE,
): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  /* c8 ignore next -- see offsetMs: both fields are always present */
  return `${map.year ?? '1970'}-${map.month ?? '01'}`
}

/** The billing month before the one `at` falls in, as `YYYY-MM`. */
export function previousBillingMonth(
  at: Date = new Date(),
  timeZone: string = BILLING_TIMEZONE,
): string {
  const [y, m] = billingMonthOf(at, timeZone).split('-').map(Number)
  /* c8 ignore next 2 -- billingMonthOf always yields two numeric parts */
  const year = m === 1 ? (y ?? 1970) - 1 : (y ?? 1970)
  const month = m === 1 ? 12 : (m ?? 1) - 1
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * `YYYY-MM` → the half-open [start, end) interval of UTC instants that month
 * covers in the billing timezone, or null when the string is not a month.
 */
export function billingMonthWindow(
  month: string,
  timeZone: string = BILLING_TIMEZONE,
): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const year = Number(m[1])
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return null
  return {
    start: localMonthStart(year, mon, timeZone),
    end:
      mon === 12
        ? localMonthStart(year + 1, 1, timeZone)
        : localMonthStart(year, mon + 1, timeZone),
  }
}

/** The start of the billing month `at` falls in. The common case. */
export function currentBillingMonthStart(
  at: Date = new Date(),
  timeZone: string = BILLING_TIMEZONE,
): Date {
  const window = billingMonthWindow(billingMonthOf(at, timeZone), timeZone)
  /* c8 ignore next -- billingMonthOf always yields a parseable YYYY-MM */
  if (!window) return at
  return window.start
}

/**
 * The day the current billing month's allowances reset, as an ISO date. Shown
 * on the usage screen next to the AI meter, so "used 280 of 300" comes with
 * the date it goes back to zero.
 */
export function nextBillingMonthStart(
  at: Date = new Date(),
  timeZone: string = BILLING_TIMEZONE,
): Date {
  const window = billingMonthWindow(billingMonthOf(at, timeZone), timeZone)
  /* c8 ignore next -- see currentBillingMonthStart */
  if (!window) return at
  return window.end
}
