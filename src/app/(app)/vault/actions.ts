"use server"

import { revalidatePath } from "next/cache"

import { getSession } from "@/lib/auth/session"
import { AuthorizationError } from "@/lib/authz/server"
import {
  ACCESS_LEVELS,
  createCredential,
  createVaultCategory,
  credentialHistory,
  listShares,
  PROVIDERS,
  recordAccess,
  setArchived,
  shareCredential,
  unshareCredential,
  updateCredential,
  type CredentialInput,
} from "@/lib/data/vault"
import { toActionError, UserInputError } from "@/lib/forms"

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

export type CredentialForm = Record<keyof CredentialInput, string>

function parse(form: CredentialForm): CredentialInput {
  const id = (v: string) => (UUID.test(v) ? v : null)
  if (!ACCESS_LEVELS.includes(form.accessLevel as (typeof ACCESS_LEVELS)[number])) throw new UserInputError("Choose an access level.")
  return {
    name: form.name ?? "",
    loginUrl: form.loginUrl?.trim() || null,
    username: form.username?.trim() || null,
    departmentId: id(form.departmentId),
    categoryId: id(form.categoryId),
    responsibleEmployeeId: id(form.responsibleEmployeeId),
    accessLevel: form.accessLevel as CredentialInput["accessLevel"],
    vaultProvider: PROVIDERS.includes(form.vaultProvider as (typeof PROVIDERS)[number]) ? (form.vaultProvider as CredentialInput["vaultProvider"]) : null,
    vaultItemRef: form.vaultItemRef?.trim() || null,
    notes: form.notes?.trim() || null,
  }
}

export async function saveCredentialAction(id: string | null, form: CredentialForm): Promise<Ok> {
  try {
    const u = await user()
    if (id) await updateCredential(u, id, parse(form))
    else await createCredential(u, parse(form))
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
