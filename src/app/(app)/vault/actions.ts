"use server"

import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"

import { getSession } from "@/lib/auth/session"
import { AuthorizationError } from "@/lib/authz/server"
import {
  ACCESS_LEVELS,
  createVaultCategory,
  credentialHistory,
  listShares,
  recordAccess,
  setArchived,
  shareCredential,
  unshareCredential,
  type CredentialInput,
} from "@/lib/data/vault"
import { deleteVaultSecret, revealVaultSecret, rotateVaultKeys, saveCredentialWithPassword, setVaultSecret } from "@/lib/data/vault-secrets"
import { prisma } from "@/lib/data/db"
import { toActionError, UserInputError } from "@/lib/forms"
import { getSupabaseEnv } from "@/lib/supabase/env"
import { issueUnlockToken, UNLOCK_COOKIE, UNLOCK_SECONDS, vaultConfigured, verifyUnlockToken } from "@/lib/vault/secrets"

const UUID = /^[0-9a-f-]{36}$/i
type Ok<T = object> = ({ ok: true } & T) | { ok: false; message: string }

async function user() {
  const session = await getSession()
  if (session.state !== "ok") throw new AuthorizationError("Your session has expired. Sign in again.")
  return session.user
}
const fail = (e: unknown) => ({ ok: false as const, message: toActionError(e).message ?? "Error" })
const done = () => {
  revalidatePath("/vault")
  return { ok: true as const }
}

export type CredentialForm = { name: string; loginUrl: string; username: string; departmentId: string; categoryId: string; accessLevel: string; notes: string }

function parse(form: CredentialForm): CredentialInput {
  const id = (v: string) => (UUID.test(v) ? v : null)
  if (!ACCESS_LEVELS.includes(form.accessLevel as (typeof ACCESS_LEVELS)[number])) throw new UserInputError("Choose an access level.")
  return {
    name: form.name ?? "",
    loginUrl: form.loginUrl?.trim() || null,
    username: form.username?.trim() || null,
    departmentId: id(form.departmentId),
    categoryId: id(form.categoryId),
    accessLevel: form.accessLevel as CredentialInput["accessLevel"],
    notes: form.notes?.trim() || null,
  }
}

/** Saves an entry; a non-empty `password` is encrypted server-side in the same transaction (never logged). */
export async function saveCredentialAction(id: string | null, form: CredentialForm, password?: string | null): Promise<Ok> {
  try {
    const u = await user()
    if (id !== null && !UUID.test(id)) throw new UserInputError("Entry not found.")
    if (password !== undefined && password !== null && (typeof password !== "string" || password.length > 4000)) throw new UserInputError("The password is too long.")
    await saveCredentialWithPassword(u, id, parse(form), password || null)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function archiveCredentialAction(id: string, archived: boolean): Promise<Ok> {
  try {
    await setArchived(await user(), id, archived)
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Logs a view / username copy / login-page open. The username itself is already on the client. */
export async function recordAccessAction(id: string, action: "view" | "copy_username" | "open_login"): Promise<Ok> {
  try {
    if (!["view", "copy_username", "open_login"].includes(action)) throw new UserInputError("Unknown action.")
    await recordAccess(await user(), id, action)
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function sharesAction(id: string): Promise<Ok<{ shares: Awaited<ReturnType<typeof listShares>> }>> {
  try {
    return { ok: true, shares: await listShares(await user(), id) }
  } catch (e) {
    return fail(e)
  }
}

export async function shareAction(id: string, userId: string, level: string): Promise<Ok> {
  try {
    if (!UUID.test(userId)) throw new UserInputError("Choose a user.")
    await shareCredential(await user(), id, userId, level === "EDIT" ? "EDIT" : "VIEW")
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function unshareAction(grantId: string): Promise<Ok> {
  try {
    await unshareCredential(await user(), grantId)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function historyAction(id: string): Promise<Ok<{ history: Awaited<ReturnType<typeof credentialHistory>> }>> {
  try {
    return { ok: true, history: await credentialHistory(await user(), id) }
  } catch (e) {
    return fail(e)
  }
}

export async function createCategoryAction(name: string): Promise<Ok> {
  try {
    await createVaultCategory(await user(), name)
    return done()
  } catch (e) {
    return fail(e)
  }
}

// ── Stored passwords (Super Admin only; viewing/copying needs a fresh password check) ──

export async function unlockVaultAction(password: string): Promise<Ok<{ expiresIn: number }>> {
  try {
    const u = await user()
    if (!u.isSuperAdmin) throw new UserInputError("Only the Super Admin can view stored passwords.")
    if (!vaultConfigured()) throw new UserInputError("Password storage is not configured: VAULT_ENCRYPTION_KEYS is missing on the server.")
    if (typeof password !== "string" || !password || password.length > 500) throw new UserInputError("Enter your password.")
    // Re-check the account password with Supabase in a throwaway, non-persisting client, then end that
    // extra session only (the user's own session is untouched).
    const { url, publishableKey } = getSupabaseEnv()
    const client = createSupabaseClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const { data, error } = await client.auth.signInWithPassword({ email: u.email, password })
    const ok = !error && data.user?.id !== undefined
    if (ok) await client.auth.signOut({ scope: "local" }).catch(() => undefined)
    await prisma.auditLog.create({ data: { organizationId: u.organizationId, actorType: "USER", actorUserId: u.id, action: ok ? "vault.unlock" : "vault.unlock_failed", entityType: "vault", entityId: null } })
    if (!ok) throw new UserInputError("The password is not correct.")
    const store = await cookies()
    store.set(UNLOCK_COOKIE, issueUnlockToken(u.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: UNLOCK_SECONDS })
    return { ok: true, expiresIn: UNLOCK_SECONDS }
  } catch (e) {
    return fail(e)
  }
}

export async function revealSecretAction(id: string, purpose: "view" | "copy"): Promise<Ok<{ secret: string }> | { ok: false; message: string; needsUnlock: true }> {
  try {
    if (!UUID.test(id)) throw new UserInputError("Entry not found.")
    const u = await user()
    const unlocked = verifyUnlockToken((await cookies()).get(UNLOCK_COOKIE)?.value, u.id)
    if (!unlocked) return { ok: false, message: "FRESH_AUTH_REQUIRED", needsUnlock: true }
    const secret = await revealVaultSecret(u, id, { unlocked, purpose: purpose === "copy" ? "copy" : "view" })
    return { ok: true, secret }
  } catch (e) {
    return fail(e)
  }
}

export async function setSecretAction(id: string, password: string): Promise<Ok> {
  try {
    if (!UUID.test(id)) throw new UserInputError("Entry not found.")
    await setVaultSecret(await user(), id, password)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function deleteSecretAction(id: string): Promise<Ok> {
  try {
    if (!UUID.test(id)) throw new UserInputError("Entry not found.")
    await deleteVaultSecret(await user(), id)
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function rotateVaultKeysAction(): Promise<Ok<{ rotated: number }>> {
  try {
    const r = await rotateVaultKeys(await user())
    done()
    return { ok: true, rotated: r.rotated }
  } catch (e) {
    return fail(e)
  }
}
