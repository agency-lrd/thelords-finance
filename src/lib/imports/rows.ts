/**
 * Transaction import rows: header detection, column-mapping suggestions, date and amount parsing, and
 * validation of every row against the same rules as the transaction service (types, accounts,
 * categories, open periods, exchange rates). Pure: the server passes in the reference data.
 *
 * Accounting safety: rows only ever become drafts; the type is never guessed from the sign of the
 * amount, so transfers, owner money and loans cannot be turned into revenue by an import.
 */
import { createHash } from "node:crypto"

import Decimal from "decimal.js"

import { transactionTexts } from "@/lib/i18n/transactions"

import { norm } from "./mapping"
import { WARNING_CODES, type DateFormat, type ImportField, type ImportSettings, type ImportSummary, type Issue, type RowCheck } from "./fields"

// ─── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
}

const iso = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

/** DMY or MDY for a file where dates look like 01/02/2026: decided from the rows that are unambiguous. */
export function detectDateOrder(values: string[]): "DMY" | "MDY" {
  let dmy = 0
  let mdy = 0
  for (const v of values) {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(v.trim())
    if (!m) continue
    if (Number(m[1]) > 12) dmy++
    else if (Number(m[2]) > 12) mdy++
  }
  return mdy > dmy ? "MDY" : "DMY"
}

/** Parses a date cell: ISO, d.m.y / m/d/y, y/m/d, "15 Jan 2026", "15 янв 2026", or an Excel serial number. */
export function parseImportDate(raw: string, format: Exclude<DateFormat, "auto">): string | null {
  const v = raw.trim()
  if (!v) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(v)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /^(\d{4})[./](\d{1,2})[./](\d{1,2})(?:\s.*)?$/.exec(v)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:\s.*)?$/.exec(v)
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    if (format === "YMD") return null
    return format === "MDY" ? iso(year, +m[1], +m[2]) : iso(year, +m[2], +m[1])
  }
  m = /^(\d{1,2})\s+([a-zа-яё]{3,})\.?\s+(\d{4})/i.exec(v)
  if (m) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)]
    return month ? iso(+m[3], month, +m[1]) : null
  }
  // Excel stores dates as days since 1899-12-30 (a fraction is the time of day).
  m = /^(\d{4,6})(?:\.\d+)?$/.exec(v)
  if (m && +m[1] > 20000 && +m[1] < 80000) return new Date(Date.UTC(1899, 11, 30) + +m[1] * 86_400_000).toISOString().slice(0, 10)
  return null
}

// ─── Amounts ─────────────────────────────────────────────────────────────────

/** Which character is the decimal separator in a file, from amounts that show it unambiguously. */
export function detectDecimal(values: string[]): "." | "," {
  let comma = 0
  let dot = 0
  for (const raw of values) {
    const v = raw.replace(/[\s  ']/g, "")
    if (/,\d{1,2}\)?-?$/.test(v) || /\d\.\d{3},/.test(v)) comma++
    else if (/\.\d{1,2}\)?-?$/.test(v) || /\d,\d{3}\./.test(v)) dot++
  }
  return comma > dot ? "," : "."
}

/** Parses an amount cell: thousands separators, currency signs, minus, (negative) and trailing minus. */
export function parseImportAmount(raw: string, decimal: "." | ","): { value: Decimal; negative: boolean } | null {
  let v = raw.trim()
  if (!v) return null
  let negative = false
  if (/^\(.*\)$/.test(v)) {
    negative = true
    v = v.slice(1, -1)
  }
  // Spaces and apostrophes group thousands; letters and currency signs (USD, руб., $, €) are dropped.
  v = v.replace(/[\s\u00a0\u202f']/g, "").replace(/[A-Za-zА-Яа-яЁё$€£₽₸₴]/g, "").replace(/[.,]$/, "")
  if (/^[−–-]/.test(v)) {
    negative = !negative
    v = v.slice(1)
  } else if (v.startsWith("+")) v = v.slice(1)
  if (/[−–-]$/.test(v)) {
    negative = !negative
    v = v.slice(0, -1)
  }
  const thousands = decimal === "," ? "." : ","
  v = v.split(thousands).join("")
  if (decimal === ",") v = v.replace(",", ".")
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  const value = new Decimal(v)
  if (value.decimalPlaces() > 8 || value.gte("1e15")) return null
  return { value, negative }
}

// ─── Validation ──────────────────────────────────────────────────────────────

type Named = { id: string; name: string }
export type Lookups = {
  baseCurrency: string
  currencies: string[]
  accounts: (Named & { currency: string })[]
  categories: (Named & { kind: string; code: string })[]
  departments: Named[]
  clients: Named[]
  projects: Named[]
  owners: Named[]
  /** Months ("YYYY-MM") that are closed or locked. */
  closedMonths: Set<string>
  /** "CUR|YYYY-MM" pairs that have an exchange rate to the base currency. */
  fxMonths: Set<string>
  /** Import keys already used by existing transactions. */
  existingKeys: Set<string>
  /** "date|type|amount|currency" of existing transactions, for possible-duplicate warnings. */
  existingFingerprints: Set<string>
}

export type NormalizedRow = {
  type: string
  date: string
  description: string
  amount: string
  currency: string
  fxRate: string | null
  financialAccountId: string | null
  counterFinancialAccountId: string | null
  categoryId: string | null
  departmentId: string | null
  clientId: string | null
  projectId: string | null
  shareholderId: string | null
  counterparty: string | null
  settlementStatus: "PAID" | "UNPAID"
  dueDate: string | null
  notes: string | null
  key: string
}

export type ValidatedRow = RowCheck & { input: NormalizedRow | null; key: string | null }

const TYPES = Object.keys(transactionTexts.ru.types)
const TYPE_SYNONYMS: Record<string, string> = {
  доход: "REVENUE", выручка: "REVENUE", income: "REVENUE", revenue: "REVENUE",
  расход: "OPERATING_EXPENSE", expense: "OPERATING_EXPENSE", затраты: "OPERATING_EXPENSE",
  зп: "PAYROLL", зарплата: "PAYROLL", salary: "PAYROLL", payroll: "PAYROLL",
  перевод: "INTERNAL_TRANSFER", transfer: "INTERNAL_TRANSFER",
  налог: "TAX_PAYMENT", tax: "TAX_PAYMENT",
  займ: "LOAN_RECEIVED", заём: "LOAN_RECEIVED", loan: "LOAN_RECEIVED",
  "взнос собственника": "OWNER_CONTRIBUTION", "изъятие собственника": "OWNER_WITHDRAWAL",
}
/** Types that need details an import file cannot carry reliably: entered on the form instead. */
const MANUAL_ONLY = ["REFUND", "ADJUSTMENT"]
const SETTLEABLE = ["REVENUE", "OPERATING_EXPENSE", "ASSET_PURCHASE"]
const REVENUE_KINDS = ["REVENUE", "OTHER_INCOME"]
const EXPENSE_KINDS = ["COST_OF_SALES", "OPERATING_EXPENSE", "OTHER_EXPENSE", "DEPRECIATION", "AMORTIZATION", "INTEREST"]
const UNPAID = ["unpaid", "не оплачено", "неоплачено", "не оплачен", "no", "нет", "false", "0"]
const INCOME_TYPES = ["REVENUE"]
const EXPENSE_TYPES = ["OPERATING_EXPENSE", "PAYROLL", "TAX_PAYMENT", "ASSET_PURCHASE"]

export function parseType(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  const exact = TYPES.find((t) => t.toLowerCase() === v.replace(/\s+/g, "_"))
  if (exact) return exact
  for (const locale of ["ru", "en"] as const) {
    const hit = Object.entries(transactionTexts[locale].types).find(([, label]) => label.toLowerCase() === v)
    if (hit) return hit[0]
  }
  return TYPE_SYNONYMS[v] ?? null
}

function find<T extends Named>(list: T[], raw: string, extra?: (x: T) => string[]): T | null {
  const v = norm(raw)
  if (!v) return null
  return list.find((x) => norm(x.name) === v || norm(x.name).endsWith(`› ${v}`) || (extra?.(x) ?? []).some((e) => norm(e) === v)) ?? null
}

/** Stable key of a row: the same row imported again gets the same key and is skipped. */
export function rowKey(parts: (string | null | undefined)[], occurrence: number) {
  const base = parts.map((p) => (p ?? "").trim().toLowerCase())
  if (occurrence > 1) base.push(`#${occurrence}`)
  return createHash("sha256").update(base.join("|")).digest("hex").slice(0, 32)
}

const FORMULA = /^[=+@]|^-[^\d\s.,]/

/**
 * Validates the data rows under the header. Each row gets its issues (errors and warnings, with codes
 * the interface translates), a suggested inclusion and, when valid, the normalized input for a draft.
 */
export function validateRows(rows: string[][], settings: ImportSettings, lookups: Lookups): ValidatedRow[] {
  const map = settings.mapping
  const col = (row: string[], f: ImportField) => (map[f] === undefined || map[f] === null ? "" : (row[map[f]!] ?? "").trim())
  const data = rows.map((r, i) => ({ row: i + 1, cells: r })).slice(settings.headerRow + 1)
  const order = settings.dateFormat === "auto" ? detectDateOrder(data.map((d) => col(d.cells, "date"))) : settings.dateFormat
  const decimal = settings.decimal === "auto" ? detectDecimal(data.flatMap((d) => [col(d.cells, "amount"), col(d.cells, "fxRate")])) : settings.decimal
  const defaults = settings.defaults
  const seen = new Map<string, number>()
  const out: ValidatedRow[] = []

  for (const { row, cells } of data) {
    if (cells.every((c) => !c?.trim())) continue
    const issues: Issue[] = []
    const err = (code: Issue["code"], field?: ImportField, value?: string) => issues.push({ code, ...(field ? { field } : {}), ...(value ? { value: value.slice(0, 80) } : {}) })

    // Date
    const rawDate = col(cells, "date")
    const date = rawDate ? parseImportDate(rawDate, order) : null
    if (!rawDate) err("date_required", "date")
    else if (!date) err("date_invalid", "date", rawDate)
    else if (+date.slice(0, 4) < 2000 || +date.slice(0, 4) > 2100) err("date_out_of_range", "date", rawDate)
    else if (lookups.closedMonths.has(date.slice(0, 7))) err("period_closed", "date", date.slice(0, 7))

    // Amount
    const rawAmount = col(cells, "amount")
    const amount = rawAmount ? parseImportAmount(rawAmount, decimal) : null
    if (!rawAmount) err("amount_required", "amount")
    else if (!amount) err("amount_invalid", "amount", rawAmount)
    else if (amount.value.isZero()) err("amount_zero", "amount")

    // Type: from the cell or the explicit default; never inferred from the sign.
    const rawType = col(cells, "type")
    const type = rawType ? parseType(rawType) : defaults.type && TYPES.includes(defaults.type) ? defaults.type : null
    if (!rawType && !type) err("type_required", "type")
    else if (!type) err("type_unknown", "type", rawType)
    else if (MANUAL_ONLY.includes(type)) err("type_manual_only", "type", rawType || type)
    if (amount?.negative && type && (INCOME_TYPES.includes(type) || EXPENSE_TYPES.includes(type))) err("negative_amount", "amount", rawAmount)

    // Description (falls back to the counterparty)
    const counterparty = col(cells, "counterparty")
    let description = col(cells, "description") || counterparty
    if (!description) err("description_required", "description")
    else if (description.length > 300) {
      description = description.slice(0, 300)
      err("description_truncated", "description")
    }
    const notes = col(cells, "notes")
    if (FORMULA.test(description) || FORMULA.test(notes)) err("formula_text", FORMULA.test(description) ? "description" : "notes")

    // Accounts and payment status
    const rawAccount = col(cells, "account") || defaults.account || ""
    const account = rawAccount ? find(lookups.accounts, rawAccount, (a) => [a.id]) : null
    if (rawAccount && !account) err("account_not_found", "account", rawAccount)
    const unpaid = UNPAID.includes(col(cells, "paymentStatus").toLowerCase())
    if (unpaid && type && !SETTLEABLE.includes(type)) err("unpaid_not_allowed", "paymentStatus")
    if (!rawAccount && type && !unpaid && type !== "ADJUSTMENT") err("account_required", "account")
    let counter: Named | null = null
    if (type === "INTERNAL_TRANSFER") {
      const rawCounter = col(cells, "counterAccount")
      counter = rawCounter ? find(lookups.accounts, rawCounter) : null
      if (!rawCounter) err("counter_account_required", "counterAccount")
      else if (!counter) err("counter_account_not_found", "counterAccount", rawCounter)
      else if (counter.id === account?.id) err("same_accounts", "counterAccount")
    }

    // Currency and exchange rate
    const currency = (col(cells, "currency") || defaults.currency || (account as { currency?: string } | null)?.currency || lookups.baseCurrency).toUpperCase()
    if (!lookups.currencies.includes(currency)) err("currency_unknown", "currency", currency)
    const rawRate = col(cells, "fxRate")
    const rate = rawRate ? parseImportAmount(rawRate, decimal) : null
    if (date && currency !== lookups.baseCurrency && lookups.currencies.includes(currency) && !rate && !lookups.fxMonths.has(`${currency}|${date.slice(0, 7)}`)) err("fx_missing", "currency", `${currency} ${date.slice(0, 7)}`)

    // Category
    const rawCategory = col(cells, "category") || defaults.category || ""
    const category = rawCategory ? find(lookups.categories, rawCategory, (c) => [c.code, c.id]) : null
    if (rawCategory && !category) err("category_not_found", "category", rawCategory)
    if (type === "REVENUE" || type === "OPERATING_EXPENSE") {
      if (!rawCategory) err("category_required", "category")
      else if (category && !(type === "REVENUE" ? REVENUE_KINDS : EXPENSE_KINDS).includes(category.kind)) err("category_kind", "category", category.name)
      else if (category && type === "OPERATING_EXPENSE" && ["DELIVERY-PAYROLL", "OVERHEAD-PAYROLL"].includes(category.code)) err("category_payroll", "category", category.name)
    }

    // Dimensions
    const dimension = <T extends Named>(field: ImportField, list: T[], code: Issue["code"]) => {
      const raw = col(cells, field)
      if (!raw) return null
      const hit = find(list, raw)
      if (!hit) err(code, field, raw)
      return hit
    }
    const department = dimension("department", lookups.departments, "department_not_found")
    const client = dimension("client", lookups.clients, "client_not_found")
    const project = dimension("project", lookups.projects, "project_not_found")
    let owner: Named | null = null
    if (type === "OWNER_CONTRIBUTION" || type === "OWNER_WITHDRAWAL") {
      owner = find(lookups.owners, counterparty)
      if (!owner) err("owner_not_found", "counterparty", counterparty)
    }
    const rawDue = col(cells, "dueDate")
    const due = rawDue ? parseImportDate(rawDue, order) : null
    if (rawDue && !due) err("due_date_invalid", "dueDate", rawDue)

    // Duplicates
    let key: string | null = null
    let duplicate = false
    if (date && amount && type) {
      const parts = [date, type, description, amount.value.toString(), currency, account?.id ?? "", counterparty]
      const base = parts.join("|").toLowerCase()
      const occurrence = (seen.get(base) ?? 0) + 1
      seen.set(base, occurrence)
      key = rowKey(parts, 1)
      if (occurrence > 1) {
        err("duplicate_in_file")
        duplicate = true
        key = rowKey(parts, occurrence)
      }
      if (lookups.existingKeys.has(key)) {
        err("already_imported")
        duplicate = true
      } else if (!duplicate && lookups.existingFingerprints.has(`${date}|${type}|${amount.value.toString()}|${currency}`)) err("possible_duplicate")
    }

    const errors = issues.filter((i) => !WARNING_CODES.includes(i.code) && i.code !== "duplicate_in_file" && i.code !== "already_imported")
    const status: RowCheck["status"] = errors.length ? "error" : duplicate ? "duplicate" : issues.length ? "warning" : "ok"
    const valid = errors.length === 0 && date && amount && type && key
    out.push({
      row,
      status,
      include: status === "ok" || status === "warning",
      issues,
      key,
      preview: date && amount
        ? { date, description, amount: amount.value.toString(), currency, type: type ?? "", account: account?.name ?? null, category: category?.name ?? null, department: department?.name ?? null, client: client?.name ?? null, project: project?.name ?? null }
        : null,
      input: valid
        ? {
            type: type!,
            date: date!,
            description,
            amount: amount!.value.toString(),
            currency,
            fxRate: rate ? rate.value.toString() : null,
            financialAccountId: account?.id ?? null,
            counterFinancialAccountId: counter?.id ?? null,
            categoryId: category?.id ?? null,
            departmentId: department?.id ?? null,
            clientId: client?.id ?? null,
            projectId: project?.id ?? null,
            shareholderId: owner?.id ?? null,
            counterparty: counterparty || null,
            settlementStatus: unpaid ? "UNPAID" : "PAID",
            dueDate: due,
            notes: notes || null,
            key: key!,
          }
        : null,
    })
  }
  return out
}

/** Counts and totals of the rows that would be imported (included and valid). */
export function summarize(rows: ValidatedRow[], included: (r: ValidatedRow) => boolean): ImportSummary {
  const totals = new Map<string, { income: Decimal; expense: Decimal; other: Decimal; count: number }>()
  for (const r of rows) {
    if (!r.input || !included(r)) continue
    const t = totals.get(r.input.currency) ?? { income: new Decimal(0), expense: new Decimal(0), other: new Decimal(0), count: 0 }
    const bucket = INCOME_TYPES.includes(r.input.type) ? "income" : EXPENSE_TYPES.includes(r.input.type) ? "expense" : "other"
    t[bucket] = t[bucket].add(r.input.amount)
    t.count++
    totals.set(r.input.currency, t)
  }
  return {
    rows: rows.length,
    valid: rows.filter((r) => r.status === "ok" || r.status === "warning").length,
    warnings: rows.filter((r) => r.status === "warning").length,
    errors: rows.filter((r) => r.status === "error").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    totals: [...totals.entries()].map(([currency, t]) => ({ currency, income: t.income.toString(), expense: t.expense.toString(), other: t.other.toString(), count: t.count })),
  }
}

/** Which fields must be mapped (or defaulted) before rows can be validated. */
export function missingMapping(settings: ImportSettings): ImportField[] {
  const m = settings.mapping
  const has = (f: ImportField) => m[f] !== undefined && m[f] !== null
  const missing: ImportField[] = []
  if (!has("date")) missing.push("date")
  if (!has("amount")) missing.push("amount")
  if (!has("description") && !has("counterparty")) missing.push("description")
  if (!has("type") && !settings.defaults.type) missing.push("type")
  return missing
}
