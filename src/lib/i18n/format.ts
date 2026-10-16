/** Locale-aware money formatting and lenient number parsing. Pure; safe in client components. */
export type Locale = "ru" | "en"

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" }

/** "$1 200,00" (ru) / "$1,200.00" (en); USDT and unknown codes as a suffix. Input is a decimal string. */
export function formatAmount(value: string | null | undefined, currency: string, locale: Locale, { decimals = 2, blankZero = false } = {}) {
  if (value === null || value === undefined || value === "") return "—"
  const negative = value.trim().startsWith("-")
  const [whole, fraction = ""] = value.replace("-", "").split(".")
  // Round half-up on the decimal string itself (no floating point).
  let digits = (whole || "0") + (fraction + "0".repeat(decimals)).slice(0, decimals)
  if (Number(fraction[decimals] ?? "0") >= 5) digits = increment(digits)
  const intPart = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "") || "0"
  const decPart = digits.slice(digits.length - decimals)
  if (blankZero && /^0+$/.test(intPart + decPart)) return "—"
  const group = locale === "ru" ? " " : ","
  const point = locale === "ru" ? "," : "."
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  const number = decimals ? `${grouped}${point}${decPart}` : grouped
  const symbol = SYMBOL[currency]
  const body = symbol ? `${symbol}${number}` : `${number} ${currency}`
  return negative && !/^0+$/.test(intPart + decPart) ? `−${body}` : body
}

function increment(digits: string) {
  const chars = digits.split("")
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] === "9") chars[i] = "0"
    else {
      chars[i] = String(Number(chars[i]) + 1)
      return chars.join("")
    }
  }
  return "1" + chars.join("")
}

/**
 * Accepts what people paste from spreadsheets: "$1 200,00", "1,200.50", "1200,5", "-300", "4 000 USDT".
 * Returns a plain decimal string ("1200.00"), "" for empty input, or null when it is not a number.
 */
export function normalizeNumber(raw: string): string | null {
  let value = raw.replace(/[\s  $€£]|USDT|USD|EUR|GBP/gi, "").replace(/^−/, "-")
  if (!value) return ""
  const lastDot = value.lastIndexOf(".")
  const lastComma = value.lastIndexOf(",")
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ","
    const thousands = decimal === "." ? "," : "."
    value = value.split(thousands).join("").replace(decimal, ".")
  } else if (lastComma >= 0) {
    const after = value.length - lastComma - 1
    value = value.split(",").length === 2 && after > 0 && after <= 2 ? value.replace(",", ".") : value.split(",").join("")
  }
  return /^-?\d+(\.\d+)?$/.test(value) ? value : null
}

export function formatDate(iso: string | null | undefined, locale: Locale) {
  if (!iso) return "—"
  const [y, m, d] = iso.slice(0, 10).split("-")
  return locale === "ru" ? `${d}.${m}.${y.slice(2)}` : `${m}/${d}/${y.slice(2)}`
}

export function monthName(year: number, month: number, locale: Locale) {
  const text = new Date(Date.UTC(year, month - 1, 1)).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  return text.charAt(0).toUpperCase() + text.slice(1).replace(" г.", "")
}
