/** Month keys ("YYYY-MM") for navigation: shifting by months or years, and validation. Pure. */

const KEY = /^(\d{4})-(0[1-9]|1[0-2])$/

export function isMonthKey(v: string | null | undefined): v is string {
  if (!v || !KEY.test(v)) return false
  const year = Number(v.slice(0, 4))
  return year >= 2000 && year <= 2100
}

export function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split("-").map(Number)
  const index = y * 12 + (m - 1) + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

export function monthKeyOf(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`
}

export function currentMonthKey(now = new Date()) {
  return monthKeyOf(now.getUTCFullYear(), now.getUTCMonth() + 1)
}

/** The URL query with the month replaced, keeping every other parameter. */
export function withMonth(search: string, key: string) {
  const params = new URLSearchParams(search)
  params.set("month", key)
  return `?${params.toString()}`
}
