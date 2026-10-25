import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"

/*
 * How far the books are set up, for the AI CFO onboarding state: which records exist (counts only)
 * and where in Finance OS each one is entered. Read-only.
 */

export type SetupStep = { key: "accounts" | "departments" | "clients" | "transactions" | "payroll" | "budgets" | "targets"; done: boolean; count: number; href: string }

export async function booksStatus(user: SessionUser, db: Db = prisma) {
  const org = user.organizationId
  const [row] = await db.$queryRaw<{ accounts: number; departments: number; clients: number; posted: number; drafts: number; payroll: number; budgets: number; targets: number; first: Date | null; last: Date | null }[]>`
    SELECT
      (SELECT count(*) FROM financial_accounts WHERE organization_id = ${org}::uuid AND closed_at IS NULL)::int AS accounts,
      (SELECT count(*) FROM departments WHERE organization_id = ${org}::uuid AND archived_at IS NULL)::int AS departments,
      (SELECT count(*) FROM clients WHERE organization_id = ${org}::uuid AND archived_at IS NULL)::int AS clients,
      (SELECT count(*) FROM journal_entries WHERE organization_id = ${org}::uuid AND status::text IN ('POSTED', 'REVERSED'))::int AS posted,
      (SELECT count(*) FROM transactions WHERE organization_id = ${org}::uuid AND status::text = 'DRAFT')::int AS drafts,
      (SELECT count(*) FROM payroll_runs WHERE organization_id = ${org}::uuid AND status::text <> 'CANCELLED')::int AS payroll,
      (SELECT count(*) FROM budget_lines WHERE organization_id = ${org}::uuid)::int AS budgets,
      (SELECT count(*) FROM financial_targets WHERE organization_id = ${org}::uuid
        AND coalesce(net_profit_monthly, revenue_monthly, ebitda_margin_pct, cash_reserve_months) IS NOT NULL)::int AS targets,
      (SELECT min(entry_date) FROM journal_entries WHERE organization_id = ${org}::uuid AND status::text IN ('POSTED', 'REVERSED')) AS first,
      (SELECT max(entry_date) FROM journal_entries WHERE organization_id = ${org}::uuid AND status::text IN ('POSTED', 'REVERSED')) AS last`
  const steps: SetupStep[] = [
    { key: "accounts", done: row.accounts > 0, count: row.accounts, href: "/accounts" },
    { key: "departments", done: row.departments > 0, count: row.departments, href: "/departments" },
    { key: "clients", done: row.clients > 0, count: row.clients, href: "/payroll" },
    { key: "transactions", done: row.posted > 0, count: row.posted, href: "/transactions" },
    { key: "payroll", done: row.payroll > 0, count: row.payroll, href: "/payroll" },
    { key: "budgets", done: row.budgets > 0, count: row.budgets, href: "/ai-cfo#plans" },
    { key: "targets", done: row.targets > 0, count: row.targets, href: "/ai-cfo#targets" },
  ]
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)
  return { empty: row.posted === 0, postedEntries: row.posted, draftTransactions: row.drafts, firstEntry: iso(row.first), lastEntry: iso(row.last), steps }
}

/** One line for the AI context: what exists in the books and what is missing (counts only). */
export function booksContext(status: Awaited<ReturnType<typeof booksStatus>>) {
  if (status.empty) {
    const missing = status.steps.filter((s) => !s.done).map((s) => `${s.key} (${s.href})`)
    return `The books have no posted entries yet${status.draftTransactions ? ` (${status.draftTransactions} draft transactions are waiting to be posted at /transactions?status=DRAFT)` : ""}. There are no figures to analyze: do not present zeros as results. Help the user get started and link the pages to fill in: ${missing.join(", ")}.`
  }
  const missing = status.steps.filter((s) => !s.done).map((s) => `${s.key} (${s.href})`)
  return `Posted entries from ${status.firstEntry} to ${status.lastEntry}.${missing.length ? ` Not set up yet: ${missing.join(", ")}.` : ""}${status.draftTransactions ? ` ${status.draftTransactions} draft transactions are not posted yet (/transactions?status=DRAFT).` : ""}`
}
