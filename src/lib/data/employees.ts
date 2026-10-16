import "server-only"

import type { PayBasis } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import type { Decimal } from "@/lib/money"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

const activeOn = (date: Date) => ({ validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gt: date } }] })

export async function listEmployees(user: SessionUser, db: Db = prisma) {
  const today = new Date()
  return db.employee.findMany({
    where: { organizationId: user.organizationId },
    include: {
      assignments: { where: { isPrimary: true, ...activeOn(today) }, include: { department: true, team: true }, take: 1 },
      salaryConditions: { where: activeOn(today), take: 1 },
    },
    orderBy: [{ status: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
  })
}

export async function getEmployee(user: SessionUser, id: string, db: Db = prisma) {
  const employee = await db.employee.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      assignments: { include: { department: true, team: true }, orderBy: { validFrom: "desc" } },
      salaryConditions: { include: { approvedBy: { select: { email: true } } }, orderBy: { validFrom: "desc" } },
      payrollItems: {
        include: { payrollRun: { include: { period: true } }, department: true },
        orderBy: { createdAt: "desc" },
        take: 36,
      },
    },
  })
  if (!employee) throw new UserInputError("Employee not found.")
  return employee
}

type NewEmployee = {
  employeeNumber: string
  firstName: string
  lastName: string
  jobTitle: string | null
  workEmail: string | null
  country: string | null
  hireDate: Date
  departmentId: string
  payBasis: PayBasis
  baseAmount: Decimal
  currency: string
  standardHoursPerMonth: Decimal | null
}

export async function createEmployee(user: SessionUser, input: NewEmployee, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id: input.departmentId, organizationId: user.organizationId, archivedAt: null } })
    if (!department) throw new UserInputError("Department not found.")

    const employee = await tx.employee.create({
      data: {
        organizationId: user.organizationId,
        employeeNumber: input.employeeNumber,
        firstName: input.firstName,
        lastName: input.lastName,
        jobTitle: input.jobTitle,
        workEmail: input.workEmail,
        country: input.country,
        hireDate: input.hireDate,
        status: input.hireDate > new Date() ? "ONBOARDING" : "ACTIVE",
      },
    })
    await tx.employeeAssignment.create({
      data: { employeeId: employee.id, departmentId: department.id, isPrimary: true, allocationRate: 1, validFrom: input.hireDate },
    })
    const approved = user.permissions.has("salary:approve")
    await tx.salaryCondition.create({
      data: {
        employeeId: employee.id,
        payBasis: input.payBasis,
        baseAmount: input.baseAmount,
        currency: input.currency,
        standardHoursPerMonth: input.standardHoursPerMonth,
        validFrom: input.hireDate,
        changeReason: "Starting salary",
        approvedById: approved ? user.id : null,
        approvedAt: approved ? new Date() : null,
      },
    })
    await audit(tx, user, "employee.create", "employee", employee.id, {
      employeeNumber: input.employeeNumber,
      departmentId: department.id,
    })
    return employee
  })
}

/**
 * Effective-dated salary change: the current open-ended condition ends the day the new one starts.
 * History is never overwritten, so past months keep the salary that applied to them.
 */
export async function addSalaryChange(
  user: SessionUser,
  employeeId: string,
  input: { validFrom: Date; payBasis: PayBasis; baseAmount: Decimal; currency: string; standardHoursPerMonth: Decimal | null; reason: string },
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } })
    if (!employee) throw new UserInputError("Employee not found.")

    const latest = await tx.salaryCondition.findFirst({ where: { employeeId }, orderBy: { validFrom: "desc" } })
    if (latest && latest.validFrom >= input.validFrom) {
      throw new UserInputError("A salary change must start after the latest salary record.")
    }
    if (latest && (latest.validTo === null || latest.validTo > input.validFrom)) {
      await tx.salaryCondition.update({ where: { id: latest.id }, data: { validTo: input.validFrom } })
    }

    const approved = user.permissions.has("salary:approve")
    const condition = await tx.salaryCondition.create({
      data: {
        employeeId,
        payBasis: input.payBasis,
        baseAmount: input.baseAmount,
        currency: input.currency,
        standardHoursPerMonth: input.standardHoursPerMonth,
        validFrom: input.validFrom,
        changeReason: input.reason,
        approvedById: approved ? user.id : null,
        approvedAt: approved ? new Date() : null,
      },
    })
    await audit(tx, user, "salary_condition.create", "salary_condition", condition.id, {
      employeeId,
      validFrom: input.validFrom.toISOString().slice(0, 10),
      baseAmount: input.baseAmount.toString(),
      currency: input.currency,
    })
    return condition
  })
}

/** Moves an employee to another department from a date; the previous assignment is kept as history. */
export async function changeDepartment(user: SessionUser, employeeId: string, departmentId: string, validFrom: Date, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const [employee, department] = await Promise.all([
      tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } }),
      tx.department.findFirst({ where: { id: departmentId, organizationId: user.organizationId, archivedAt: null } }),
    ])
    if (!employee || !department) throw new UserInputError("Employee or department not found.")

    const current = await tx.employeeAssignment.findFirst({ where: { employeeId, isPrimary: true }, orderBy: { validFrom: "desc" } })
    if (current) {
      if (current.validFrom >= validFrom) throw new UserInputError("The move must start after the current assignment began.")
      if (current.departmentId === departmentId) throw new UserInputError("The employee is already in this department.")
      await tx.employeeAssignment.update({ where: { id: current.id }, data: { validTo: validFrom } })
    }
    const assignment = await tx.employeeAssignment.create({
      data: { employeeId, departmentId, isPrimary: true, allocationRate: 1, validFrom },
    })
    await audit(tx, user, "employee.change_department", "employee", employeeId, { departmentId, validFrom: validFrom.toISOString().slice(0, 10) })
    return assignment
  })
}

export async function setEmployeeStatus(
  user: SessionUser,
  employeeId: string,
  status: "ACTIVE" | "ON_LEAVE" | "TERMINATED",
  terminationDate: Date | null,
  db: Db = prisma,
) {
  return inTx(db, async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } })
    if (!employee) throw new UserInputError("Employee not found.")
    if (status === "TERMINATED" && !terminationDate) throw new UserInputError("Termination date is required.")
    await tx.employee.update({
      where: { id: employeeId },
      data: { status, terminationDate: status === "TERMINATED" ? terminationDate : null },
    })
    await audit(tx, user, "employee.set_status", "employee", employeeId, { status })
  })
}
