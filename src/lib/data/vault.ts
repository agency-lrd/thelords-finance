import "server-only"

import type { VaultAccessLevel, VaultGrantLevel, VaultProvider } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { secretReason } from "@/lib/vault/guard"

import { audit, uniqueCode } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Credential register (metadata only). Who sees what:
 *   - Super Admin and holders of vault:manage (Owner): every entry of the organization.
 *   - Everyone else: only entries explicitly shared with them (an active grant). Department membership,
 *     a department-head role or being the responsible employee never grants access on its own.
 * Every view, username copy, login-URL open, change and share is written to the append-only audit log.
 * Audit entries record which fields changed, never values from notes or usernames.
 */

export const ACCESS_LEVELS = ["STANDARD", "SENSITIVE", "CRITICAL"] as const satisfies readonly VaultAccessLevel[]
export const PROVIDERS = ["BITWARDEN", "ONEPASSWORD", "OTHER"] as const satisfies readonly VaultProvider[]

const manages = (user: SessionUser) => user.permissions.has("vault:manage")
const ENTITY = "vault_credential"

/** Where clause for the entries a user may see. */
function visibleTo(user: SessionUser) {
  return {
    organizationId: user.organizationId,
    ...(manages(user) ? {} : { grants: { some: { userId: user.id, revokedAt: null } } }),
  }
}

async function access(db: Db, user: SessionUser, id: string) {
  const credential = await db.vaultCredential.findFirst({
    where: { id, ...visibleTo(user) },
    include: { grants: { where: { userId: user.id, revokedAt: null } } },
  })
  if (!credential) throw new UserInputError("Entry not found or not shared with you.")
  const canEdit = manages(user) || credential.grants.some((g) => g.level === "EDIT")
  return { credential, canEdit }
}

export type VaultFilters = { search?: string | null; departmentId?: string | null; categoryId?: string | null; accessLevel?: VaultAccessLevel | null; archived?: boolean }

export async function listCredentials(user: SessionUser, filters: VaultFilters = {}, db: Db = prisma) {
  const search = filters.search?.trim()
  const rows = await db.vaultCredential.findMany({
    where: {
      ...visibleTo(user),
      archivedAt: filters.archived ? { not: null } : null,
      ...(filters.departmentId ? { departmentId: filters.departmentId === "none" ? null : filters.departmentId } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.accessLevel ? { accessLevel: filters.accessLevel } : {}),
      ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { loginUrl: { contains: search, mode: "insensitive" } }, { username: { contains: search, mode: "insensitive" } }] } : {}),
    },
    include: {
      department: { select: { name: true } },
      category: { select: { name: true } },
      responsible: { select: { firstName: true, lastName: true } },
      grants: { where: { revokedAt: null }, select: { userId: true, level: true } },
    },
    orderBy: [{ name: "asc" }],
    take: 1000,
  })
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    loginUrl: c.loginUrl,
    username: c.username,
    departmentId: c.departmentId,
    department: c.department?.name ?? null,
    categoryId: c.categoryId,
    category: c.category?.name ?? null,
    responsibleEmployeeId: c.responsibleEmployeeId,
    responsible: c.responsible ? `${c.responsible.firstName} ${c.responsible.lastName}`.trim() : null,
    accessLevel: c.accessLevel,
    vaultProvider: c.vaultProvider,
    vaultItemRef: c.vaultItemRef,
    notes: c.notes,
    archived: !!c.archivedAt,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    sharedWith: manages(user) ? c.grants.length : null,
    canEdit: manages(user) || c.grants.some((g) => g.userId === user.id && g.level === "EDIT"),
  }))
}

export type CredentialInput = {
  name: string
  loginUrl: string | null
  username: string | null
  departmentId: string | null
  categoryId: string | null
  accessLevel: VaultAccessLevel
  notes: string | null
  /**
   * Legacy fields (responsible employee, external password manager). No longer in the form: when not
   * given, the stored values are kept unchanged, never wiped.
   */
  responsibleEmployeeId?: string | null
  vaultProvider?: VaultProvider | null
  vaultItemRef?: string | null
}

async function validate(db: Db, user: SessionUser, input: CredentialInput) {
  const name = input.name.trim()
  if (!name || name.length > 160) throw new UserInputError("Enter the service name.")
  if (input.loginUrl && !/^https?:\/\/\S+$/i.test(input.loginUrl)) throw new UserInputError("The login URL must start with https://")
  if (input.username && input.username.length > 200) throw new UserInputError("Username is too long.")
  if (input.notes && input.notes.length > 2000) throw new UserInputError("Notes are too long.")
  if (input.vaultItemRef && input.vaultItemRef.length > 500) throw new UserInputError("Reference is too long.")
  for (const [field, value] of [["Notes", input.notes], ["Username", input.username], ["Login URL", input.loginUrl], ["Reference", input.vaultItemRef], ["Name", input.name]] as const) {
    const reason = secretReason(value)
    if (reason) throw new UserInputError(`${field} looks like it contains a secret (${reason}). Enter the password in the Password field: it is stored encrypted.`)
  }
  if (!ACCESS_LEVELS.includes(input.accessLevel)) throw new UserInputError("Choose an access level.")
  const org = user.organizationId
  if (input.departmentId && !(await db.department.findFirst({ where: { id: input.departmentId, organizationId: org } }))) throw new UserInputError("Department not found.")
  if (input.categoryId && !(await db.vaultCategory.findFirst({ where: { id: input.categoryId, organizationId: org } }))) throw new UserInputError("Category not found.")
  if (input.responsibleEmployeeId && !(await db.employee.findFirst({ where: { id: input.responsibleEmployeeId, organizationId: org } }))) throw new UserInputError("Employee not found.")
  return name
}

const data = (input: CredentialInput, name: string) => ({
  name,
  loginUrl: input.loginUrl || null,
  username: input.username?.trim() || null,
  departmentId: input.departmentId,
  categoryId: input.categoryId,
  accessLevel: input.accessLevel,
  notes: input.notes?.trim() || null,
  ...(input.responsibleEmployeeId !== undefined ? { responsibleEmployeeId: input.responsibleEmployeeId } : {}),
  ...(input.vaultProvider !== undefined ? { vaultProvider: input.vaultProvider } : {}),
  ...(input.vaultItemRef !== undefined ? { vaultItemRef: input.vaultItemRef?.trim() || null } : {}),
})

export async function createCredential(user: SessionUser, input: CredentialInput, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can add entries.")
  return inTx(db, async (tx) => {
    const name = await validate(tx, user, input)
    const created = await tx.vaultCredential.create({ data: { ...data(input, name), organizationId: user.organizationId, createdById: user.id, updatedById: user.id } })
    await audit(tx, user, "vault.create", ENTITY, created.id, { name, accessLevel: input.accessLevel })
    return created
  })
}

export async function updateCredential(user: SessionUser, id: string, input: CredentialInput, db: Db = prisma) {
  return inTx(db, async (tx) => {
    const { credential, canEdit } = await access(tx, user, id)
    if (!canEdit) throw new UserInputError("You can view this entry but not edit it.")
    const name = await validate(tx, user, input)
    const next = data(input, name)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => (credential[k] ?? null) !== (next[k] ?? null))
    await tx.vaultCredential.update({ where: { id }, data: { ...next, updatedById: user.id } })
    await audit(tx, user, "vault.update", ENTITY, id, { changed })
  })
}

export async function setArchived(user: SessionUser, id: string, archived: boolean, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can archive entries.")
  return inTx(db, async (tx) => {
    await access(tx, user, id)
    await tx.vaultCredential.update({ where: { id }, data: { archivedAt: archived ? new Date() : null, updatedById: user.id } })
    await audit(tx, user, archived ? "vault.archive" : "vault.restore", ENTITY, id)
  })
}

/** Records a sensitive action on an entry the user can see (view, copy username, open login page). */
export async function recordAccess(user: SessionUser, id: string, action: "view" | "copy_username" | "open_login", db: Db = prisma) {
  return inTx(db, async (tx) => {
    await access(tx, user, id)
    await audit(tx, user, `vault.${action}`, ENTITY, id)
  })
}

// ── Sharing ──

export async function listShares(user: SessionUser, id: string, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can see who an entry is shared with.")
  await access(db, user, id)
  const grants = await db.vaultCredentialGrant.findMany({ where: { credentialId: id, revokedAt: null }, include: { user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: "asc" } })
  return grants.map((g) => ({ id: g.id, userId: g.userId, user: g.user.displayName ?? g.user.email, level: g.level }))
}

export async function shareCredential(user: SessionUser, id: string, userId: string, level: VaultGrantLevel, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can share entries.")
  if (level !== "VIEW" && level !== "EDIT") throw new UserInputError("Choose view or edit.")
  return inTx(db, async (tx) => {
    await access(tx, user, id)
    const member = await tx.userRoleAssignment.findFirst({ where: { userId, organizationId: user.organizationId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }], user: { status: "ACTIVE" } } })
    if (!member) throw new UserInputError("That user has no active access to this company.")
    const existing = await tx.vaultCredentialGrant.findFirst({ where: { credentialId: id, userId, revokedAt: null } })
    if (existing) {
      if (existing.level === level) return
      await tx.vaultCredentialGrant.update({ where: { id: existing.id }, data: { revokedAt: new Date() } })
    }
    await tx.vaultCredentialGrant.create({ data: { credentialId: id, userId, level, grantedById: user.id } })
    await audit(tx, user, "vault.share", ENTITY, id, { userId, level })
  })
}

export async function unshareCredential(user: SessionUser, grantId: string, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can change sharing.")
  return inTx(db, async (tx) => {
    const grant = await tx.vaultCredentialGrant.findFirst({ where: { id: grantId, revokedAt: null, credential: { organizationId: user.organizationId } } })
    if (!grant) throw new UserInputError("Share not found.")
    await tx.vaultCredentialGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } })
    await audit(tx, user, "vault.unshare", ENTITY, grant.credentialId, { userId: grant.userId })
  })
}

/** Users who can be given access: active members of the organization. */
export async function shareCandidates(user: SessionUser, db: Db = prisma) {
  if (!manages(user)) return []
  const rows = await db.appUser.findMany({
    where: { status: "ACTIVE", roleAssignments: { some: { organizationId: user.organizationId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] } } },
    select: { id: true, email: true, displayName: true },
    orderBy: { email: "asc" },
  })
  return rows.map((u) => ({ id: u.id, label: u.displayName ? `${u.displayName} · ${u.email}` : u.email }))
}

/** Change and access history of one entry (vault:audit). */
export async function credentialHistory(user: SessionUser, id: string, db: Db = prisma) {
  if (!user.permissions.has("vault:audit")) throw new UserInputError("You do not have permission to see access history.")
  await access(db, user, id)
  const rows = await db.auditLog.findMany({
    where: { organizationId: user.organizationId, entityType: ENTITY, entityId: id },
    include: { actor: { select: { email: true } } },
    orderBy: { occurredAt: "desc" },
    take: 200,
  })
  return rows.map((r) => ({ at: r.occurredAt.toISOString(), action: r.action.replace("vault.", ""), actor: r.actor?.email ?? "system", details: r.after }))
}

// ── Categories ──

export function listVaultCategories(user: SessionUser, db: Db = prisma) {
  return db.vaultCategory.findMany({ where: { organizationId: user.organizationId, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } })
}

export async function createVaultCategory(user: SessionUser, name: string, db: Db = prisma) {
  if (!manages(user)) throw new UserInputError("Only vault managers can add categories.")
  const clean = name.trim()
  if (!clean || clean.length > 80) throw new UserInputError("Enter a category name.")
  return inTx(db, async (tx) => {
    const code = await uniqueCode(clean, async (c) => Boolean(await tx.vaultCategory.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code: c } } })))
    const category = await tx.vaultCategory.create({ data: { organizationId: user.organizationId, code, name: clean, sortOrder: 500 } })
    await audit(tx, user, "vault.category_create", "vault_category", category.id, { name: clean })
    return category
  })
}
