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
  updateSheetCell,
  type RuleConfig,
  type SheetField,
} from "@/lib/data/sheet"
import { toActionError, UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import { parseMonth } from "@/lib/period"

export type CellResult = { ok: true; unconfirmed?: boolean } | { ok: false; message: string }

const FIELDS: SheetField[] = ["name", "fix", "currency", "kpiTarget", "kpiActual", "bonus", "deduction", "department", "position", "status", "isTeamLead", "notes", "hireDate", "wallet"]

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

export async function updateCellAction(monthKey: string, employeeId: string, field: string, value: string): Promise<CellResult> {
  try {
    if (!FIELDS.includes(field as SheetField)) throw new UserInputError("Unknown column.")
    const user = await authorize(requiredPermission(field as SheetField))
    if (value.length > 2000) throw new UserInputError("Value is too long.")
    const result = await updateSheetCell(user, month(monthKey), employeeId, field as SheetField, value)
    return done(result)
  } catch (error) {
    return fail(error)
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

export async function confirmRowAction(monthKey: string, employeeId: string, confirmed: boolean): Promise<CellResult> {
  try {
    const user = await authorize("payroll:prepare")
    await setRowConfirmed(user, month(monthKey), employeeId, confirmed)
    return done()
  } catch (error) {
    return fail(error)
  }
}

export async function approveMonthAction(monthKey: string): Promise<CellResult> {
  try {
    const user = await authorize("payroll:approve")
    await approveMonth(user, month(monthKey), null)
    return done()
  } catch (error) {
    return fail(error)
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
