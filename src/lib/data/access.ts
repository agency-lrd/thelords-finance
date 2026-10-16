import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

type AuthUserRow = { id: string; email: string; created_at: Date; last_sign_in_at: Date | null }

/** Supabase Auth accounts with their application access in this organization. */
export async function listUserAccess(user: SessionUser, db: Db = prisma) {
  const authUsers = await db.$queryRaw<AuthUserRow[]>`
    SELECT id, lower(email) AS email, created_at, last_sign_in_at FROM auth.users
    WHERE deleted_at IS NULL AND email IS NOT NULL ORDER BY created_at`
  const appUsers = await db.appUser.findMany({
    where: { id: { in: authUsers.map((u) => u.id) } },
    include: {
      roleAssignments: {
        where: { organizationId: user.organizationId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
        include: { role: true, scopeDepartment: true },
        orderBy: { createdAt: "asc" },
      },
    },
  })
  const byId = new Map(appUsers.map((u) => [u.id, u]))
  return authUsers.map((a) => ({ ...a, appUser: byId.get(a.id) ?? null }))
}

export function listRoles(user: SessionUser, db: Db = prisma) {
  return db.role.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" } })
}

/** Grants a role to a Supabase Auth account, creating its application user if needed. */
export async function grantRole(user: SessionUser, authUserId: string, roleId: string, scopeDepartmentId: string | null, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const [authUser] = await tx.$queryRaw<AuthUserRow[]>`
      SELECT id, lower(email) AS email, created_at, last_sign_in_at FROM auth.users WHERE id = ${authUserId}::uuid AND deleted_at IS NULL`
    if (!authUser) throw new UserInputError("Account not found in Supabase Auth.")
    const role = await tx.role.findFirst({ where: { id: roleId, organizationId: user.organizationId } })
    if (!role) throw new UserInputError("Role not found.")
    if (role.key === "DEPARTMENT_HEAD" && !scopeDepartmentId) throw new UserInputError("Choose the department for a Department Head.")
    if (role.key !== "DEPARTMENT_HEAD") scopeDepartmentId = null

    await tx.appUser.upsert({
      where: { id: authUser.id },
      create: { id: authUser.id, email: authUser.email, status: "ACTIVE" },
      update: {},
    })
    const assignment = await tx.userRoleAssignment.create({
      data: { organizationId: user.organizationId, userId: authUser.id, roleId, scopeDepartmentId, grantedById: user.id },
    })
    await audit(tx, user, "access.grant_role", "user_role_assignment", assignment.id, { userId: authUser.id, role: role.key, scopeDepartmentId })
    return assignment
  })
}

/** Revokes a role from now on; the grant history is kept. */
export async function revokeRole(user: SessionUser, assignmentId: string, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const assignment = await tx.userRoleAssignment.findFirst({ where: { id: assignmentId, organizationId: user.organizationId } })
    if (!assignment) throw new UserInputError("Role grant not found.")
    if (assignment.userId === user.id) throw new UserInputError("You cannot revoke your own role.")
    await tx.userRoleAssignment.update({ where: { id: assignmentId }, data: { validTo: new Date() } })
    await audit(tx, user, "access.revoke_role", "user_role_assignment", assignmentId, { userId: assignment.userId })
  })
}

export async function setUserStatus(user: SessionUser, userId: string, status: "ACTIVE" | "SUSPENDED", db: Db = prisma) {
  return inTx(db, async (tx) => {
    if (userId === user.id) throw new UserInputError("You cannot change your own status.")
    const target = await tx.appUser.findUnique({ where: { id: userId } })
    if (!target) throw new UserInputError("User not found.")
    if (target.isSuperAdmin && !user.isSuperAdmin) throw new UserInputError("Only a Super Admin can change another Super Admin.")
    await tx.appUser.update({ where: { id: userId }, data: { status } })
    await audit(tx, user, status === "ACTIVE" ? "access.activate_user" : "access.suspend_user", "app_user", userId)
  })
}
