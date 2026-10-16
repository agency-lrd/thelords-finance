import "server-only"

import { prisma } from "@/lib/db"
import { createClient } from "@/lib/supabase/server"

import type { Permission } from "./permissions"

export class AuthorizationError extends Error {
  constructor(message = "Not authorized") {
    super(message)
    this.name = "AuthorizationError"
  }
}

/**
 * Supabase user id of the signed-in user, verified with the Supabase Auth server.
 * Throws AuthorizationError when there is no valid session.
 */
export async function requireUserId(): Promise<string> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new AuthorizationError("Sign-in required")
  return data.user.id
}

/**
 * Whether the user holds a permission in an organization. Uses the same database function as the
 * row level security policies, so server checks and RLS can never disagree.
 * departmentId: when given, a role scoped to that department (e.g. Department Head) also counts.
 */
export async function hasPermission(
  userId: string,
  organizationId: string,
  permission: Permission,
  departmentId: string | null = null,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ allowed: boolean }[]>`
    SELECT "finance_private"."user_has_permission"(
      ${userId}::uuid, ${organizationId}::uuid, ${permission}, ${departmentId}::uuid
    ) AS allowed`
  return rows[0]?.allowed === true
}

/** Throws AuthorizationError unless the user holds the permission. */
export async function requirePermission(
  userId: string,
  organizationId: string,
  permission: Permission,
  departmentId: string | null = null,
): Promise<void> {
  if (!(await hasPermission(userId, organizationId, permission, departmentId))) {
    throw new AuthorizationError(`Missing permission ${permission}`)
  }
}
