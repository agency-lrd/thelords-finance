"use server"

import { revalidatePath } from "next/cache"

import type { PayBasis } from "@/generated/prisma/client"
import { authorize } from "@/lib/auth/session"
import { addSalaryChange, changeDepartment, createEmployee, setEmployeeStatus } from "@/lib/data/employees"
import { isoDate, oneOf, requiredId, requiredText, text, toActionError, UserInputError, type ActionState } from "@/lib/forms"
import { parseAmount, SUPPORTED_CURRENCIES } from "@/lib/money"

const PAY_BASES = ["MONTHLY", "HOURLY", "DAILY", "FIXED_FEE"] as const satisfies readonly PayBasis[]

function salaryFields(formData: FormData) {
  const payBasis = oneOf(formData, "payBasis", PAY_BASES)
  const hours = String(formData.get("standardHoursPerMonth") ?? "").trim()
  return {
    payBasis,
    baseAmount: parseAmount(formData.get("baseAmount"), "Salary"),
    currency: oneOf(formData, "currency", SUPPORTED_CURRENCIES),
    standardHoursPerMonth: hours ? parseAmount(hours, "Standard hours") : null,
  }
}

export async function createEmployeeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("employee:manage")
    if (!user.permissions.has("salary:manage")) throw new UserInputError("Adding an employee also requires permission to manage salaries.")
    const country = text(formData, "country", { max: 2 })?.toUpperCase() ?? null
    if (country && !/^[A-Z]{2}$/.test(country)) throw new UserInputError("Country must be a 2-letter code, e.g. GB.")
    const employee = await createEmployee(user, {
      employeeNumber: requiredText(formData, "employeeNumber", 40),
      firstName: requiredText(formData, "firstName", 80),
      lastName: requiredText(formData, "lastName", 80),
      jobTitle: text(formData, "jobTitle", { max: 120 }),
      workEmail: text(formData, "workEmail", { max: 200 })?.toLowerCase() ?? null,
      country,
      hireDate: isoDate(formData, "hireDate") as Date,
      departmentId: requiredId(formData, "departmentId"),
      ...salaryFields(formData),
    })
    revalidatePath("/employees")
    return { status: "success", message: `${employee.firstName} ${employee.lastName} added.` }
  } catch (error) {
    return toActionError(error)
  }
}

export async function addSalaryChangeAction(employeeId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("salary:manage")
    await addSalaryChange(user, employeeId, {
      validFrom: isoDate(formData, "validFrom") as Date,
      reason: requiredText(formData, "reason", 300),
      ...salaryFields(formData),
    })
    revalidatePath(`/employees/${employeeId}`)
    revalidatePath("/employees")
    return { status: "success", message: "Salary change saved. Earlier months keep their previous salary." }
  } catch (error) {
    return toActionError(error)
  }
}

export async function changeDepartmentAction(employeeId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("employee:manage")
    await changeDepartment(user, employeeId, requiredId(formData, "departmentId"), isoDate(formData, "validFrom") as Date)
    revalidatePath(`/employees/${employeeId}`)
    revalidatePath("/employees")
    return { status: "success", message: "Department change saved." }
  } catch (error) {
    return toActionError(error)
  }
}

export async function setEmployeeStatusAction(employeeId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await authorize("employee:manage")
    const status = oneOf(formData, "status", ["ACTIVE", "ON_LEAVE", "TERMINATED"] as const)
    await setEmployeeStatus(user, employeeId, status, isoDate(formData, "terminationDate", { required: false }))
    revalidatePath(`/employees/${employeeId}`)
    revalidatePath("/employees")
    return { status: "success", message: "Status updated." }
  } catch (error) {
    return toActionError(error)
  }
}
