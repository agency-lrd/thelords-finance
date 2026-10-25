"use server"

import { revalidatePath } from "next/cache"

import { authorize } from "@/lib/auth/session"
import { clientReport, listClientCategories, paySalary, payslipsToPay, recordMovement, saveClientCategory, setClientCategoryArchived } from "@/lib/data/cash-register"
import { toActionError, UserInputError } from "@/lib/forms"
import { normalizeNumber } from "@/lib/i18n/format"
import { getLocale } from "@/lib/i18n/server"
import { Decimal } from "@/lib/money"
import { isKind } from "@/lib/transactions/kinds"

/*
 * One entry point for money movements, used by Transactions, Cash Flow and Owners: every screen creates
 * the same single transaction (or salary payment), so a movement is never recorded twice.
 */

export type MovementForm = {
  kind: string
  date: string
  amount: string
  currency: string
  fxRate: string
  fee: string
  financialAccountId: string
  counterFinancialAccountId: string
  departmentId: string
  clientId: string
  clientName: string
  clientCategoryId: string
  projectId: string
  teamId: string
  shareholderId: string
  categoryId: string
  counterparty: string
  description: string
  notes: string
}

type Result = { ok: true; message?: string; posted?: boolean } | { ok: false; message: string }

const RU: [RegExp, string][] = [
  [/Enter the advertiser/, "Укажите рекламодателя (клиента)."],
  [/Choose the owner or investor/, "Выберите собственника или инвестора."],
  [/Choose the destination account/, "Выберите счёт, на который переводятся деньги."],
  [/Choose a category/, "Выберите категорию."],
  [/Choose the company account/, "Выберите счёт или кошелёк компании, через который прошли деньги."],
  [/Amount must be greater than zero/, "Сумма должна быть больше нуля."],
  [/is closed\. Its records can no longer be changed/, "Месяц закрыт — записи в нём больше не меняются."],
  [/The payment is larger than the outstanding amount/, "Сумма больше остатка к выплате по этому расчёту."],
  [/Add the employee's wallet before recording a payment/, "Сначала укажите кошелёк сотрудника в финансовом листе."],
  [/Choose an approved payslip/, "Выберите утверждённый расчёт сотрудника."],
  [/Enter the (.+)→(.+) rate/, "Укажите курс для этой валюты."],
  [/No (\w+)→(\w+) rate/, "Нет курса валюты на эту дату: укажите курс."],
  [/A client category with this name already exists/, "Такая категория клиентов уже есть."],
  [/You do not have permission/, "Недостаточно прав для этого действия."],
]

async function fail(error: unknown): Promise<{ ok: false; message: string }> {
  const message = toActionError(error).message ?? "Error"
  if ((await getLocale()) === "ru") for (const [re, text] of RU) if (re.test(message)) return { ok: false, message: text }
  return { ok: false, message }
}

function done(extra: Omit<Extract<Result, { ok: true }>, "ok"> = {}): Result {
  for (const p of ["/transactions", "/", "/pnl", "/cash-flow", "/analytics", "/owners", "/accounts", "/payroll"]) revalidatePath(p)
  return { ok: true, ...extra }
}

const id = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v.trim()) ? v.trim() : null)
const money = (v: string, label: string, optional = false) => {
  const n = normalizeNumber(v ?? "")
  if (n === "" || n === null) {
    if (optional && n === "") return null
    throw new UserInputError(`${label} must be a number.`)
  }
  return new Decimal(n)
}
const day = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? "")) throw new UserInputError("Date: use YYYY-MM-DD.")
  return new Date(`${v}T00:00:00Z`)
}
const text = (v: string | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : null)

export async function recordMovementAction(form: MovementForm): Promise<Result> {
  try {
    const user = await authorize("journal:create")
    if (!isKind(form.kind)) throw new UserInputError("Choose the type of movement.")
    const result = await recordMovement(user, {
      kind: form.kind,
      date: day(form.date),
      amount: money(form.amount, "Amount")!,
      currency: ["USD", "USDT", "EUR", "GBP"].includes(form.currency) ? form.currency : "USD",
      fxRate: money(form.fxRate, "Rate", true),
      fee: money(form.fee, "Fee", true),
      financialAccountId: id(form.financialAccountId),
      counterFinancialAccountId: id(form.counterFinancialAccountId),
      departmentId: id(form.departmentId),
      clientId: id(form.clientId),
      clientName: text(form.clientName, 160),
      clientCategoryId: id(form.clientCategoryId),
      projectId: id(form.projectId),
      teamId: id(form.teamId),
      shareholderId: id(form.shareholderId),
      categoryId: id(form.categoryId),
      counterparty: text(form.counterparty, 200),
      description: text(form.description, 300),
      notes: text(form.notes, 2000),
    })
    return done({ posted: result.posted, message: String(result.number) })
  } catch (error) {
    return fail(error)
  }
}

export async function payslipsToPayAction() {
  try {
    return { ok: true as const, payslips: await payslipsToPay(await authorize("payroll:read")) }
  } catch (error) {
    return fail(error)
  }
}

export async function paySalaryAction(input: { payrollItemId: string; amount: string; currency: string; fxRate: string; fee: string; financialAccountId: string; date: string; reference: string }): Promise<Result> {
  try {
    const user = await authorize("payroll:pay")
    const itemId = id(input.payrollItemId)
    const accountId = id(input.financialAccountId)
    if (!itemId) throw new UserInputError("Choose an approved payslip.")
    if (!accountId) throw new UserInputError("Choose the company account the money was paid from.")
    await paySalary(user, {
      payrollItemId: itemId,
      amount: money(input.amount, "Amount")!,
      currency: ["USD", "USDT", "EUR", "GBP"].includes(input.currency) ? input.currency : "USD",
      fxRate: money(input.fxRate, "Rate", true),
      fee: money(input.fee, "Fee", true),
      financialAccountId: accountId,
      paidAt: day(input.date),
      reference: text(input.reference, 200),
    })
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function clientCategoriesAction() {
  try {
    const rows = await listClientCategories(await authorize("client:read"))
    return { ok: true as const, categories: rows.map((c) => ({ id: c.id, name: c.name, archived: !!c.archivedAt })) }
  } catch (error) {
    return fail(error)
  }
}

export async function saveClientCategoryAction(categoryId: string | null, name: string): Promise<Result> {
  try {
    await saveClientCategory(await authorize("client:read"), { id: id(categoryId ?? undefined), name })
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function archiveClientCategoryAction(categoryId: string, archived: boolean): Promise<Result> {
  try {
    const cid = id(categoryId)
    if (!cid) throw new UserInputError("Category not found.")
    await setClientCategoryArchived(await authorize("client:read"), cid, archived)
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function clientReportAction(from: string, to: string) {
  try {
    return { ok: true as const, report: await clientReport(await authorize("reports:read"), day(from), day(to)) }
  } catch (error) {
    return fail(error)
  }
}
