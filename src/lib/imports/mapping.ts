/**
 * Column mapping for the transaction import: known header names (RU/EN, common bank exports) and the
 * header-row detection. No server dependencies: used by the import wizard and the server.
 */
import type { ImportField, ImportSettings } from "./fields"

const SYNONYMS: Record<ImportField, string[]> = {
  date: ["date", "дата", "дата операции", "transaction date", "posting date", "value date", "booking date", "дата платежа", "дата проводки"],
  description: ["description", "описание", "назначение", "назначение платежа", "details", "memo", "статья", "item", "наименование"],
  amount: ["amount", "сумма", "sum", "сумма операции", "value", "total", "итого"],
  currency: ["currency", "валюта", "ccy", "cur"],
  type: ["type", "тип", "тип операции", "вид операции", "вид"],
  department: ["department", "отдел", "подразделение"],
  category: ["category", "категория", "статья учета", "статья учёта"],
  client: ["client", "клиент", "customer", "заказчик"],
  project: ["project", "проект"],
  account: ["account", "счёт", "счет", "кошелёк", "кошелек", "wallet", "bank account", "банковский счёт", "банковский счет"],
  notes: ["notes", "note", "comment", "комментарий", "примечание"],
  counterparty: ["counterparty", "контрагент", "payee", "payer", "получатель", "плательщик"],
  counterAccount: ["to account", "на счёт", "на счет", "счёт получателя", "счет получателя"],
  fxRate: ["rate", "fx rate", "курс", "exchange rate"],
  paymentStatus: ["status", "payment status", "оплата", "статус оплаты", "статус"],
  dueDate: ["due date", "срок", "срок оплаты", "due"],
}

export const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е").replace(/[\s_]+/g, " ").replace(/[.:*]+$/, "")

function fieldFor(header: string): ImportField | null {
  const h = norm(header)
  if (!h) return null
  for (const [field, words] of Object.entries(SYNONYMS) as [ImportField, string[]][]) if (words.some((w) => norm(w) === h)) return field
  return null
}

/** The header row: the first of the first 10 rows where at least two cells are known column names. */
export function detectHeaderRow(rows: string[][]) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) if (rows[i].filter((c) => fieldFor(c)).length >= 2) return i
  return 0
}

/** Column suggestions from the header names (each column used once). */
export function suggestMapping(header: string[]): Partial<Record<ImportField, number>> {
  const mapping: Partial<Record<ImportField, number>> = {}
  header.forEach((h, i) => {
    const f = fieldFor(h)
    if (f && mapping[f] === undefined) mapping[f] = i
  })
  return mapping
}

export function defaultSettings(rows: string[][]): ImportSettings {
  const headerRow = detectHeaderRow(rows)
  return { headerRow, mapping: suggestMapping(rows[headerRow] ?? []), dateFormat: "auto", decimal: "auto", defaults: { type: null, currency: null, account: null, category: null } }
}

