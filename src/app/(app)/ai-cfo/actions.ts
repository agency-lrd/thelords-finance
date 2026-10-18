"use server"

import { revalidatePath } from "next/cache"

import { getSession } from "@/lib/auth/session"
import { AuthorizationError } from "@/lib/authz/server"
import { archiveConversation, listConversations, loadConversation } from "@/lib/ai/conversations"
import { setTargets } from "@/lib/data/targets"
import { toActionError, UserInputError } from "@/lib/forms"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function user() {
  const session = await getSession()
  if (session.state !== "ok") throw new AuthorizationError("Your session has expired. Sign in again.")
  if (!session.user.permissions.has("reports:read")) throw new AuthorizationError("You do not have permission to use the AI CFO.")
  return session.user
}
const fail = (e: unknown) => ({ ok: false as const, message: toActionError(e).message ?? "Error" })
const id = (v: unknown) => {
  if (typeof v !== "string" || !UUID.test(v)) throw new UserInputError("Conversation not found.")
  return v
}

export async function conversationsAction() {
  try {
    return { ok: true as const, conversations: await listConversations(await user()) }
  } catch (e) {
    return fail(e)
  }
}

export async function loadConversationAction(conversationId: string) {
  try {
    return { ok: true as const, conversation: await loadConversation(await user(), id(conversationId)) }
  } catch (e) {
    return fail(e)
  }
}

export async function archiveConversationAction(conversationId: string) {
  try {
    await archiveConversation(await user(), id(conversationId))
    return { ok: true as const }
  } catch (e) {
    return fail(e)
  }
}

/** Saves the organization's targets (ledger:manage; checked and audited in setTargets). */
export async function saveTargetsAction(_prev: { ok: boolean; message: string }, form: FormData) {
  try {
    const v = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : null)
    await setTargets(await user(), { netProfitMonthly: v("netProfitMonthly"), revenueMonthly: v("revenueMonthly"), ebitdaMarginPct: v("ebitdaMarginPct"), cashReserveMonths: v("cashReserveMonths") })
    revalidatePath("/ai-cfo")
    return { ok: true, message: "saved" }
  } catch (e) {
    return fail(e)
  }
}
