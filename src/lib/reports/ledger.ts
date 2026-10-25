import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"

import { isoDate, monthsOf, previous, range, yearAgo, type Range } from "./periods"
import { buildBalanceSheet, buildCashFlow, buildPnl, netIncome, type AccountActivity, type EntryLine } from "./statements"

/*
 * Ledger queries behind every report. Only posted journal entries count (status POSTED, plus REVERSED
 * originals whose reversing entries are also posted, so a reversal nets to zero). Filters apply to the
 * reporting dimensions stored on journal lines.
 */

export type ReportFilters = { departmentId?: string | null; clientId?: string | null; projectId?: string | null }

const POSTED = ["POSTED", "REVERSED"]

export function requireReports(user: SessionUser) {
  if (!user.permissions.has("reports:read")) throw new UserInputError("You do not have permission to view financial reports.")
}

type ActivityRow = { account_id: string; code: string; name: string; type: AccountActivity["type"]; subtype: string; cash_flow_activity: string; debit: string; credit: string }

/** Debit/credit per ledger account for entries dated within [from, to] (from = null: since the beginning). */
export async function accountActivity(db: Db, organizationId: string, from: Date | null, to: Date, filters: ReportFilters = {}): Promise<AccountActivity[]> {
  const rows = await db.$queryRaw<ActivityRow[]>`
    SELECT a.id AS account_id, a.code, a.name, a.type::text AS type, a.subtype::text AS subtype, a.cash_flow_activity::text AS cash_flow_activity,
           coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${organizationId}::uuid
      AND e.status::text = ANY(${POSTED})
      AND e.entry_date <= ${isoDate(to)}::date
      AND (${from ? isoDate(from) : null}::date IS NULL OR e.entry_date >= ${from ? isoDate(from) : null}::date)
      AND (${filters.departmentId ?? null}::uuid IS NULL OR l.department_id = ${filters.departmentId ?? null}::uuid)
      AND (${filters.clientId ?? null}::uuid IS NULL OR l.client_id = ${filters.clientId ?? null}::uuid)
      AND (${filters.projectId ?? null}::uuid IS NULL OR l.project_id = ${filters.projectId ?? null}::uuid)
    GROUP BY a.id`
  return rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, cashFlowActivity: r.cash_flow_activity, debit: r.debit, credit: r.credit }))
}

/** Same as accountActivity, split by calendar month of the entry date (for monthly series). */
export async function monthlyActivity(db: Db, organizationId: string, year: number, filters: ReportFilters = {}) {
  const rows = await db.$queryRaw<(ActivityRow & { month: number })[]>`
    SELECT extract(month FROM e.entry_date)::int AS month, a.id AS account_id, a.code, a.name, a.type::text AS type, a.subtype::text AS subtype,
           a.cash_flow_activity::text AS cash_flow_activity, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${organizationId}::uuid AND e.status::text = ANY(${POSTED})
      AND e.entry_date BETWEEN ${`${year}-01-01`}::date AND ${`${year}-12-31`}::date
      AND (${filters.departmentId ?? null}::uuid IS NULL OR l.department_id = ${filters.departmentId ?? null}::uuid)
      AND (${filters.clientId ?? null}::uuid IS NULL OR l.client_id = ${filters.clientId ?? null}::uuid)
    GROUP BY 1, a.id`
  const byMonth = new Map<number, AccountActivity[]>()
  for (const r of rows) {
    const list = byMonth.get(r.month) ?? []
    list.push({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, cashFlowActivity: r.cash_flow_activity, debit: r.debit, credit: r.credit })
    byMonth.set(r.month, list)
  }
  return byMonth
}

/** Every posted entry in [from, to] that touches a cash account, with all of its lines. */
export async function cashEntries(db: Db, organizationId: string, from: Date, to: Date) {
  const rows = await db.$queryRaw<{ entry_id: string; account_id: string; type: EntryLine["type"]; subtype: string; debit: string; credit: string }[]>`
    SELECT l.journal_entry_id AS entry_id, a.id AS account_id, a.type::text AS type, a.subtype::text AS subtype, l.debit::text AS debit, l.credit::text AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${organizationId}::uuid AND e.status::text = ANY(${POSTED})
      AND e.entry_date BETWEEN ${isoDate(from)}::date AND ${isoDate(to)}::date
      AND EXISTS (
        SELECT 1 FROM journal_lines cl JOIN ledger_accounts ca ON ca.id = cl.ledger_account_id
        WHERE cl.journal_entry_id = e.id AND ca.type = 'ASSET' AND ca.subtype = 'CASH'
      )`
  const entries = new Map<string, EntryLine[]>()
  for (const r of rows) {
    const lines = entries.get(r.entry_id) ?? []
    lines.push({ accountId: r.account_id, type: r.type, subtype: r.subtype, debit: r.debit, credit: r.credit })
    entries.set(r.entry_id, lines)
  }
  return [...entries.values()].map((lines) => ({ lines }))
}

/** Like cashEntries for a longer span, grouped by calendar month ("YYYY-MM"): one query instead of one per month. */
export async function cashEntriesByMonth(db: Db, organizationId: string, from: Date, to: Date) {
  const rows = await db.$queryRaw<{ entry_id: string; ym: string; account_id: string; type: EntryLine["type"]; subtype: string; debit: string; credit: string }[]>`
    SELECT l.journal_entry_id AS entry_id, to_char(e.entry_date, 'YYYY-MM') AS ym, a.id AS account_id, a.type::text AS type, a.subtype::text AS subtype, l.debit::text AS debit, l.credit::text AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${organizationId}::uuid AND e.status::text = ANY(${POSTED})
      AND e.entry_date BETWEEN ${isoDate(from)}::date AND ${isoDate(to)}::date
      AND EXISTS (
        SELECT 1 FROM journal_lines cl JOIN ledger_accounts ca ON ca.id = cl.ledger_account_id
        WHERE cl.journal_entry_id = e.id AND ca.type = 'ASSET' AND ca.subtype = 'CASH'
      )`
  const byMonth = new Map<string, Map<string, EntryLine[]>>()
  for (const r of rows) {
    const entries = byMonth.get(r.ym) ?? new Map<string, EntryLine[]>()
    const lines = entries.get(r.entry_id) ?? []
    lines.push({ accountId: r.account_id, type: r.type, subtype: r.subtype, debit: r.debit, credit: r.credit })
    entries.set(r.entry_id, lines)
    byMonth.set(r.ym, entries)
  }
  return (key: string) => [...(byMonth.get(key)?.values() ?? [])].map((lines) => ({ lines }))
}

/** Total of all cash accounts at the end of a date (inclusive). */
export async function cashBalance(db: Db, organizationId: string, asOf: Date) {
  const [row] = await db.$queryRaw<{ v: string | null }[]>`
    SELECT (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::text AS v
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${organizationId}::uuid AND e.status::text = ANY(${POSTED})
      AND e.entry_date <= ${isoDate(asOf)}::date AND a.type = 'ASSET' AND a.subtype = 'CASH'`
  return new Decimal(row?.v ?? 0).toString()
}

export async function cashAccountIds(db: Db, organizationId: string) {
  const accounts = await db.ledgerAccount.findMany({ where: { organizationId, type: "ASSET", subtype: "CASH" }, select: { id: true } })
  return new Set(accounts.map((a) => a.id))
}

const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000)

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

export async function pnlReport(user: SessionUser, r: Range, filters: ReportFilters = {}, db: Db = prisma) {
  requireReports(user)
  const [current, prev, lastYear] = [
    buildPnl(await accountActivity(db, user.organizationId, r.from, r.to, filters)),
    buildPnl(await accountActivity(db, user.organizationId, previous(r).from, previous(r).to, filters)),
    buildPnl(await accountActivity(db, user.organizationId, yearAgo(r).from, yearAgo(r).to, filters)),
  ]
  return { range: r, current, previous: prev, yearAgo: lastYear }
}

export async function cashFlowReport(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const opening = await cashBalance(db, user.organizationId, dayBefore(r.from))
  const cashIds = await cashAccountIds(db, user.organizationId)
  const flow = buildCashFlow(opening, await cashEntries(db, user.organizationId, r.from, r.to), (id) => cashIds.has(id))
  // Reconciliation: the statement's closing cash must equal the real balance of the cash accounts.
  const actualClosing = await cashBalance(db, user.organizationId, r.to)
  const reconciled = new Decimal(flow.closingCash).eq(actualClosing)
  return { range: r, flow, actualClosing, reconciled }
}

export async function balanceSheetReport(user: SessionUser, asOf: Date, db: Db = prisma) {
  requireReports(user)
  const org = await db.organization.findUniqueOrThrow({ where: { id: user.organizationId } })
  const start = org.fiscalYearStartMonth
  const fyYear = asOf.getUTCMonth() + 1 >= start ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1
  const fyStart = new Date(Date.UTC(fyYear, start - 1, 1))
  const cumulative = await accountActivity(db, user.organizationId, null, asOf)
  const currentYear = await accountActivity(db, user.organizationId, fyStart, asOf)
  return { asOf, fiscalYearStart: fyStart, sheet: buildBalanceSheet(cumulative, currentYear) }
}

/** P&L and cash for each month of a year: the basis of monthly analytics, trends and the dashboard. */
export async function monthlySeries(user: SessionUser, year: number, filters: ReportFilters = {}, db: Db = prisma) {
  requireReports(user)
  const activity = await monthlyActivity(db, user.organizationId, year, filters)
  const cashIds = await cashAccountIds(db, user.organizationId)
  const months = monthsOf(year)
  let opening = await cashBalance(db, user.organizationId, dayBefore(months[0].from))
  const entriesOf = await cashEntriesByMonth(db, user.organizationId, months[0].from, months[months.length - 1].to)
  const out = []
  for (const m of months) {
    const pnl = buildPnl(activity.get(m.index) ?? [])
    const flow = buildCashFlow(opening, entriesOf(m.key), (id) => cashIds.has(id))
    out.push({ month: m.index, key: m.key, pnl, flow })
    // Closing balance of one month is the opening balance of the next.
    opening = flow.closingCash
  }
  return out
}

/** Journal lines behind a report line (drill-down). */
export async function drillDown(user: SessionUser, accountId: string, r: Range, filters: ReportFilters = {}, db: Db = prisma) {
  requireReports(user)
  const lines = await db.journalLine.findMany({
    where: {
      ledgerAccountId: accountId,
      ledgerAccount: { organizationId: user.organizationId },
      journalEntry: { status: { in: ["POSTED", "REVERSED"] }, entryDate: { gte: r.from, lte: r.to } },
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
    },
    include: {
      journalEntry: { select: { entryNumber: true, entryDate: true, description: true, source: true, status: true } },
      department: { select: { name: true } },
      client: { select: { name: true } },
      project: { select: { name: true } },
      employee: { select: { firstName: true, lastName: true } },
      category: { select: { name: true } },
    },
    orderBy: [{ journalEntry: { entryDate: "asc" } }, { journalEntry: { entryNumber: "asc" } }],
    take: 500,
  })
  return lines.map((l) => ({
    entryNumber: l.journalEntry.entryNumber,
    date: isoDate(l.journalEntry.entryDate),
    description: l.description ? `${l.journalEntry.description} · ${l.description}` : l.journalEntry.description,
    source: l.journalEntry.source,
    status: l.journalEntry.status,
    debit: l.debit.toString(),
    credit: l.credit.toString(),
    department: l.department?.name ?? null,
    client: l.client?.name ?? null,
    project: l.project?.name ?? null,
    employee: l.employee ? `${l.employee.firstName} ${l.employee.lastName}`.trim() : null,
    category: l.category?.name ?? null,
  }))
}

/** Net profit per department for a range (department dimension on journal lines). */
export async function departmentPnl(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const departments = await db.department.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: "asc" } })
  // One grouped query for every department (was one query per department).
  const grouped = await db.$queryRaw<(ActivityRow & { department_id: string })[]>`
    SELECT l.department_id, a.id AS account_id, a.code, a.name, a.type::text AS type, a.subtype::text AS subtype, a.cash_flow_activity::text AS cash_flow_activity,
           coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${user.organizationId}::uuid AND e.status::text = ANY(${POSTED})
      AND e.entry_date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date AND l.department_id IS NOT NULL
    GROUP BY l.department_id, a.id`
  const rows = []
  for (const d of departments) {
    const pnl = buildPnl(grouped.filter((g) => g.department_id === d.id).map((g) => ({ accountId: g.account_id, code: g.code, name: g.name, type: g.type, subtype: g.subtype, cashFlowActivity: g.cash_flow_activity, debit: g.debit, credit: g.credit })))
    if (pnl.revenue === "0" && pnl.totalExpenses === "0") continue
    rows.push({ id: d.id, name: d.name, archived: !!d.archivedAt, pnl })
  }
  return rows
}

export { netIncome, range }
