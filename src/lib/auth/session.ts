import "server-only"

import { redirect } from "next/navigation"
import { cache } from "react"

import { AuthorizationError } from "@/lib/authz/server"
import { PERMISSIONS, type Permission } from "@/lib/authz/permissions"
import { prisma } from "@/lib/db"
import { isSupabaseConfigured } from "@/lib/supabase/env"
import { createClient } from "@/lib/supabase/server"

export type SessionUser = {
  id: string
  email: string
  displayName: string | null
  isSuperAdmin: boolean
  organizationId: string
  organizationName: string
  baseCurrency: string
  permissions: ReadonlySet<Permission>
}

type SessionResult =
  | { state: "signed-out" }
  | { state: "no-access"; email: string }
  | { state: "ok"; user: SessionUser }

/**
 * Data Access Layer entry point: verifies the Supabase session with the Auth server, then loads the
 * user's application access (active app user, organization, organization-wide permissions).
 * Permissions come from the same database function the RLS policies use. Cached per request.
 */
export const getSession = cache(async (): Promise<SessionResult> => {
  if (!isSupabaseConfigured()) return { state: "signed-out" }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return { state: "signed-out" }

  const email = data.user.email ?? ""
  const appUser = await prisma.appUser.findUnique({ where: { id: data.user.id } })
  if (!appUser || appUser.status !== "ACTIVE") return { state: "no-access", email }

  const now = new Date()
  const organization = appUser.isSuperAdmin
    ? await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } })
    : (
        await prisma.userRoleAssignment.findFirst({
          where: { userId: appUser.id, validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gt: now } }] },
          orderBy: { createdAt: "asc" },
          include: { organization: true },
        })
      )?.organization
  if (!organization) return { state: "no-access", email }

  const rows = await prisma.$queryRaw<{ key: string }[]>`
    SELECT "key" FROM "permissions"
    WHERE "finance_private"."user_has_permission"(${appUser.id}::uuid, ${organization.id}::uuid, "key")`
  const known = new Set<string>(PERMISSIONS)
  const permissions = new Set(rows.map((r) => r.key).filter((k): k is Permission => known.has(k)))

  return {
    state: "ok",
    user: {
      id: appUser.id,
      email: appUser.email,
      displayName: appUser.displayName,
      isSuperAdmin: appUser.isSuperAdmin,
      organizationId: organization.id,
      organizationName: organization.name,
      baseCurrency: organization.baseCurrency,
      permissions,
    },
  }
})

/** For pages: redirects to /login or /no-access instead of rendering without access. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession()
  if (session.state === "signed-out") redirect("/login")
  if (session.state === "no-access") redirect("/no-access")
  return session.user
}

/** For pages: requires one of the permissions, otherwise shows the no-access page. */
export async function requirePageAccess(...anyOf: Permission[]): Promise<SessionUser> {
  const user = await requireUser()
  if (anyOf.length && !anyOf.some((p) => user.permissions.has(p))) redirect("/no-access?reason=permission")
  return user
}

/** For Server Actions: throws instead of redirecting so the form can show the error. */
export async function authorize(permission: Permission): Promise<SessionUser> {
  const session = await getSession()
  if (session.state !== "ok") throw new AuthorizationError("Your session has expired. Sign in again.")
  if (!session.user.permissions.has(permission)) {
    throw new AuthorizationError("You do not have permission to do this.")
  }
  return session.user
}

export function can(user: SessionUser, permission: Permission) {
  return user.permissions.has(permission)
}
