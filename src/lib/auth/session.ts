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
  let appUser = await prisma.appUser.findUnique({ where: { id: data.user.id } })
  if (!appUser && data.user.email_confirmed_at && isBootstrapEmail(email)) {
    appUser = await bootstrapSuperAdmin(data.user.id, email)
  }
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

/** The configured first-owner email (SUPER_ADMIN_EMAIL), compared case-insensitively. */
export function isBootstrapEmail(email: string) {
  const allowed = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase()
  return !!allowed && email.trim().toLowerCase() === allowed
}

/** True while no active Super Admin exists (first-time onboarding is open). */
export async function onboardingOpen() {
  return (await prisma.appUser.count({ where: { isSuperAdmin: true, status: "ACTIVE" } })) === 0
}

/**
 * First-time onboarding: the confirmed SUPER_ADMIN_EMAIL account becomes Super Admin with the Owner
 * role, but only while no Super Admin exists. Serialized with an advisory lock; audited.
 */
async function bootstrapSuperAdmin(userId: string, email: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('bootstrap_super_admin', 0))`
    if ((await tx.appUser.count({ where: { isSuperAdmin: true, status: "ACTIVE" } })) > 0) return null
    const organization = await tx.organization.findFirst({ orderBy: { createdAt: "asc" } })
    if (!organization) return null
    const owner = await tx.role.findUnique({ where: { organizationId_key: { organizationId: organization.id, key: "OWNER" } } })
    const user = await tx.appUser.create({ data: { id: userId, email: email.toLowerCase(), status: "ACTIVE", isSuperAdmin: true, lastLoginAt: new Date() } })
    if (owner) await tx.userRoleAssignment.create({ data: { organizationId: organization.id, userId, roleId: owner.id } })
    await tx.auditLog.create({
      data: { organizationId: organization.id, actorType: "SYSTEM", action: "access.bootstrap_super_admin", entityType: "app_user", entityId: userId, after: { email: email.toLowerCase(), ownerRole: !!owner } },
    })
    return user
  })
}

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
