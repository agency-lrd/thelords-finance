/** Month keys ("2026-05") used in URLs and forms. Pure helpers, safe on client and server. */

export type Month = { year: number; month: number }

export function parseMonth(value: string | null | undefined): Month | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "")
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null
  return { year, month }
}

export function currentMonth(now = new Date()): Month {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
}

export function monthKey({ year, month }: Month) {
  return `${year}-${String(month).padStart(2, "0")}`
}

export function monthLabel({ year, month }: Month) {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}

export function monthStart({ year, month }: Month) {
  return new Date(Date.UTC(year, month - 1, 1))
}

export function monthEnd({ year, month }: Month) {
  return new Date(Date.UTC(year, month, 0))
}

export function monthIndex({ year, month }: Month) {
  return year * 12 + (month - 1)
}

export function addMonths(m: Month, delta: number): Month {
  const index = monthIndex(m) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

export function monthOfDate(date: Date): Month {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

export function isoDay(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : ""
}
