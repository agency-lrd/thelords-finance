import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { Decimal } from "@/lib/money"

import { accountActivity, requireReports } from "./ledger"
import { isoDate, type Range } from "./periods"
import { buildPnl } from "./statements"

/*
 * What the reports for a period do NOT include yet, so the owner never mistakes missing input for a
 * real result: payroll months not approved, planned (unconfirmed) income and costs, draft
 * transactions, and confirmed income/costs whose money has not moved yet (affects Cash Flow only).
 */
export async function reportGaps(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const org = user.organizationId
  const months = await db.financialPeriod.findMany({
    where: { organizationId: org, startDate: { gte: r.from, lte: r.to } },
    select: { id: true, year: true, month: true, payrollRuns: { where: { runType: "REGULAR", sequence: 1 }, select: { status: true } }, monthEmployees: { select: { id: true } } },
    orderBy: { startDate: "asc" },
  })
  const payroll = months
    .filter((m) => m.monthEmployees.length > 0 && !["APPROVED", "PAYING", "PAID"].includes(m.payrollRuns[0]?.status ?? "DRAFT"))
    .map((m) => ({ month: `${m.year}-${String(m.month).padStart(2, "0")}`, employees: m.monthEmployees.length }))
  const periodIds = months.map((m) => m.id)
  const sum = (rows: { baseAmount: { toString(): string } }[]) => rows.reduce((a, x) => a.add(new Decimal(x.baseAmount.toString())), new Decimal(0)).toString()
  const [plannedIncome, plannedCosts, drafts, unpaidIncome, unpaidCosts] = [
    await db.projectIncome.findMany({ where: { periodId: { in: periodIds }, journalEntryId: null }, select: { baseAmount: true } }),
    await db.projectCost.findMany({ where: { periodId: { in: periodIds }, journalEntryId: null, status: { not: "CANCELLED" } }, select: { baseAmount: true } }),
    await db.transaction.findMany({ where: { organizationId: org, status: "DRAFT", date: { gte: r.from, lte: r.to } }, select: { baseAmount: true } }),
    await db.projectIncome.findMany({ where: { periodId: { in: periodIds }, journalEntryId: { not: null }, status: { in: ["INVOICED", "PARTIALLY_RECEIVED"] } }, select: { baseAmount: true, amount: true, receivedAmount: true, fxRateToBase: true } }),
    await db.projectCost.findMany({ where: { periodId: { in: periodIds }, journalEntryId: { not: null }, status: "INCURRED" }, select: { baseAmount: true } }),
  ]
  const open = unpaidIncome.reduce((a, i) => a.add(new Decimal(i.amount.toString()).sub(i.receivedAmount.toString()).mul(i.fxRateToBase.toString())), new Decimal(0))
  return {
    payrollNotApproved: payroll,
    plannedIncome: { count: plannedIncome.length, amount: sum(plannedIncome) },
    plannedCosts: { count: plannedCosts.length, amount: sum(plannedCosts) },
    draftTransactions: { count: drafts.length, amount: sum(drafts) },
    incomeNotReceived: { count: unpaidIncome.length, amount: open.toDecimalPlaces(2).toString() },
    costsNotPaid: { count: unpaidCosts.length, amount: sum(unpaidCosts) },
  }
}

/** Department codes of the directions in the gross profit view (Influence, Crypto Marketing, Clipping / UBT). */
export const GROSS_DIRECTIONS = ["INFLULORDS", "MARKETING", "VIRALVERSE"]

/**
 * Gross profit and margin for the core directions only: a clearly labelled filtered view. The
 * company-wide P&L still includes every department.
 */
export async function directionGross(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const departments = await db.department.findMany({ where: { organizationId: user.organizationId, code: { in: GROSS_DIRECTIONS } }, select: { id: true, name: true, code: true } })
  const rows = []
  for (const d of departments.sort((a, b) => GROSS_DIRECTIONS.indexOf(a.code) - GROSS_DIRECTIONS.indexOf(b.code))) {
    const pnl = buildPnl(await accountActivity(db, user.organizationId, r.from, r.to, { departmentId: d.id }))
    rows.push({ id: d.id, name: d.name, revenue: pnl.revenue, directCosts: pnl.sections.costOfServices.total, grossProfit: pnl.grossProfit, margin: pnl.margins.gross })
  }
  const total = rows.reduce((a, x) => ({ revenue: a.revenue.add(x.revenue), directCosts: a.directCosts.add(x.directCosts), grossProfit: a.grossProfit.add(x.grossProfit) }), { revenue: new Decimal(0), directCosts: new Decimal(0), grossProfit: new Decimal(0) })
  return {
    rows,
    total: { revenue: total.revenue.toString(), directCosts: total.directCosts.toString(), grossProfit: total.grossProfit.toString(), margin: total.revenue.isZero() ? null : total.grossProfit.div(total.revenue).mul(100).toFixed(1) },
  }
}

/**
 * Closing balance of each company account at a date (cash accounts, from posted entries). Amounts are
 * in the base currency at the rates of the entries; each account shows its own currency label. No
 * conversion of one currency into another is invented here.
 */
export async function accountBalances(user: SessionUser, asOf: Date, db: Db = prisma) {
  requireReports(user)
  const rows = await db.$queryRaw<{ id: string; name: string; currency: string; type: string; balance: string }[]>`
    SELECT f.id, f.name, f.currency, f.type::text AS type,
           coalesce((SELECT sum(l.debit) - sum(l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                     WHERE l.ledger_account_id = f.ledger_account_id AND e.status::text IN ('POSTED', 'REVERSED') AND e.entry_date <= ${isoDate(asOf)}::date), 0)::text AS balance
    FROM financial_accounts f
    WHERE f.organization_id = ${user.organizationId}::uuid
    ORDER BY f.name`
  return rows
}
