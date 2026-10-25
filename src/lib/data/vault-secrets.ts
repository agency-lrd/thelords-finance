import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { activeKeyId, decryptVaultSecret, encryptVaultSecret, secretAad, vaultConfigured } from "@/lib/vault/secrets"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"
import { createCredential, updateCredential, type CredentialInput } from "./vault"

/*
 * Stored passwords of the credential register. Only the Super Admin may set, view, copy, delete or
 * rotate them; viewing and copying also need a fresh password check (see the vault actions). Audit
 * entries record who did what and when, never the value. Nothing here is used by reports, exports or
 * the AI CFO.
 */

const ENTITY = "vault_credential"

function requireSuperAdmin(user: SessionUser) {
  if (!user.isSuperAdmin) throw new UserInputError("Only the Super Admin can manage stored passwords.")
  if (!vaultConfigured()) throw new UserInputError("Password storage is not configured: VAULT_ENCRYPTION_KEYS is missing on the server.")
}

async function credentialOf(db: Db, user: SessionUser, credentialId: string) {
  const credential = await db.vaultCredential.findFirst({ where: { id: credentialId, organizationId: user.organizationId }, select: { id: true, archivedAt: true } })
  if (!credential) throw new UserInputError("Entry not found.")
  return credential
}

/** Which of the user's visible credentials have a stored password (ids only, never values). */
export async function credentialsWithSecret(user: SessionUser, db: Db = prisma) {
  if (!user.isSuperAdmin) return []
  const rows = await db.vaultSecret.findMany({ where: { organizationId: user.organizationId }, select: { credentialId: true, updatedAt: true } })
  return rows.map((r) => ({ credentialId: r.credentialId, updatedAt: r.updatedAt.toISOString() }))
}

export async function setVaultSecret(user: SessionUser, credentialId: string, password: string, db: Db = prisma) {
  requireSuperAdmin(user)
  if (typeof password !== "string" || password.length === 0) throw new UserInputError("Enter the password.")
  if (password.length > 4000) throw new UserInputError("The password is too long.")
  return inTx(db, async (tx) => {
    const credential = await credentialOf(tx, user, credentialId)
    if (credential.archivedAt) throw new UserInputError("Restore the entry before changing its password.")
    const { keyId, data } = encryptVaultSecret(password, secretAad(user.organizationId, credentialId))
    const existed = !!(await tx.vaultSecret.findUnique({ where: { credentialId }, select: { credentialId: true } }))
    await tx.vaultSecret.upsert({
      where: { credentialId },
      create: { credentialId, organizationId: user.organizationId, keyId, ciphertext: data, updatedById: user.id },
      update: { keyId, ciphertext: data, updatedById: user.id, updatedAt: new Date() },
    })
    await tx.vaultCredential.update({ where: { id: credentialId }, data: { updatedById: user.id } })
    await audit(tx, user, existed ? "vault.secret.update" : "vault.secret.set", ENTITY, credentialId, { keyId })
  })
}

/** Decrypts a stored password for a Super Admin who has just re-confirmed their password (`unlocked`). */
export async function revealVaultSecret(user: SessionUser, credentialId: string, input: { unlocked: boolean; purpose: "view" | "copy" }, db: Db = prisma) {
  requireSuperAdmin(user)
  if (!input.unlocked) throw new UserInputError("FRESH_AUTH_REQUIRED")
  return inTx(db, async (tx) => {
    await credentialOf(tx, user, credentialId)
    const secret = await tx.vaultSecret.findUnique({ where: { credentialId } })
    if (!secret || secret.organizationId !== user.organizationId) throw new UserInputError("No password is stored for this entry.")
    const value = decryptVaultSecret(secret.ciphertext, secret.keyId, secretAad(user.organizationId, credentialId))
    await audit(tx, user, input.purpose === "copy" ? "vault.secret.copy" : "vault.secret.reveal", ENTITY, credentialId)
    return value
  })
}

export async function deleteVaultSecret(user: SessionUser, credentialId: string, db: Db = prisma) {
  requireSuperAdmin(user)
  return inTx(db, async (tx) => {
    await credentialOf(tx, user, credentialId)
    const { count } = await tx.vaultSecret.deleteMany({ where: { credentialId, organizationId: user.organizationId } })
    if (!count) throw new UserInputError("No password is stored for this entry.")
    await audit(tx, user, "vault.secret.delete", ENTITY, credentialId)
  })
}

/** Re-encrypts every stored password with the active key (after adding a new key in front). */
export async function rotateVaultKeys(user: SessionUser, db: Db = prisma) {
  requireSuperAdmin(user)
  const active = activeKeyId()!
  const stale = await db.vaultSecret.findMany({ where: { organizationId: user.organizationId, keyId: { not: active } }, select: { credentialId: true } })
  let rotated = 0
  for (const { credentialId } of stale) {
    await inTx(db, async (tx) => {
      const row = await tx.vaultSecret.findUnique({ where: { credentialId } })
      if (!row || row.keyId === active) return
      const aad = secretAad(user.organizationId, credentialId)
      const { keyId, data } = encryptVaultSecret(decryptVaultSecret(row.ciphertext, row.keyId, aad), aad)
      await tx.vaultSecret.update({ where: { credentialId }, data: { keyId, ciphertext: data } })
      rotated++
    })
  }
  await inTx(db, (tx) => audit(tx, user, "vault.key.rotate", "vault", null, { rotated, activeKeyId: active }))
  return { rotated, activeKeyId: active }
}

/**
 * Saves an entry and, when a password is given, its encrypted password in ONE transaction: either both
 * are stored or neither. An empty password keeps the stored one. Only the Super Admin may set passwords.
 */
export async function saveCredentialWithPassword(user: SessionUser, id: string | null, input: CredentialInput, password: string | null, db: Db = prisma) {
  if (password) requireSuperAdmin(user)
  return inTx(db, async (tx) => {
    const credentialId = id ? (await updateCredential(user, id, input, tx), id) : (await createCredential(user, input, tx)).id
    if (password) await setVaultSecret(user, credentialId, password, tx)
    return credentialId
  })
}
