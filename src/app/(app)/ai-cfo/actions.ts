"use server"

import { revalidatePath } from "next/cache"

import { getSession } from "@/lib/auth/session"
import { AuthorizationError } from "@/lib/authz/server"
import { archiveConversation, listConversations, loadConversation } from "@/lib/ai/conversations"
import { archivePlan, savePlan } from "@/lib/data/plans"
import { setTargets } from "@/lib/data/targets"
import { normalizeNumber } from "@/lib/i18n/format"
import { Decimal } from "@/lib/money"
import { parseMonth } from "@/lib/period"
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

// ── Financial plans (planning records only; never change operational data) ──

export type PlanForm = { id: string; name: string; month: string; assumptions: string; revenue: string; directCosts: string; operatingExpenses: string; payroll: string; hiringCost: string; profit: string; cashBalance: string }

export async function savePlanAction(form: PlanForm, fix: boolean) {
  try {
    const u = await user()
    const m = parseMonth(form.month)
    if (!m) throw new UserInputError("Choose the month of the plan.")
    const n = (v: string) => {
      const x = normalizeNumber(v ?? "")
      if (x === "" || x === null) return null
      return new Decimal(x)
    }
    await savePlan(u, {
      id: UUID.test(form.id ?? "") ? form.id : null,
      name: form.name ?? "",
      month: m,
      assumptions: form.assumptions ?? null,
      revenue: n(form.revenue),
      directCosts: n(form.directCosts),
      operatingExpenses: n(form.operatingExpenses),
      payroll: n(form.payroll),
      hiringCost: n(form.hiringCost),
      profit: n(form.profit),
      cashBalance: n(form.cashBalance),
      fix: fix === true,
    })
    revalidatePath("/ai-cfo")
    return { ok: true as const }
  } catch (e) {
    return fail(e)
  }
}

export async function archivePlanAction(id: string, archived: boolean) {
  try {
    if (!UUID.test(id)) throw new UserInputError("Plan not found.")
    await archivePlan(await user(), id, archived === true)
    revalidatePath("/ai-cfo")
    return { ok: true as const }
  } catch (e) {
    return fail(e)
  }
}
