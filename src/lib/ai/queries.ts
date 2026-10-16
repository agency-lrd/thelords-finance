import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import { UserInputError } from "@/lib/forms"
import { isoDate, type Range } from "@/lib/reports/periods"

/*
 * Read-only aggregate queries used by the AI CFO tools that have no page-level service yet. All are
 * parameterized, scoped to the user's organization, and return totals only (never individual pay).
 */

const POSTED = ["POSTED", "REVERSED"]

/** Payroll expense (payroll journal entries, expense side) per department for a range. */
export async function payrollExpenseByDepartment(user: SessionUser, r: { from: Date; to: Date }, db: Db = prisma, departmentId: string | null = null) {
  return db.$queryRaw<{ department_id: string | null; department: string | null; cost_of_services: string; operating: string; total: string }[]>`
    SELECT l.department_id, d.name AS department,
      coalesce(sum(CASE WHEN a.subtype = 'COST_OF_SALES' THEN l.debit - l.credit END), 0)::text AS cost_of_services,
      coalesce(sum(CASE WHEN a.subtype <> 'COST_OF_SALES' THEN l.debit - l.credit END), 0)::text AS operating,
      coalesce(sum(l.debit - l.credit), 0)::text AS total
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN ledger_accounts a ON a.id = l.ledger_account_id
    LEFT JOIN departments d ON d.id = l.department_id
    WHERE e.organization_id = ${user.organizationId}::uuid AND e.status::text = ANY(${POSTED}) AND e.source = 'PAYROLL' AND a.type = 'EXPENSE'
      AND e.entry_date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date
      AND (${departmentId}::uuid IS NULL OR l.department_id = ${departmentId}::uuid)
    GROUP BY l.department_id, d.name
    ORDER BY 5 DESC`
}

/** Payroll expense per calendar month ("YYYY-MM") in a date window. */
export async function payrollExpenseByMonth(user: SessionUser, from: Date, to: Date, db: Db = prisma) {
  const rows = await db.$queryRaw<{ key: string; v: string }[]>`
    SELECT to_char(e.entry_date, 'YYYY-MM') AS key, coalesce(sum(l.debit - l.credit), 0)::text AS v
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${user.organizationId}::uuid AND e.status::text = ANY(${POSTED}) AND e.source = 'PAYROLL' AND a.type = 'EXPENSE'
      AND e.entry_date BETWEEN ${isoDate(from)}::date AND ${isoDate(to)}::date
    GROUP BY 1`
  return new Map(rows.map((r) => [r.key, r.v]))
}

/** Headcount and gross pay (base currency) of confirmed payslips per department, for the months of a range. */
export async function payslipTotals(user: SessionUser, r: Range, db: Db = prisma) {
  return db.$queryRaw<{ department_id: string | null; department: string | null; payslips: number; employees: number; gross: string; net: string; employer_cost: string }[]>`
    SELECT i.department_id, d.name AS department, count(*)::int AS payslips, count(DISTINCT i.employee_id)::int AS employees,
      coalesce(sum(round(i.gross_amount * i.fx_rate_to_base, 2)), 0)::text AS gross,
      coalesce(sum(i.base_net_amount), 0)::text AS net,
      coalesce(sum(round(i.employer_cost_amount * i.fx_rate_to_base, 2)), 0)::text AS employer_cost
    FROM payroll_items i
    JOIN payroll_runs pr ON pr.id = i.payroll_run_id
    JOIN financial_periods p ON p.id = pr.period_id
    LEFT JOIN departments d ON d.id = i.department_id
    WHERE pr.organization_id = ${user.organizationId}::uuid AND pr.status::text <> 'CANCELLED' AND i.confirmed_at IS NOT NULL
      AND p.start_date >= ${isoDate(r.from)}::date AND p.end_date <= ${isoDate(r.to)}::date
    GROUP BY i.department_id, d.name
    ORDER BY 6 DESC`
}

/** Balance of ledger accounts of the given subtypes at a date (natural sign). */
export async function subtypeBalance(user: SessionUser, asOf: Date, subtypes: string[], db: Db = prisma) {
  const [row] = await db.$queryRaw<{ v: string }[]>`
    SELECT coalesce(sum(CASE WHEN a.type IN ('ASSET', 'EXPENSE') THEN l.debit - l.credit ELSE l.credit - l.debit END), 0)::text AS v
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${user.organizationId}::uuid AND e.status::text = ANY(${POSTED}) AND e.entry_date <= ${isoDate(asOf)}::date
      AND a.subtype::text = ANY(${subtypes})`
  return row?.v ?? "0"
}

/** Throws unless the department belongs to the user's organization. */
export async function assertDepartment(user: SessionUser, id: string | null | undefined, db: Db = prisma) {
  if (!id) return null
  const d = await db.department.findFirst({ where: { id, organizationId: user.organizationId }, select: { id: true, name: true } })
  if (!d) throw new UserInputError("Department not found in this organization.")
  return d
}

/** Throws unless the client belongs to the user's organization. */
export async function assertClient(user: SessionUser, id: string | null | undefined, db: Db = prisma) {
  if (!id) return null
  const c = await db.client.findFirst({ where: { id, organizationId: user.organizationId }, select: { id: true, name: true } })
  if (!c) throw new UserInputError("Client not found in this organization.")
  return c
}

/** Throws unless the ledger account belongs to the user's organization. */
export async function assertAccount(user: SessionUser, id: string, db: Db = prisma) {
  const a = await db.ledgerAccount.findFirst({ where: { id, organizationId: user.organizationId }, select: { id: true, code: true, name: true, type: true, subtype: true } })
  if (!a) throw new UserInputError("Account not found in this organization.")
  return a
}
