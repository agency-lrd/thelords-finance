import "server-only"

import type { BudgetScenario } from "@/generated/prisma/client"
import type { SessionUser } from "@/lib/auth/session"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"
import type { Range } from "@/lib/reports/periods"

import { audit } from "./common"
import { inTx, prisma, type Db } from "./db"

/*
 * Budgets, targets and forecast scenarios. One amount per month, scenario and metric (optionally per
 * ledger account, department or project). They are planning numbers only and are always shown
 * separately from actual results, which come from the ledger.
 */

export const BUDGET_METRICS = ["REVENUE", "DIRECT_COSTS", "OPEX", "PAYROLL", "MARKETING", "EBITDA", "NET_PROFIT", "CASH_RESERVE", "ACCOUNT"] as const
export type BudgetMetric = (typeof BUDGET_METRICS)[number]
export const SCENARIOS = ["BASE", "CONSERVATIVE", "AGGRESSIVE"] as const satisfies readonly BudgetScenario[]

const scopeKey = (metric: string, accountId: string | null, departmentId: string | null, projectId: string | null) => `${metric}|${accountId ?? ""}|${departmentId ?? ""}|${projectId ?? ""}`

export async function listBudget(user: SessionUser, year: number, scenario: BudgetScenario = "BASE", db: Db = prisma) {
  const rows = await db.budgetLine.findMany({
    where: { organizationId: user.organizationId, year, scenario },
    include: { ledgerAccount: { select: { code: true, name: true } }, department: { select: { name: true } }, project: { select: { name: true } } },
    orderBy: [{ metric: "asc" }, { month: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    month: r.month,
    metric: r.metric as BudgetMetric,
    ledgerAccountId: r.ledgerAccountId,
    account: r.ledgerAccount ? `${r.ledgerAccount.code} ${r.ledgerAccount.name}` : null,
    departmentId: r.departmentId,
    department: r.department?.name ?? null,
    projectId: r.projectId,
    project: r.project?.name ?? null,
    amount: r.amount.toString(),
  }))
}

/** Sets (or clears with null) one budget cell. */
export async function setBudgetLine(
  user: SessionUser,
  input: { year: number; month: number; scenario: BudgetScenario; metric: BudgetMetric; ledgerAccountId: string | null; departmentId: string | null; projectId: string | null; amount: Decimal | null },
  db: Db = prisma,
) {
  if (!user.permissions.has("ledger:manage")) throw new UserInputError("You do not have permission to edit budgets.")
  if (!BUDGET_METRICS.includes(input.metric)) throw new UserInputError("Unknown budget metric.")
  if (input.month < 1 || input.month > 12 || input.year < 2000 || input.year > 2100) throw new UserInputError("Invalid month.")
  if ((input.metric === "ACCOUNT") !== !!input.ledgerAccountId) throw new UserInputError("Choose an account for an account budget.")
  return inTx(db, async (tx) => {
    if (input.ledgerAccountId && !(await tx.ledgerAccount.findFirst({ where: { id: input.ledgerAccountId, organizationId: user.organizationId } }))) throw new UserInputError("Account not found.")
    if (input.departmentId && !(await tx.department.findFirst({ where: { id: input.departmentId, organizationId: user.organizationId } }))) throw new UserInputError("Department not found.")
    if (input.projectId && !(await tx.project.findFirst({ where: { id: input.projectId, organizationId: user.organizationId } }))) throw new UserInputError("Project not found.")
    const key = scopeKey(input.metric, input.ledgerAccountId, input.departmentId, input.projectId)
    const where = { organizationId_year_month_scenario_scopeKey: { organizationId: user.organizationId, year: input.year, month: input.month, scenario: input.scenario, scopeKey: key } }
    if (input.amount === null) {
      await tx.budgetLine.deleteMany({ where: { organizationId: user.organizationId, year: input.year, month: input.month, scenario: input.scenario, scopeKey: key } })
    } else {
      // Explicit lookup + update/create (instead of upsert): one statement at a time in the transaction.
      const existing = await tx.budgetLine.findUnique({ where })
      if (existing) await tx.budgetLine.update({ where: { id: existing.id }, data: { amount: input.amount.toString() } })
      else
        await tx.budgetLine.create({
          data: { organizationId: user.organizationId, year: input.year, month: input.month, scenario: input.scenario, metric: input.metric, ledgerAccountId: input.ledgerAccountId, departmentId: input.departmentId, projectId: input.projectId, scopeKey: key, amount: input.amount.toString() },
        })
    }
    await audit(tx, user, "budget.set", "budget_line", null, { ...input, amount: input.amount?.toString() ?? null })
  })
}

/** Budget totals for a range: per metric and per ledger account, optionally for one department. */
export async function budgetForRange(user: SessionUser, r: Range, options: { scenario?: BudgetScenario; departmentId?: string | null } = {}, db: Db = prisma) {
  const months: { year: number; month: number }[] = []
  for (let d = new Date(r.from); d <= r.to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  const rows = await db.budgetLine.findMany({
    where: {
      organizationId: user.organizationId,
      scenario: options.scenario ?? "BASE",
      OR: months,
      departmentId: options.departmentId ?? null,
    },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  })
  const metrics = new Map<string, Decimal>()
  const accounts = new Map<string, Decimal>()
  for (const row of rows) {
    if (row.metric === "ACCOUNT" && row.ledgerAccountId) accounts.set(row.ledgerAccountId, (accounts.get(row.ledgerAccountId) ?? new Decimal(0)).add(row.amount.toString()))
    // CASH_RESERVE is a level, not a flow: use the latest month in the range.
    else if (row.metric === "CASH_RESERVE") metrics.set("CASH_RESERVE", new Decimal(row.amount.toString()))
    else metrics.set(row.metric, (metrics.get(row.metric) ?? new Decimal(0)).add(row.amount.toString()))
  }
  return {
    hasAny: rows.length > 0,
    metric: (m: BudgetMetric) => metrics.get(m)?.toString() ?? null,
    account: (id: string) => accounts.get(id)?.toString() ?? null,
  }
}
