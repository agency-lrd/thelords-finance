/**
 * Prorated FIX: how many days of a month an employee is paid for.
 *
 * Business convention (explicit organization settings, never implied):
 *   - every month counts as `divisor` days (30 by default), so February and 31-day months pay alike;
 *   - the start day is paid when `startDayPaid` (default), otherwise pay starts the next day;
 *   - the last calendar day of a month counts as day `divisor`; days past the divisor are not extra.
 * Example: FIX 1,000, start on the 13th, divisor 30 → days 13..30 = 18 → 1,000 / 30 × 18 = 600.
 */
import type { Month } from "@/lib/period"

export type ProrationSettings = { divisor: number; startDayPaid: boolean }

export const DEFAULT_PRORATION: ProrationSettings = { divisor: 30, startDayPaid: true }

export type Proration = { days: number; divisor: number; full: boolean }

const lastDay = (m: Month) => new Date(Date.UTC(m.year, m.month, 0)).getUTCDate()

/** The convention's day number of a calendar day: the month's last day is always `divisor`. */
function dayIndex(m: Month, day: number, divisor: number) {
  return day >= lastDay(m) ? divisor : Math.min(day, divisor)
}

export function payableDays(m: Month, hireDate: Date, terminationDate: Date | null, settings: ProrationSettings = DEFAULT_PRORATION): Proration {
  const { divisor, startDayPaid } = settings
  const first = Date.UTC(m.year, m.month - 1, 1)
  const last = Date.UTC(m.year, m.month - 1, lastDay(m))
  const hire = Date.UTC(hireDate.getUTCFullYear(), hireDate.getUTCMonth(), hireDate.getUTCDate())
  const end = terminationDate ? Date.UTC(terminationDate.getUTCFullYear(), terminationDate.getUTCMonth(), terminationDate.getUTCDate()) : null

  if (hire > last || (end !== null && end < first)) return { days: 0, divisor, full: false }
  let start = 1
  if (hire >= first) start = new Date(hire).getUTCDate() + (startDayPaid ? 0 : 1)
  const stop = end !== null && end <= last ? dayIndex(m, new Date(end).getUTCDate(), divisor) : divisor
  if (start > lastDay(m)) return { days: 0, divisor, full: false }
  const from = Math.min(start, divisor)
  const days = Math.max(0, stop - from + 1)
  return { days, divisor, full: days >= divisor }
}
