/** Reporting periods: month, quarter or year, with the previous period and the same period a year ago. Pure. */
export type PeriodKind = "month" | "quarter" | "year"

export type Range = { kind: PeriodKind; year: number; index: number; from: Date; to: Date; key: string }

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

/** index: month 1-12, quarter 1-4, year ignored (1). */
export function range(kind: PeriodKind, year: number, index = 1): Range {
  if (kind === "month") return { kind, year, index, from: utc(year, index, 1), to: utc(year, index + 1, 0), key: `${year}-${String(index).padStart(2, "0")}` }
  if (kind === "quarter") return { kind, year, index, from: utc(year, (index - 1) * 3 + 1, 1), to: utc(year, index * 3 + 1, 0), key: `${year}-Q${index}` }
  return { kind, year, index: 1, from: utc(year, 1, 1), to: utc(year, 12, 31), key: `${year}` }
}

export function previous(r: Range): Range {
  if (r.kind === "year") return range("year", r.year - 1)
  const count = r.kind === "month" ? 12 : 4
  return r.index > 1 ? range(r.kind, r.year, r.index - 1) : range(r.kind, r.year - 1, count)
}

export function yearAgo(r: Range): Range {
  return range(r.kind, r.year - 1, r.index)
}

/** Parses "2026-05", "2026-Q2" or "2026"; falls back to the given default. */
export function parseRange(value: string | null | undefined, fallback: Range): Range {
  const v = value ?? ""
  let m = /^(\d{4})-(\d{2})$/.exec(v)
  if (m && +m[2] >= 1 && +m[2] <= 12) return range("month", +m[1], +m[2])
  m = /^(\d{4})-Q([1-4])$/.exec(v)
  if (m) return range("quarter", +m[1], +m[2])
  m = /^(\d{4})$/.exec(v)
  if (m) return range("year", +m[1])
  return fallback
}

export function currentRange(kind: PeriodKind, now = new Date()): Range {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  return kind === "month" ? range("month", year, month) : kind === "quarter" ? range("quarter", year, Math.ceil(month / 3)) : range("year", year)
}

/** Months (1-12) of a year, as month ranges. */
export function monthsOf(year: number) {
  return Array.from({ length: 12 }, (_, i) => range("month", year, i + 1))
}

export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

/** Label like "Май 2026", "Q2 2026", "2026". */
export function rangeLabel(r: Range, locale: "ru" | "en") {
  if (r.kind === "year") return String(r.year)
  if (r.kind === "quarter") return `Q${r.index} ${r.year}`
  const text = r.from.toLocaleString(locale === "ru" ? "ru-RU" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  return text.charAt(0).toUpperCase() + text.slice(1).replace(" г.", "")
}
