"use server"

import { revalidatePath } from "next/cache"

import { authorize, getSession } from "@/lib/auth/session"
import { AuthorizationError } from "@/lib/authz/server"
import {
  addSheetEmployee,
  approveMonth,
  compensationHistory,
  recordPayment,
  requiredPermission,
  revealWallet,
  setCompensationRule,
  setEmployeeArchived,
  setRowConfirmed,
  SheetConflictError,
  updateSheetCell,
  approvalPreview,
  carryForwardEmployees,
  carryForwardPreview,
  reopenMonth,
  type CarryForwardItem,
  type ChangeScope,
  type RuleConfig,
  type SheetField,
} from "@/lib/data/sheet"
import {
  createSheetDepartment,
  deleteDepartment,
  deleteEmployee,
  listArchivedEmployees,
  listSheetDepartments,
  mergeDepartments,
  renameDepartment,
  setDepartmentColor,
  setSheetDepartmentArchived,
} from "@/lib/data/sheet-admin"
import { setPeriodStatus, type PeriodAction } from "@/lib/data/periods"
import { addLedgerEntry, deleteLedgerEntry, recordSettlement, setLedgerConfirmed, updateLedgerEntry } from "@/lib/data/project-ledger"
import { toActionError, UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { getLocale } from "@/lib/i18n/server"
import { parseMonth } from "@/lib/period"

export type CellResult = { ok: true; unconfirmed?: boolean } | { ok: false; message: string; conflict?: { current: string } }

const FIELDS: SheetField[] = ["name", "fix", "currency", "kpiTarget", "kpiActual", "bonus", "deduction", "department", "position", "status", "isTeamLead", "notes", "hireDate", "wallet", "fact", "commission"]

function month(key: string) {
  const m = parseMonth(key)
  if (!m) throw new UserInputError("Invalid month.")
  return m
}

async function sessionUser() {
  const session = await getSession()
  if (session.state !== "ok") throw new AuthorizationError("Your session has expired. Sign in again.")
  return session.user
}

function fail(error: unknown): { ok: false; message: string } {
  const state = toActionError(error)
  return { ok: false, message: state.message ?? "Error" }
}

function done<T extends object>(extra?: T) {
  revalidatePath("/payroll")
  revalidatePath("/")
  return { ok: true as const, ...extra }
}

/** expected: the cell value the user saw; a different current value is a conflict (nothing is written). */
export async function updateCellAction(monthKey: string, employeeId: string, field: string, value: string, expected?: string | null, reason?: string | null): Promise<CellResult> {
  try {
    if (!FIELDS.includes(field as SheetField)) throw new UserInputError("Unknown column.")
    const user = await authorize(requiredPermission(field as SheetField))
    if (value.length > 2000 || (expected?.length ?? 0) > 2000 || (reason?.length ?? 0) > 500) throw new UserInputError("Value is too long.")
    const result = await updateSheetCell(user, month(monthKey), employeeId, field as SheetField, value, undefined, typeof expected === "string" ? expected : null, undefined, typeof reason === "string" ? reason : null)
    return done(result)
  } catch (error) {
    if (error instanceof SheetConflictError) return { ok: false, message: error.message, conflict: { current: error.current } }
    return failRu(error)
  }
}

export async function setTermsAction(monthKey: string, employeeId: string, config: RuleConfig): Promise<CellResult> {
  try {
    const user = await authorize("compensation:manage")
    await setCompensationRule(user, month(monthKey), employeeId, config)
    return done()
  } catch (error) {
    return fail(error)
  }
}

// Payroll errors from the data layer, in Russian for the sheet (the data layer reports in English).
const RU: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/You do not have permission to confirm payroll/, "У вашей роли нет права подтверждать расчёт зарплаты (payroll:prepare)."],
  [/You do not have permission to approve payroll/, "У вашей роли нет права утверждать месяц (payroll:approve)."],
  [/^(.+): enter FIX before confirming/, (m) => `${m[1]}: сначала укажите FIX.`],
  [/^(.+): the salary change is waiting for approval/, (m) => `${m[1]}: изменение оклада ждёт утверждения (salary:approve).`],
  [/^(.+): a bonus or deduction is waiting for approval/, (m) => `${m[1]}: бонус или удержание ждёт утверждения.`],
  [/^(.+): deductions exceed earnings/, (m) => `${m[1]}: удержания больше начислений.`],
  [/is approved; its sheet can no longer be changed/, "Месяц уже утверждён — ведомость за него больше не меняется."],
  [/is closed\. Its records can no longer be changed/, "Месяц закрыт — изменения недоступны."],
  [/is under review before closing/, "Месяц на проверке — изменения доступны только ответственным за закрытие."],
  [/^(\d+) row\(s\) are not confirmed or changed after confirmation: (.+)$/, (m) => `Не подтверждено или изменено после подтверждения: ${m[1]} — ${m[2]}.`],
  [/Confirm the rows before approving the month/, "Сначала подтвердите расчёт сотрудников."],
  [/Employee is not on this month's sheet/, "Сотрудника нет в ведомости этого месяца."],
  [/No (\w+)→(\w+) rate for (.+?)\./, (m) => `Нет курса ${m[1]}→${m[2]} на ${m[3]}: добавьте курс, чтобы подтвердить.`],
  [/^Payroll for (.+) is not approved yet/, (m) => `Ведомость за ${m[1]} ещё не утверждена. Сначала утвердите её, затем переносите сотрудников.`],
  [/The employee is not on this month's sheet/, "Сотрудника нет в ведомости этого месяца — перенесите его из предыдущего месяца или добавьте."],
  [/^(?:(.+): )?FACT PAYMENT is below the calculated salary/, (m) => `${m[1] ? `${m[1]}: ` : ""}FACT PAYMENT меньше расчётной суммы — укажите причину корректировки.`],
  [/This employee has special terms/, "У сотрудника особые условия — измените их в «Add Terms»."],
  [/Commission %: "(.+)" is not a number/, (m) => `Комиссия: «${m[1]}» — не число.`],
  [/(.+) cannot exceed 100%/, "Процент не может быть больше 100."],
  [/You do not have permission to cancel a payroll approval/, "Отменить утверждение может только администратор с правами payroll:approve и period:reopen."],
  [/Enter the reason for cancelling the approval/, "Укажите причину отмены утверждения."],
  [/^(.+) is not approved\.$/, (m) => `${m[1]} не утверждён.`],
  [/Salary payments are already recorded for (.+)\. Approval/, (m) => `За ${m[1]} уже записаны выплаты зарплаты. Отменить утверждение можно только до первой выплаты: сначала сторнируйте выплаты.`],
  [/This cell was changed by someone else/, "Ячейку уже изменил кто-то другой. Данные обновлены — проверьте новое значение и повторите."],
  [/You do not have permission to edit this column/, "У вашей роли нет права менять эту колонку."],
  [/^(.+): "(.+)" is not a number/, (m) => `${m[1]}: «${m[2]}» — не число.`],
  [/^(.+) cannot be negative/, (m) => `${m[1]}: значение не может быть отрицательным.`],
  [/^(.+): no salary terms for this month/, (m) => `${m[1]}: нет условий оплаты на этот месяц — укажите FIX на странице сотрудника или добавьте его как нового.`],
]
async function failRu(error: unknown) {
  const result = fail(error)
  if ((await getLocale()) !== "ru") return result
  for (const [pattern, text] of RU) {
    const m = pattern.exec(result.message)
    if (m) return { ok: false as const, message: typeof text === "string" ? text : text(m) }
  }
  return result
}

/** Confirms (accepts the month's calculation) or un-confirms one employee. Not a payment. */
export async function confirmRowAction(monthKey: string, employeeId: string, confirmed: boolean): Promise<CellResult> {
  try {
    const user = await authorize("payroll:prepare")
    await setRowConfirmed(user, month(monthKey), employeeId, confirmed === true)
    return done()
  } catch (error) {
    return failRu(error)
  }
}

export async function approveMonthAction(monthKey: string, comment?: string | null): Promise<CellResult> {
  try {
    const user = await authorize("payroll:approve")
    await approveMonth(user, month(monthKey), typeof comment === "string" && comment.trim() ? comment.trim().slice(0, 500) : null)
    revalidatePath("/pnl")
    revalidatePath("/cash-flow")
    return done()
  } catch (error) {
    return failRu(error)
  }
}

/** Cancels the approval of a month (audited, reason required; refused once salaries are paid). */
export async function reopenMonthAction(monthKey: string, reason: string): Promise<CellResult> {
  try {
    const user = await authorize("payroll:approve")
    await reopenMonth(user, month(monthKey), typeof reason === "string" ? reason : "")
    revalidatePath("/pnl")
    revalidatePath("/cash-flow")
    return done()
  } catch (error) {
    return failRu(error)
  }
}

export async function approvalPreviewAction(monthKey: string) {
  try {
    return { ok: true as const, preview: await approvalPreview(await authorize("payroll:read"), month(monthKey)) }
  } catch (error) {
    return failRu(error)
  }
}

export async function carryForwardPreviewAction(monthKey: string) {
  try {
    return { ok: true as const, preview: await carryForwardPreview(await authorize("payroll:read"), month(monthKey)) }
  } catch (error) {
    return failRu(error)
  }
}

export async function carryForwardAction(monthKey: string, items: CarryForwardItem[], addNew: string[] = []) {
  try {
    const user = await authorize("employee:manage")
    const clean = (Array.isArray(items) ? items : []).map((i) => ({
      employeeId: String(i.employeeId),
      fix: typeof i.fix === "string" ? i.fix : null,
      currency: typeof i.currency === "string" ? i.currency : null,
      departmentId: typeof i.departmentId === "string" ? i.departmentId : null,
      kpiTarget: typeof i.kpiTarget === "string" ? i.kpiTarget : null,
      kpiRecurring: i.kpiRecurring === true,
      ratePct: typeof i.ratePct === "string" ? i.ratePct : null,
    }))
    const result = await carryForwardEmployees(user, month(monthKey), clean, undefined, { addNew: (Array.isArray(addNew) ? addNew : []).filter((x) => typeof x === "string") })
    revalidatePath("/employees")
    return { ...done(), result }
  } catch (error) {
    return failRu(error)
  }
}

/** Salary conditions from the "Edit conditions" dialog: FIX, currency and KPI target with a scope. */
export async function editConditionsAction(
  monthKey: string,
  employeeId: string,
  input: { fix: string | null; currency: string | null; kpiTarget: string | null; scope: string; expected: { fix: string; currency: string; kpiTarget: string } },
): Promise<CellResult> {
  try {
    const scope: ChangeScope = input.scope === "month" ? "month" : "future"
    const m = month(monthKey)
    let unconfirmed = false
    if (input.fix !== null && input.fix !== input.expected.fix) {
      unconfirmed = (await updateSheetCell(await authorize("salary:manage"), m, employeeId, "fix", input.fix, undefined, input.expected.fix, scope)).unconfirmed || unconfirmed
    }
    if (input.currency !== null && input.currency !== input.expected.currency) {
      unconfirmed = (await updateSheetCell(await authorize("salary:manage"), m, employeeId, "currency", input.currency, undefined, input.expected.currency, scope)).unconfirmed || unconfirmed
    }
    if (input.kpiTarget !== null && input.kpiTarget !== input.expected.kpiTarget) {
      unconfirmed = (await updateSheetCell(await authorize("kpi:manage"), m, employeeId, "kpiTarget", input.kpiTarget, undefined, input.expected.kpiTarget, scope)).unconfirmed || unconfirmed
    }
    return done({ unconfirmed })
  } catch (error) {
    if (error instanceof SheetConflictError) return { ok: false, message: error.message, conflict: { current: error.current } }
    return failRu(error)
  }
}

export async function addEmployeeAction(
  monthKey: string,
  input: { name: string; departmentId: string; fix: string; currency: string; hireDate: string },
): Promise<CellResult> {
  try {
    const user = await authorize("employee:manage")
    const hireDate = /^\d{4}-\d{2}-\d{2}$/.test(input.hireDate) ? new Date(`${input.hireDate}T00:00:00Z`) : null
    await addSheetEmployee(user, month(monthKey), { ...input, hireDate })
    revalidatePath("/employees")
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function archiveEmployeeAction(employeeId: string, archived: boolean): Promise<CellResult> {
  try {
    const user = await authorize("employee:manage")
    await setEmployeeArchived(user, employeeId, archived)
    revalidatePath("/employees")
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function recordPaymentAction(
  monthKey: string,
  input: { employeeId: string; amount: string; currency: string; fxRate: string; fee: string; financialAccountId: string; paidAt: string; reference: string },
): Promise<CellResult> {
  try {
    const user = await authorize("payroll:pay")
    const num = (raw: string, label: string, optional = false) => {
      const value = raw.trim()
      if (!value && optional) return null
      if (!/^\d{1,16}(\.\d{1,8})?$/.test(value)) throw new UserInputError(`${label} must be a positive number.`)
      return new Decimal(value)
    }
    const amount = num(input.amount, "Amount")!
    if (amount.lte(0)) throw new UserInputError("Amount must be greater than zero.")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidAt)) throw new UserInputError("Choose the payment date.")
    await recordPayment(user, month(monthKey), {
      employeeId: input.employeeId,
      amount,
      currency: input.currency,
      fxRate: num(input.fxRate, "Rate", true),
      fee: num(input.fee, "Fee", true),
      financialAccountId: input.financialAccountId,
      paidAt: new Date(`${input.paidAt}T00:00:00Z`),
      reference: input.reference.trim().slice(0, 200) || null,
    })
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function revealWalletAction(walletId: string): Promise<{ ok: true; address: string } | { ok: false; message: string }> {
  try {
    const user = await authorize("wallet:manage")
    return { ok: true, address: await revealWallet(user, walletId) }
  } catch (error) {
    return fail(error)
  }
}

export async function historyAction(employeeId: string) {
  try {
    const user = await sessionUser()
    if (!user.permissions.has("salary:read")) throw new AuthorizationError("You do not have permission to view salary history.")
    return { ok: true as const, history: await compensationHistory(user, employeeId) }
  } catch (error) {
    return fail(error)
  }
}

// ── Project income and costs ──

export type LedgerFormInput = {
  departmentId: string
  item: string
  amount: string
  currency: string
  categoryId: string
  projectId: string
  clientId: string
  clientName: string
  teamId: string
  date: string
  notes: string
}

function ledgerInput(input: Partial<LedgerFormInput>) {
  const id = (v: string | undefined) => (v === undefined ? undefined : v.trim() ? v.trim() : null)
  const out: Record<string, unknown> = {}
  if (input.departmentId !== undefined) out.departmentId = input.departmentId
  if (input.item !== undefined) out.item = input.item
  if (input.amount !== undefined) {
    if (!/^\d{1,16}(\.\d{1,8})?$/.test(input.amount.trim())) throw new UserInputError("Amount must be a positive number.")
    out.amount = new Decimal(input.amount.trim())
  }
  if (input.currency !== undefined) out.currency = input.currency
  if (input.categoryId !== undefined) out.categoryId = id(input.categoryId)
  if (input.projectId !== undefined) out.projectId = id(input.projectId)
  if (input.clientId !== undefined) out.clientId = id(input.clientId)
  if (input.clientName !== undefined) out.clientName = id(input.clientName)
  if (input.teamId !== undefined) out.teamId = id(input.teamId)
  if (input.date !== undefined) {
    if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new UserInputError("Invalid date.")
    out.date = input.date ? new Date(`${input.date}T00:00:00Z`) : null
  }
  if (input.notes !== undefined) out.notes = input.notes.trim() || null
  return out
}

const KINDS = ["income", "cost"] as const
function kindOf(kind: string) {
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new UserInputError("Unknown row type.")
  return kind as (typeof KINDS)[number]
}

function ledgerDone() {
  revalidatePath("/payroll")
  revalidatePath("/")
  revalidatePath("/departments")
  return { ok: true as const }
}

export async function addLedgerAction(monthKey: string, kind: string, input: LedgerFormInput, allowDuplicate = false): Promise<CellResult & { duplicate?: boolean }> {
  try {
    const user = await authorize("project_finance:manage")
    const parsed = ledgerInput(input) as unknown as Parameters<typeof addLedgerEntry>[3]
    await addLedgerEntry(user, month(monthKey), kindOf(kind), { ...parsed, allowDuplicate })
    return ledgerDone()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DUPLICATE")) return { ok: false, message: error.message, duplicate: true }
    return fail(error)
  }
}

export async function updateLedgerAction(kind: string, id: string, input: Partial<LedgerFormInput>): Promise<CellResult> {
  try {
    const user = await authorize("project_finance:manage")
    await updateLedgerEntry(user, kindOf(kind), id, ledgerInput(input))
    return ledgerDone()
  } catch (error) {
    return fail(error)
  }
}

export async function deleteLedgerAction(kind: string, id: string): Promise<CellResult> {
  try {
    const user = await authorize("project_finance:manage")
    await deleteLedgerEntry(user, kindOf(kind), id)
    return ledgerDone()
  } catch (error) {
    return fail(error)
  }
}

export async function confirmLedgerAction(kind: string, id: string, confirmed: boolean): Promise<CellResult> {
  try {
    const user = await authorize("project_finance:manage")
    await setLedgerConfirmed(user, kindOf(kind), id, confirmed)
    return ledgerDone()
  } catch (error) {
    return fail(error)
  }
}

export async function settleLedgerAction(kind: string, id: string, input: { amount: string; financialAccountId: string; date: string }): Promise<CellResult> {
  try {
    const user = await authorize("project_finance:manage")
    const amount = input.amount.trim()
    if (amount && !/^\d{1,16}(\.\d{1,8})?$/.test(amount)) throw new UserInputError("Amount must be a positive number.")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new UserInputError("Choose the date.")
    await recordSettlement(user, kindOf(kind), id, { amount: amount ? new Decimal(amount) : null, financialAccountId: input.financialAccountId, date: new Date(`${input.date}T00:00:00Z`) })
    return ledgerDone()
  } catch (error) {
    return fail(error)
  }
}

// ── Employee and department administration from the sheet ──

const done2 = () => {
  revalidatePath("/employees")
  revalidatePath("/departments")
  revalidatePath("/profitability")
  return done()
}

export async function deleteEmployeeAction(employeeId: string, confirmName: string): Promise<CellResult> {
  try {
    await deleteEmployee(await authorize("employee:manage"), employeeId, String(confirmName ?? ""))
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function archivedEmployeesAction() {
  try {
    return { ok: true as const, employees: await listArchivedEmployees(await sessionUser()) }
  } catch (error) {
    return fail(error)
  }
}

export async function sheetDepartmentsAction(monthKey: string) {
  try {
    return { ok: true as const, departments: await listSheetDepartments(await authorize("payroll:read"), month(monthKey)) }
  } catch (error) {
    return fail(error)
  }
}

export async function createDepartmentAction(input: { name: string; color: string | null; costClassification: string }): Promise<CellResult> {
  try {
    const classification = input.costClassification === "COST_OF_SALES" ? "COST_OF_SALES" : "OPERATING_EXPENSE"
    await createSheetDepartment(await authorize("structure:manage"), { name: String(input.name ?? ""), color: input.color, costClassification: classification })
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function renameDepartmentAction(id: string, name: string): Promise<CellResult> {
  try {
    await renameDepartment(await authorize("structure:manage"), id, String(name ?? ""))
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function departmentColorAction(id: string, color: string | null): Promise<CellResult> {
  try {
    await setDepartmentColor(await authorize("structure:manage"), id, color)
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function archiveDepartmentAction(id: string, archived: boolean, monthKey: string): Promise<CellResult> {
  try {
    await setSheetDepartmentArchived(await authorize("structure:manage"), id, archived, month(monthKey))
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function deleteDepartmentAction(id: string): Promise<CellResult> {
  try {
    await deleteDepartment(await authorize("structure:manage"), id)
    return done2()
  } catch (error) {
    return fail(error)
  }
}

export async function mergeDepartmentsAction(sourceId: string, targetId: string, monthKey: string, confirmed: boolean): Promise<CellResult> {
  try {
    if (confirmed !== true) throw new UserInputError("Confirm the merge first.")
    await mergeDepartments(await authorize("structure:manage"), sourceId, targetId, month(monthKey))
    return done2()
  } catch (error) {
    return fail(error)
  }
}

/** Moves the month to review, closes it or reopens it (permission-checked and audited; never automatic). */
export async function periodAction(monthKey: string, action: string, reason: string | null): Promise<CellResult> {
  try {
    if (!["review", "close", "reopen"].includes(action)) throw new UserInputError("Unknown action.")
    await setPeriodStatus(await sessionUser(), month(monthKey), action as PeriodAction, typeof reason === "string" ? reason : null)
    for (const p of ["/transactions", "/pnl", "/cash-flow", "/balance-sheet"]) revalidatePath(p)
    return done()
  } catch (error) {
    return fail(error)
  }
}
