import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { monthLabel, type Month } from "@/lib/period"

import { audit, ensurePeriod } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Financial period (month) status, as defined in the schema:
 *  OPEN    — anyone with the right permissions edits the month's records;
 *  CLOSING — under review before closing: only people with period:close may change records;
 *  CLOSED  — no changes (the database refuses them); can be reopened with period:reopen;
 *  LOCKED  — permanently closed (not offered here).
 * Months are never closed automatically. Every change is audited; the database checks the permission
 * of the user recorded as closed_by.
 */

export type PeriodAction = "review" | "close" | "reopen"

export async function periodInfo(user: SessionUser, m: Month, db: Db = prisma) {
  const p = await db.financialPeriod.findUnique({
    where: { organizationId_year_month: { organizationId: user.organizationId, year: m.year, month: m.month } },
    select: { status: true, closedAt: true, closedBy: { select: { email: true } } },
  })
  const drafts = await db.journalEntry.count({ where: { organizationId: user.organizationId, status: "DRAFT", period: { year: m.year, month: m.month } } })
  return { status: p?.status ?? "OPEN", closedAt: p?.closedAt?.toISOString() ?? null, closedBy: p?.closedBy?.email ?? null, draftEntries: drafts }
}

export async function setPeriodStatus(user: SessionUser, m: Month, action: PeriodAction, reason: string | null, db: Db = prisma) {
  const needed = action === "reopen" ? "period:reopen" : "period:close"
  if (!user.permissions.has(needed)) throw new UserInputError(action === "reopen" ? "Reopening a month needs the period:reopen permission." : "Closing a month needs the period:close permission.")
  const why = (reason ?? "").trim().slice(0, 500)
  if (action === "reopen" && why.length < 3) throw new UserInputError("Give a reason for reopening the month.")
  return inTx(db, async (tx) => {
    const period = await ensurePeriod(tx, user.organizationId, m)
    const from = period.status
    if (from === "LOCKED") throw new UserInputError(`${monthLabel(m)} is permanently locked.`)
    const to = action === "review" ? "CLOSING" : action === "close" ? "CLOSED" : "OPEN"
    const allowed = (action === "review" && from === "OPEN") || (action === "close" && (from === "OPEN" || from === "CLOSING")) || (action === "reopen" && (from === "CLOSING" || from === "CLOSED"))
    if (!allowed) throw new UserInputError(`${monthLabel(m)} cannot go from ${from} to ${to}.`)
    if (to === "CLOSED") {
      const drafts = await tx.journalEntry.count({ where: { periodId: period.id, status: "DRAFT" } })
      if (drafts) throw new UserInputError(`${monthLabel(m)} has ${drafts} unposted journal entries. Post or delete them before closing.`)
    }
    await tx.financialPeriod.update({
      where: { id: period.id },
      data: { status: to, closedById: user.id, closedAt: to === "OPEN" ? null : new Date() },
    })
    await audit(tx, user, `period.${action}`, "financial_period", period.id, { month: `${m.year}-${String(m.month).padStart(2, "0")}`, from, to, reason: why || null })
    return { from, to }
  })
}
