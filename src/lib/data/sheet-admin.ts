import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { monthStart, type Month } from "@/lib/period"

import { audit, uniqueCode, type Tx } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Employee and department administration from the financial sheet. Records are related by stable ids,
 * so a rename shows everywhere at once and never touches history. Anything with financial history is
 * archived, not deleted: payroll, payments, journal entries, KPI results and audit logs stay intact.
 */

export const DEPARTMENT_COLORS = ["pink", "amber", "violet", "sky", "rose", "emerald", "orange", "fuchsia", "teal"] as const
export type DepartmentColor = (typeof DEPARTMENT_COLORS)[number]

const needEmployees = (user: SessionUser) => {
  if (!user.permissions.has("employee:manage")) throw new UserInputError("You do not have permission to manage employees.")
}
const needStructure = (user: SessionUser) => {
  if (!user.permissions.has("structure:manage")) throw new UserInputError("You do not have permission to manage departments.")
}

// ─── Employees ───────────────────────────────────────────────────────────────

/** What links an employee to financial records (a reason to archive instead of delete). */
async function employeeHistory(tx: Tx, employeeId: string) {
  const [payslips, adjustments, kpiResults, projectCosts, journalLines, projects, agreements, credentials] = [
    await tx.payrollItem.count({ where: { employeeId } }),
    await tx.payrollAdjustment.count({ where: { employeeId } }),
    await tx.kpiActual.count({ where: { employeeId } }),
    await tx.projectCost.count({ where: { employeeId } }),
    await tx.journalLine.count({ where: { employeeId } }),
    await tx.project.count({ where: { managerEmployeeId: employeeId } }),
    await tx.employmentAgreement.count({ where: { employeeId } }),
    await tx.vaultCredential.count({ where: { responsibleEmployeeId: employeeId } }),
  ]
  const history = { payslips, adjustments, kpiResults, projectCosts, journalLines, projects, agreements, credentials }
  return { history, hasHistory: Object.values(history).some((n) => n > 0) }
}

/** Archived employees, for the sheet's archive panel (restore or delete). */
export async function listArchivedEmployees(user: SessionUser, db: Db = prisma) {
  if (!user.permissions.has("employee:read") && !user.permissions.has("employee:manage")) throw new UserInputError("You do not have permission to view employees.")
  const rows = await db.employee.findMany({
    where: { organizationId: user.organizationId, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
    take: 200,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      archivedAt: true,
      assignments: { where: { isPrimary: true }, orderBy: { validFrom: "desc" }, take: 1, select: { department: { select: { name: true } } } },
      _count: { select: { payrollItems: true, payrollAdjustments: true, journalLines: true, projectCosts: true, kpiActuals: true } },
    },
  })
  return rows.map((e) => ({
    id: e.id,
    name: [e.firstName, e.lastName].filter(Boolean).join(" "),
    department: e.assignments[0]?.department.name ?? null,
    archivedAt: e.archivedAt!.toISOString(),
    hasHistory: Object.values(e._count).some((n) => n > 0),
  }))
}

/**
 * Permanently deletes an employee who has no financial history (for example, added by mistake).
 * Employees with payroll, adjustments, KPI results, project costs, journal lines or other links are
 * refused: archive them instead.
 */
export async function deleteEmployee(user: SessionUser, employeeId: string, confirmName: string, db: Db = prisma) {
  needEmployees(user)
  if (!user.permissions.has("salary:manage")) throw new UserInputError("Deleting an employee also needs permission to manage salaries.")
  return inTx(db, async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: user.organizationId } })
    if (!employee) throw new UserInputError("Employee not found.")
    const name = [employee.firstName, employee.lastName].filter(Boolean).join(" ")
    if (confirmName.trim() !== name) throw new UserInputError("Type the employee's name exactly to confirm deletion.")
    const { history, hasHistory } = await employeeHistory(tx, employeeId)
    if (hasHistory) throw new UserInputError("This employee has financial history (payroll, adjustments, KPI or accounting entries). Archive the employee instead; the history is kept.")
    if (await tx.department.findFirst({ where: { headEmployeeId: employeeId } })) throw new UserInputError("The employee heads a department. Choose another head first.")
    if (await tx.team.findFirst({ where: { leadEmployeeId: employeeId } })) throw new UserInputError("The employee leads a team. Choose another lead first.")
    // Configuration only (no money moved): salary terms, KPI targets, assignments, wallets.
    const scopes = await tx.compensationAssignment.findMany({ where: { employeeId }, select: { id: true, ruleId: true } })
    await tx.compensationAssignment.deleteMany({ where: { employeeId } })
    for (const ruleId of new Set(scopes.map((s) => s.ruleId))) {
      if ((await tx.compensationAssignment.count({ where: { ruleId } })) === 0) {
        await tx.compensationRuleTier.deleteMany({ where: { ruleId } })
        await tx.compensationRule.deleteMany({ where: { id: ruleId, organizationId: user.organizationId } })
      }
    }
    await tx.kpiTarget.deleteMany({ where: { employeeId } })
    await tx.salaryCondition.deleteMany({ where: { employeeId } })
    await tx.employeeAssignment.deleteMany({ where: { employeeId } })
    await tx.payoutWallet.deleteMany({ where: { employeeId } })
    await tx.payrollMonthEmployee.deleteMany({ where: { employeeId } })
    await tx.employee.delete({ where: { id: employeeId } })
    await audit(tx, user, "employee.delete", "employee", employeeId, { name, checked: history })
  })
}

// ─── Departments ─────────────────────────────────────────────────────────────

/** Departments for the sheet: color, archive flag, current headcount and whether they have history. */
export async function listSheetDepartments(user: SessionUser, m: Month, db: Db = prisma) {
  const start = monthStart(m)
  const rows = await db.department.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      color: true,
      archivedAt: true,
      assignments: { where: { isPrimary: true, OR: [{ validTo: null }, { validTo: { gt: start } }], employee: { archivedAt: null } }, select: { employeeId: true } },
      _count: { select: { journalLines: true, payrollItems: true, transactions: true, budgetLines: true, projects: true, assignments: true, children: true } },
    },
  })
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    color: (DEPARTMENT_COLORS as readonly string[]).includes(d.color ?? "") ? (d.color as DepartmentColor) : null,
    archived: !!d.archivedAt,
    employees: new Set(d.assignments.map((a) => a.employeeId)).size,
    hasHistory: Object.values(d._count).some((n) => n > 0),
  }))
}

const cleanName = (raw: string) => {
  const name = raw.trim().replace(/\s+/g, " ")
  if (!name || name.length > 120) throw new UserInputError("Enter a department name (max 120 characters).")
  return name
}

async function assertUniqueName(tx: Tx, user: SessionUser, name: string, exceptId: string | null) {
  const clash = await tx.department.findFirst({ where: { organizationId: user.organizationId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })
  if (clash) throw new UserInputError(`A department named "${clash.name}" already exists${clash.archivedAt ? " in the archive" : ""}.`)
}

export async function createSheetDepartment(user: SessionUser, input: { name: string; color: string | null; costClassification: "COST_OF_SALES" | "OPERATING_EXPENSE" }, db: Db = prisma) {
  needStructure(user)
  const name = cleanName(input.name)
  const color = input.color && (DEPARTMENT_COLORS as readonly string[]).includes(input.color) ? input.color : null
  return inTx(db, async (tx) => {
    await assertUniqueName(tx, user, name, null)
    const code = await uniqueCode(name, async (c) => Boolean(await tx.department.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
    // New departments go to the end of the explicit order.
    const last = await tx.department.aggregate({ where: { organizationId: user.organizationId }, _max: { sortOrder: true } })
    const department = await tx.department.create({ data: { organizationId: user.organizationId, code, name, color, costClassification: input.costClassification, sortOrder: (last._max.sortOrder ?? 0) + 10 } })
    await audit(tx, user, "department.create", "department", department.id, { name, color, via: "sheet" })
    return department
  })
}

/** Renames a department. Everything refers to the department by id, so the new name shows everywhere. */
export async function renameDepartment(user: SessionUser, id: string, rawName: string, db: Db = prisma) {
  needStructure(user)
  const name = cleanName(rawName)
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!department) throw new UserInputError("Department not found.")
    if (department.name === name) return
    await assertUniqueName(tx, user, name, id)
    await tx.department.update({ where: { id }, data: { name } })
    await audit(tx, user, "department.rename", "department", id, { from: department.name, to: name })
  })
}

export async function setDepartmentColor(user: SessionUser, id: string, color: string | null, db: Db = prisma) {
  needStructure(user)
  if (color !== null && !(DEPARTMENT_COLORS as readonly string[]).includes(color)) throw new UserInputError("Choose a color from the palette.")
  return inTx(db, async (tx) => {
    const { count } = await tx.department.updateMany({ where: { id, organizationId: user.organizationId }, data: { color } })
    if (!count) throw new UserInputError("Department not found.")
    await audit(tx, user, "department.color", "department", id, { color })
  })
}

/** Archives (hides) or restores a department. A department with current employees must be emptied (moved or merged) first. */
export async function setSheetDepartmentArchived(user: SessionUser, id: string, archived: boolean, m: Month, db: Db = prisma) {
  needStructure(user)
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!department) throw new UserInputError("Department not found.")
    if (archived) {
      const current = await tx.employeeAssignment.count({ where: { departmentId: id, isPrimary: true, OR: [{ validTo: null }, { validTo: { gt: monthStart(m) } }], employee: { archivedAt: null } } })
      if (current) throw new UserInputError(`The department still has ${current} employee(s). Move them to another department or merge the department first.`)
    }
    await tx.department.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } })
    await audit(tx, user, archived ? "department.archive" : "department.restore", "department", id)
  })
}

/** Deletes a department that was never used. Departments with any employees or financial records are refused (archive or merge them). */
export async function deleteDepartment(user: SessionUser, id: string, db: Db = prisma) {
  needStructure(user)
  return inTx(db, async (tx) => {
    const d = await tx.department.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { _count: { select: { assignments: true, journalLines: true, payrollItems: true, transactions: true, budgetLines: true, projects: true, children: true, teams: true, kpiTargets: true, kpiActuals: true, compensationScopes: true, roleAssignments: true, vaultCredentials: true } } },
    })
    if (!d) throw new UserInputError("Department not found.")
    if (Object.values(d._count).some((n) => n > 0)) throw new UserInputError("The department has employees or financial records. Archive it or merge it into another department instead.")
    await tx.department.delete({ where: { id } })
    await audit(tx, user, "department.delete", "department", id, { name: d.name })
  })
}

/**
 * Merges a department into another from the given month: every current and future employee
 * assignment moves to the target, sub-departments and teams move too, and the source is archived.
 * Past assignments, payslips, journal lines, budgets and reports keep the source department, so
 * history does not change.
 */
export async function mergeDepartments(user: SessionUser, sourceId: string, targetId: string, m: Month, db: Db = prisma) {
  needStructure(user)
  if (sourceId === targetId) throw new UserInputError("Choose two different departments.")
  return inTx(db, async (tx) => {
    const [source, target] = [
      await tx.department.findFirst({ where: { id: sourceId, organizationId: user.organizationId } }),
      await tx.department.findFirst({ where: { id: targetId, organizationId: user.organizationId, archivedAt: null } }),
    ]
    if (!source || !target) throw new UserInputError("Department not found.")
    // The target must not sit inside the source.
    for (let cursor: string | null = target.parentId; cursor; ) {
      if (cursor === sourceId) throw new UserInputError("A department cannot be merged into one of its own sub-departments.")
      cursor = (await tx.department.findFirst({ where: { id: cursor }, select: { parentId: true } }))?.parentId ?? null
    }
    const start = monthStart(m)
    const assignments = await tx.employeeAssignment.findMany({ where: { departmentId: sourceId, OR: [{ validTo: null }, { validTo: { gt: start } }] }, orderBy: { validFrom: "asc" } })
    let moved = 0
    for (const a of assignments) {
      if (a.validFrom >= start) {
        await tx.employeeAssignment.update({ where: { id: a.id }, data: { departmentId: targetId, teamId: null } })
      } else {
        await tx.employeeAssignment.update({ where: { id: a.id }, data: { validTo: start } })
        await tx.employeeAssignment.create({ data: { employeeId: a.employeeId, departmentId: targetId, isPrimary: a.isPrimary, allocationRate: a.allocationRate, validFrom: start, validTo: a.validTo } })
      }
      moved++
    }
    await tx.department.updateMany({ where: { parentId: sourceId, organizationId: user.organizationId }, data: { parentId: targetId } })
    await tx.team.updateMany({ where: { departmentId: sourceId }, data: { departmentId: targetId } })
    if (source.headEmployeeId && !target.headEmployeeId) {
      await tx.department.update({ where: { id: sourceId }, data: { headEmployeeId: null } })
      await tx.department.update({ where: { id: targetId }, data: { headEmployeeId: source.headEmployeeId } })
    }
    await tx.department.update({ where: { id: sourceId }, data: { archivedAt: new Date() } })
    await audit(tx, user, "department.merge", "department", sourceId, { into: targetId, from: `${m.year}-${String(m.month).padStart(2, "0")}`, assignmentsMoved: moved })
    return { moved }
  })
}

/** Moves a department one place up or down (explicit order used by the sheet and the structure screen). */
export async function moveDepartment(user: SessionUser, departmentId: string, direction: "up" | "down", db: Db = prisma) {
  if (!user.permissions.has("structure:manage")) throw new UserInputError("You do not have permission to manage departments.")
  return inTx(db, async (tx) => {
    const list = await tx.department.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true } })
    const i = list.findIndex((d) => d.id === departmentId)
    const j = direction === "up" ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= list.length) return
    const order = list.map((d) => d.id)
    ;[order[i], order[j]] = [order[j], order[i]]
    for (const [index, id] of order.entries()) await tx.department.update({ where: { id }, data: { sortOrder: (index + 1) * 10 } })
    await audit(tx, user, "department.move", "department", departmentId, { direction })
  })
}
