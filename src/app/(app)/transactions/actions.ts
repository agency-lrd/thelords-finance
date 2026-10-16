"use server"

import { revalidatePath } from "next/cache"

import type { TransactionType } from "@/generated/prisma/client"
import { authorize } from "@/lib/auth/session"
import {
  createTransaction,
  deleteDraft,
  importKey,
  postTransactions,
  reverseTransaction,
  settleTransaction,
  TRANSACTION_TYPES,
  transactionOptions,
  updateDraft,
  type TransactionInput,
} from "@/lib/data/transactions"
import { toActionError, UserInputError } from "@/lib/forms"
import { transactionTexts } from "@/lib/i18n/transactions"
import { normalizeNumber } from "@/lib/i18n/format"
import { Decimal } from "@/lib/money"

export type TransactionForm = {
  type: string
  date: string
  description: string
  amount: string
  currency: string
  fxRate: string
  fee: string
  financialAccountId: string
  counterFinancialAccountId: string
  categoryId: string
  debitAccountId: string
  creditAccountId: string
  departmentId: string
  clientId: string
  projectId: string
  shareholderId: string
  counterparty: string
  direction: string
  settlementStatus: string
  dueDate: string
  notes: string
  attachmentUrl: string
}

type Result = { ok: true; message?: string } | { ok: false; message: string }

const date = (v: string, label: string, required = true) => {
  if (!v) {
    if (required) throw new UserInputError(`${label} is required.`)
    return null
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UserInputError(`${label}: use YYYY-MM-DD.`)
  return new Date(`${v}T00:00:00Z`)
}

const amount = (v: string, label: string, optional = false) => {
  const n = normalizeNumber(v ?? "")
  if (n === "" || n === null) {
    if (optional && n === "") return null
    throw new UserInputError(`${label} must be a number.`)
  }
  return new Decimal(n)
}

function parse(form: TransactionForm): TransactionInput {
  if (!TRANSACTION_TYPES.includes(form.type as TransactionType)) throw new UserInputError("Choose a transaction type.")
  const id = (v: string) => (v?.trim() ? v.trim() : null)
  return {
    type: form.type as TransactionType,
    date: date(form.date, "Date")!,
    description: form.description ?? "",
    amount: amount(form.amount, "Amount")!,
    currency: form.currency || "USD",
    fxRate: amount(form.fxRate, "Rate", true),
    fee: amount(form.fee, "Fee", true),
    financialAccountId: id(form.financialAccountId),
    counterFinancialAccountId: id(form.counterFinancialAccountId),
    categoryId: id(form.categoryId),
    debitAccountId: id(form.debitAccountId),
    creditAccountId: id(form.creditAccountId),
    departmentId: id(form.departmentId),
    clientId: id(form.clientId),
    projectId: id(form.projectId),
    shareholderId: id(form.shareholderId),
    counterparty: form.counterparty?.trim() || null,
    direction: form.direction === "IN" || form.direction === "OUT" ? form.direction : null,
    settlementStatus: form.settlementStatus === "UNPAID" ? "UNPAID" : "PAID",
    dueDate: date(form.dueDate, "Due date", false),
    notes: form.notes?.trim() || null,
    attachmentUrl: form.attachmentUrl?.trim() || null,
  }
}

function done(message?: string): Result {
  for (const p of ["/transactions", "/", "/pnl", "/cash-flow", "/balance-sheet", "/analytics", "/accounts"]) revalidatePath(p)
  return { ok: true, message }
}

const fail = (error: unknown): Result => ({ ok: false, message: toActionError(error).message ?? "Error" })

export async function saveTransactionAction(id: string | null, form: TransactionForm, post: boolean): Promise<Result> {
  try {
    const user = await authorize(post ? "journal:post" : "journal:create")
    const input = parse(form)
    if (id) {
      await updateDraft(user, id, input)
      if (post) await postTransactions(user, [id])
    } else {
      await createTransaction(user, input, { post })
    }
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function deleteDraftAction(id: string): Promise<Result> {
  try {
    await deleteDraft(await authorize("journal:create"), id)
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function postAction(ids: string[]): Promise<Result> {
  try {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new UserInputError("Select drafts to post.")
    const n = await postTransactions(await authorize("journal:post"), ids)
    return done(String(n))
  } catch (error) {
    return fail(error)
  }
}

export async function reverseAction(id: string, reason: string): Promise<Result> {
  try {
    await reverseTransaction(await authorize("journal:post"), id, reason.trim().slice(0, 200))
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function settleAction(id: string, input: { amount: string; financialAccountId: string; date: string }): Promise<Result> {
  try {
    await settleTransaction(await authorize("journal:post"), id, { amount: amount(input.amount, "Amount", true), financialAccountId: input.financialAccountId, date: date(input.date, "Date")! })
    return done()
  } catch (error) {
    return fail(error)
  }
}

// ── Bulk entry and import ──

const HEADERS: Record<string, keyof TransactionForm> = {
  date: "date", дата: "date",
  type: "type", тип: "type",
  description: "description", описание: "description", item: "description", статья: "description",
  amount: "amount", сумма: "amount", sum: "amount",
  currency: "currency", валюта: "currency",
  account: "financialAccountId", счёт: "financialAccountId", счет: "financialAccountId",
  category: "categoryId", категория: "categoryId",
  department: "departmentId", отдел: "departmentId",
  counterparty: "counterparty", контрагент: "counterparty",
  client: "clientId", клиент: "clientId",
  comment: "notes", комментарий: "notes", notes: "notes",
  status: "settlementStatus", оплата: "settlementStatus", "payment status": "settlementStatus",
  "due date": "dueDate", срок: "dueDate",
}

const TYPE_SYNONYMS: Record<string, TransactionType> = {
  доход: "REVENUE", income: "REVENUE", расход: "OPERATING_EXPENSE", expense: "OPERATING_EXPENSE", зп: "PAYROLL", salary: "PAYROLL",
  перевод: "INTERNAL_TRANSFER", transfer: "INTERNAL_TRANSFER", налог: "TAX_PAYMENT", tax: "TAX_PAYMENT", займ: "LOAN_RECEIVED", loan: "LOAN_RECEIVED",
}

function parseType(raw: string): TransactionType | null {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  const exact = TRANSACTION_TYPES.find((t) => t.toLowerCase() === v.replace(/\s+/g, "_"))
  if (exact) return exact
  for (const locale of ["ru", "en"] as const) {
    const hit = (Object.entries(transactionTexts[locale].types) as [TransactionType, string][]).find(([, label]) => label.toLowerCase() === v)
    if (hit) return hit[0]
  }
  return TYPE_SYNONYMS[v] ?? null
}

function parseDate(raw: string) {
  const v = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(v)
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
  // Excel serial date
  if (/^\d{5}$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Number(v) * 86_400_000).toISOString().slice(0, 10)
  return v
}

/**
 * Creates drafts from table rows (bulk entry, CSV, XLSX). Names are matched to accounts, categories,
 * departments and clients case-insensitively. Each row gets an import key, so the same row imported
 * again is skipped instead of duplicated.
 */
export async function importAction(table: string[][], hasHeader: boolean): Promise<{ ok: true; created: number; skipped: number; errors: string[] } | { ok: false; message: string }> {
  try {
    const user = await authorize("journal:create")
    if (!Array.isArray(table) || table.length === 0) throw new UserInputError("The file is empty.")
    if (table.length > 2001) throw new UserInputError("Import at most 2,000 rows at a time.")
    const options = await transactionOptions(user)
    const header = hasHeader ? table[0].map((h) => HEADERS[h.trim().toLowerCase()] ?? null) : (["date", "type", "description", "amount", "currency", "financialAccountId", "categoryId", "departmentId", "counterparty"] as (keyof TransactionForm)[])
    const rows = hasHeader ? table.slice(1) : table
    const byName = <T extends { id: string; name: string }>(list: T[], name: string) => {
      const n = name.trim().toLowerCase()
      if (!n) return ""
      const hit = list.find((x) => x.name.toLowerCase() === n || x.name.toLowerCase().endsWith(`› ${n}`))
      if (!hit) throw new UserInputError(`"${name}" not found`)
      return hit.id
    }
    let created = 0
    let skipped = 0
    const errors: string[] = []
    for (const [i, row] of rows.entries()) {
      if (!row.some((c) => c?.trim())) continue
      try {
        const get = (key: keyof TransactionForm) => {
          const index = header.indexOf(key)
          return index >= 0 ? (row[index] ?? "").trim() : ""
        }
        const type = parseType(get("type"))
        if (!type) throw new UserInputError(`type "${get("type")}"?`)
        const status = get("settlementStatus").toLowerCase()
        const form: TransactionForm = {
          type,
          date: parseDate(get("date")),
          description: get("description"),
          amount: get("amount").replace(/^-/, ""),
          currency: (get("currency") || "USD").toUpperCase(),
          fxRate: "",
          fee: "",
          financialAccountId: byName(options.accounts, get("financialAccountId")),
          counterFinancialAccountId: "",
          categoryId: byName(options.categories, get("categoryId")),
          debitAccountId: "",
          creditAccountId: "",
          departmentId: byName(options.departments, get("departmentId")),
          clientId: byName(options.clients, get("clientId")),
          projectId: "",
          shareholderId: "",
          counterparty: get("counterparty"),
          direction: "",
          settlementStatus: ["unpaid", "не оплачено", "no", "нет"].includes(status) ? "UNPAID" : "PAID",
          dueDate: get("dueDate") ? parseDate(get("dueDate")) : "",
          notes: get("notes"),
          attachmentUrl: "",
        }
        const input = parse(form)
        const key = importKey([form.date, form.type, form.description, form.amount, form.currency, form.financialAccountId, form.counterparty])
        try {
          await createTransaction(user, { ...input, externalRef: key })
          created++
        } catch (error) {
          if (error instanceof Error && /Unique constraint|duplicate key/.test(error.message)) skipped++
          else throw error
        }
      } catch (error) {
        errors.push(`${hasHeader ? i + 2 : i + 1}: ${error instanceof Error ? (toActionError(error).message ?? error.message) : String(error)}`)
      }
    }
    done()
    return { ok: true, created, skipped, errors: errors.slice(0, 50) }
  } catch (error) {
    return { ok: false, message: toActionError(error).message ?? "Error" }
  }
}
