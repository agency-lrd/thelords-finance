"use server"

import { getSession } from "@/lib/auth/session"
import { toActionError } from "@/lib/forms"

import { drillDown } from "./ledger"
import { parseRange, range } from "./periods"

const UUID = /^[0-9a-f-]{36}$/i

/** Journal lines behind a report line. Same permission (reports:read) and filters as the report. */
export async function drillDownAction(accountId: string, period: string, filters: { departmentId?: string | null; clientId?: string | null }, asOf?: string) {
  try {
    const session = await getSession()
    if (session.state !== "ok") return { ok: false as const, message: "Sign in again." }
    if (!UUID.test(accountId)) return { ok: false as const, message: "Invalid account." }
    const clean = (v?: string | null) => (v && UUID.test(v) ? v : null)
    let r = parseRange(period, range("month", new Date().getUTCFullYear(), new Date().getUTCMonth() + 1))
    // Balance sheet lines: everything from the beginning up to the date.
    if (asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) r = { ...r, from: new Date("2000-01-01T00:00:00Z"), to: new Date(`${asOf}T00:00:00Z`) }
    const lines = await drillDown(session.user, accountId, r, { departmentId: clean(filters.departmentId), clientId: clean(filters.clientId) })
    return { ok: true as const, lines }
  } catch (error) {
    return { ok: false as const, message: toActionError(error).message ?? "Error" }
  }
}
