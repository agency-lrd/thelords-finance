import { Prisma } from "@/generated/prisma/client"

import { UserInputError } from "./forms"

export type Decimal = Prisma.Decimal
export const Decimal = Prisma.Decimal

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "USDT"] as const

const AMOUNT = /^\d{1,16}(\.\d{1,8})?$/

/** Parses a user-entered amount exactly (no floating point). Accepts "1,234.56". */
export function parseAmount(raw: FormDataEntryValue | null, field: string, { allowZero = false } = {}): Decimal {
  const value = String(raw ?? "").trim().replace(/,/g, "")
  if (!AMOUNT.test(value)) throw new UserInputError(`${field} must be a number with at most 8 decimals.`)
  const amount = new Decimal(value)
  if (amount.isZero() && !allowZero) throw new UserInputError(`${field} must be greater than zero.`)
  return amount
}

/** Converts to the base currency, rounded to 8 decimals (the column precision). */
export function toBase(amount: Decimal, fxRate: Decimal): Decimal {
  return amount.mul(fxRate).toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
}

export function sum(values: Iterable<Decimal>): Decimal {
  let total = new Decimal(0)
  for (const value of values) total = total.add(value)
  return total
}

/** Display formatting. Values arrive as Decimal or decimal strings, never floats. */
export function formatMoney(value: Decimal | string | null | undefined, currency: string) {
  if (value === null || value === undefined) return "—"
  const decimal = new Decimal(value)
  const digits = currency === "USDT" ? 2 : 2
  const fixed = decimal.toFixed(digits, Decimal.ROUND_HALF_UP)
  const [whole, fraction] = fixed.split(".")
  const negative = whole.startsWith("-")
  const grouped = (negative ? whole.slice(1) : whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const symbol = { USD: "$", EUR: "€", GBP: "£" }[currency]
  const body = symbol ? `${symbol}${grouped}.${fraction}` : `${grouped}.${fraction} ${currency}`
  return negative ? `−${body}` : body
}

export function formatPercent(value: Decimal | null) {
  if (value === null) return "—"
  return `${value.mul(100).toFixed(1)}%`
}
