import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { isoDate, type Range } from "@/lib/reports/periods"

/*
 * Common shape of every AI CFO tool result: what period and currency the numbers are for, which
 * internal records they come from (with links the user can open), and how complete the data is.
 * The model is told to quote these, never to fill gaps with its own numbers.
 */

export type SourceRef = {
  /** Kind of record: a report, a ledger account, a department, a client, budget lines... */
  kind: "report" | "account" | "department" | "client" | "budget" | "payroll" | "owners" | "transactions" | "forecast"
  label: string
  /** Page in Finance OS where the user can check the figure (drill-down starts there). */
  href: string
  /** Internal id of the record, when there is one. */
  id?: string
}

export type Completeness = {
  /** complete: closed or finished period with posted data; partial: something is still open or missing; no_data: nothing posted. */
  status: "complete" | "partial" | "no_data"
  postedEntries: number
  /** Draft journal entries plus draft transactions dated in the range. */
  draftEntries: number
  /** Month statuses in the range (OPEN, CLOSING, CLOSED, LOCKED; MISSING when the month was never opened). */
  periodStatuses: Record<string, string>
  inProgress: boolean
  notes: string[]
}

export type ToolEnvelope<T> = {
  tool: string
  period: { key: string; from: string; to: string } | { asOf: string }
  currency: string
  values: T
  sources: SourceRef[]
  completeness: Completeness
  /** Statement that marks what kind of numbers these are. */
  nature: "actual" | "budget" | "forecast" | "mixed"
}

const todayUtc = () => new Date(new Date().toISOString().slice(0, 10))

/** Data completeness for a range of the organization's books. */
export async function completeness(user: SessionUser, r: { from: Date; to: Date }, db: Db = prisma, extraNotes: string[] = []): Promise<Completeness> {
  // Drafts: journal entries and transactions entered but not posted (neither reaches the reports).
  const [counts] = await db.$queryRaw<{ posted: number; drafts: number }[]>`
    SELECT
      (SELECT count(*) FROM journal_entries WHERE organization_id = ${user.organizationId}::uuid AND status::text IN ('POSTED', 'REVERSED')
        AND entry_date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date)::int AS posted,
      ((SELECT count(*) FROM journal_entries WHERE organization_id = ${user.organizationId}::uuid AND status::text = 'DRAFT'
        AND entry_date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date)
       + (SELECT count(*) FROM transactions WHERE organization_id = ${user.organizationId}::uuid AND status::text = 'DRAFT'
        AND date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date))::int AS drafts`
  const periods = await db.financialPeriod.findMany({
    where: { organizationId: user.organizationId, startDate: { lte: r.to }, endDate: { gte: r.from } },
    select: { year: true, month: true, status: true },
  })
  const statuses: Record<string, string> = {}
  for (let d = new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), 1)); d <= r.to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    statuses[key] = periods.find((p) => p.year === d.getUTCFullYear() && p.month === d.getUTCMonth() + 1)?.status ?? "MISSING"
  }
  const today = todayUtc()
  const inProgress = r.to >= today
  const future = r.from > today
  const notes = [...extraNotes]
  if (future) notes.push("The period is in the future: there are no actuals yet.")
  else if (inProgress) notes.push("The period is still in progress: figures are to date and will change.")
  if (counts.drafts > 0) notes.push(`${counts.drafts} draft entries or transactions in the period are not included (only posted entries count).`)
  const open = Object.entries(statuses).filter(([, s]) => s === "OPEN" || s === "CLOSING").map(([k]) => k)
  if (open.length) notes.push(`Not closed yet: ${open.join(", ")}. Figures can still change.`)
  if (counts.posted === 0) notes.push("No posted journal entries in the period.")
  const status: Completeness["status"] = counts.posted === 0 ? "no_data" : inProgress || counts.drafts > 0 || open.length > 0 || extraNotes.length > 0 ? "partial" : "complete"
  return { status, postedEntries: counts.posted, draftEntries: counts.drafts, periodStatuses: statuses, inProgress, notes }
}

export function periodOf(r: Range) {
  return { key: r.key, from: isoDate(r.from), to: isoDate(r.to) }
}

/** Links to the pages behind the figures. */
export const href = {
  pnl: (r: Range, dept?: string | null, client?: string | null) => `/pnl?p=${r.key}${dept ? `&dept=${dept}` : ""}${client ? `&client=${client}` : ""}`,
  cashFlow: (r: Range) => `/cash-flow?p=${r.key}`,
  balanceSheet: (date: string) => `/balance-sheet?d=${date}`,
  profitability: (r: Range) => `/profitability?p=${r.key}`,
  budgets: (year: number, scenario = "BASE", dept?: string | null) => `/budgets?year=${year}&scenario=${scenario}${dept ? `&dept=${dept}` : ""}`,
  analytics: (year: number) => `/analytics?year=${year}`,
  payroll: (r: Range) => `/payroll?month=${r.kind === "month" ? r.key : `${r.year}-${String(r.to.getUTCMonth() + 1).padStart(2, "0")}`}`,
  owners: () => `/owners`,
  transactions: () => `/transactions`,
  dashboard: (r: Range) => `/?p=${r.key}`,
}
