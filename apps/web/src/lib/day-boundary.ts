/** `YYYY-MM-DD` from a date input → the instant that day starts, in the
 *  viewer's timezone. `endOfDay` gives the next day's start (exclusive). */
export function dayBoundary(day: string, endOfDay = false): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, endOfDay ? d + 1 : d).toISOString()
}
