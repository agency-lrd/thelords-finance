import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { monthEnd, monthStart, type Month } from "@/lib/period"

import { audit, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"

type Classification = "COST_OF_SALES" | "OPERATING_EXPENSE"

function requireManage(user: SessionUser) {
  if (!user.permissions.has("structure:manage")) throw new UserInputError("You do not have permission to manage departments.")
}

/** Departments with subdepartments, teams, head and headcount for the month. */
export async function listDepartmentTree(user: SessionUser, m: Month, db: Db = prisma) {
  const start = monthStart(m)
  const end = monthEnd(m)
  const departments = await db.department.findMany({
    where: { organizationId: user.organizationId },
    include: {
      head: { select: { id: true, firstName: true, lastName: true } },
      teams: { include: { lead: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { name: "asc" } },
      assignments: {
        where: { isPrimary: true, validFrom: { lte: end }, OR: [{ validTo: null }, { validTo: { gt: start } }], employee: { archivedAt: null } },
        select: { employeeId: true },
      },
    },
    orderBy: { name: "asc" },
  })
  return departments.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
    description: d.description,
    parentId: d.parentId,
    costClassification: d.costClassification as Classification,
    archived: !!d.archivedAt,
    head: d.head ? { id: d.head.id, name: `${d.head.firstName} ${d.head.lastName}`.trim() } : null,
    headcount: new Set(d.assignments.map((a) => a.employeeId)).size,
    teams: d.teams.map((t) => ({ id: t.id, name: t.name, archived: !!t.archivedAt, lead: t.lead ? { id: t.lead.id, name: `${t.lead.firstName} ${t.lead.lastName}`.trim() } : null })),
  }))
}

export async function createDepartmentNode(user: SessionUser, input: { name: string; parentId: string | null; costClassification: Classification }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const name = input.name.trim()
    if (!name || name.length > 120) throw new UserInputError("Enter a department name (max 120 characters).")
    if (input.parentId && !(await tx.department.findFirst({ where: { id: input.parentId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Parent department not found.")
    }
    const code = await uniqueCode(name, async (c) => Boolean(await tx.department.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
    const department = await tx.department.create({
      data: { organizationId: user.organizationId, code, name, parentId: input.parentId, costClassification: input.costClassification },
    })
    await audit(tx, user, "department.create", "department", department.id, { name, parentId: input.parentId })
    return department
  })
}

export async function updateDepartment(
  user: SessionUser,
  id: string,
  input: { name?: string; parentId?: string | null; costClassification?: Classification; headEmployeeId?: string | null; archived?: boolean },
  db: Db = prisma,
) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id, organizationId: user.organizationId } })
    if (!department) throw new UserInputError("Department not found.")
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new UserInputError("Enter a department name (max 120 characters).")
    if (input.parentId) {
      // Walk up from the new parent: it must not be this department or one of its descendants.
      let cursor: string | null = input.parentId
      while (cursor) {
        if (cursor === id) throw new UserInputError("A department cannot be inside itself.")
        const parent: { parentId: string | null } | null = await tx.department.findFirst({ where: { id: cursor, organizationId: user.organizationId }, select: { parentId: true } })
        if (!parent) throw new UserInputError("Parent department not found.")
        cursor = parent.parentId
      }
    }
    if (input.headEmployeeId && !(await tx.employee.findFirst({ where: { id: input.headEmployeeId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Employee not found.")
    }
    if (input.headEmployeeId) {
      // An employee heads at most one department (unique in the schema).
      await tx.department.updateMany({ where: { headEmployeeId: input.headEmployeeId, NOT: { id } }, data: { headEmployeeId: null } })
    }
    await tx.department.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.costClassification ? { costClassification: input.costClassification } : {}),
        ...(input.headEmployeeId !== undefined ? { headEmployeeId: input.headEmployeeId } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    })
    await audit(tx, user, "department.update", "department", id, input)
  })
}

export async function createTeam(user: SessionUser, departmentId: string, input: { name: string; leadEmployeeId: string | null }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const department = await tx.department.findFirst({ where: { id: departmentId, organizationId: user.organizationId } })
    if (!department) throw new UserInputError("Department not found.")
    const name = input.name.trim()
    if (!name || name.length > 120) throw new UserInputError("Enter a team name.")
    if (input.leadEmployeeId && !(await tx.employee.findFirst({ where: { id: input.leadEmployeeId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Employee not found.")
    }
    const code = await uniqueCode(name, async (c) => Boolean(await tx.team.findUnique({ where: { departmentId_code: { departmentId, code: c } } })))
    const team = await tx.team.create({ data: { departmentId, code, name, leadEmployeeId: input.leadEmployeeId } })
    if (input.leadEmployeeId) await tx.employee.update({ where: { id: input.leadEmployeeId }, data: { isTeamLead: true } })
    await audit(tx, user, "team.create", "team", team.id, { departmentId, name })
    return team
  })
}

export async function updateTeam(user: SessionUser, teamId: string, input: { leadEmployeeId?: string | null; archived?: boolean }, db: Db = prisma) {
  requireManage(user)
  return inTx(db, async (tx) => {
    const team = await tx.team.findFirst({ where: { id: teamId, department: { organizationId: user.organizationId } } })
    if (!team) throw new UserInputError("Team not found.")
    if (input.leadEmployeeId && !(await tx.employee.findFirst({ where: { id: input.leadEmployeeId, organizationId: user.organizationId } }))) {
      throw new UserInputError("Employee not found.")
    }
    await tx.team.update({
      where: { id: teamId },
      data: {
        ...(input.leadEmployeeId !== undefined ? { leadEmployeeId: input.leadEmployeeId } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    })
    if (input.leadEmployeeId) await tx.employee.update({ where: { id: input.leadEmployeeId }, data: { isTeamLead: true } })
    await audit(tx, user, "team.update", "team", teamId, input)
  })
}
