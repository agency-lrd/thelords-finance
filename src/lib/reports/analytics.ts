import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { audit, ensurePeriod } from "@/lib/data/common"
import { inTx, prisma, type Db } from "@/lib/data/db"
import { UserInputError } from "@/lib/forms"
import { Decimal } from "@/lib/money"

import { accountActivity, monthlySeries, requireReports } from "./ledger"
import { isoDate, type Range } from "./periods"
import { buildPnl } from "./statements"

/*
 * Monthly analytics (the team's monthly analytics spreadsheet) and the inputs for the dashboard.
 * Financial rows come from the same ledger series as the statements; client and team counts from
 * clients, journal lines and payroll; NPS, client budgets and custom metrics are entered manually as
 * organization-level KPI actuals.
 */

export const MANUAL_KPIS = ["CLIENT_NPS", "EMPLOYEE_NPS", "MANAGED_BUDGET"] as const
const SYSTEM_KPIS = ["PROFIT", ...MANUAL_KPIS]

type MonthValue = string | null

export async function monthlyAnalytics(user: SessionUser, year: number, db: Db = prisma) {
  requireReports(user)
  const org = user.organizationId
  const series = await monthlySeries(user, year, {}, db)

  // Payroll expense: expense lines of payroll entries (base salaries, bonuses; net of deductions).
  const payrollRows = await db.$queryRaw<{ month: number; v: string }[]>`
    SELECT extract(month FROM e.entry_date)::int AS month, (sum(l.debit) - sum(l.credit))::text AS v
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${org}::uuid AND e.status::text IN ('POSTED', 'REVERSED') AND e.source = 'PAYROLL'
      AND a.type = 'EXPENSE' AND e.entry_date BETWEEN ${`${year}-01-01`}::date AND ${`${year}-12-31`}::date
    GROUP BY 1`
  const payroll = new Map(payrollRows.map((r) => [r.month, r.v]))

  // Marketing: the ledger account of the MARKETING category.
  const marketingCategory = await db.financialCategory.findUnique({ where: { organizationId_code: { organizationId: org, code: "MARKETING" } } })
  const marketingAccount = marketingCategory?.ledgerAccountId ?? null

  // Clients: registered by month end; active = revenue posted for them that month; new = first revenue month.
  const clients = await db.client.findMany({ where: { organizationId: org }, select: { id: true, createdAt: true } })
  const revenueByClient = await db.$queryRaw<{ client_id: string; month: number; year: number }[]>`
    SELECT DISTINCT l.client_id, extract(month FROM e.entry_date)::int AS month, extract(year FROM e.entry_date)::int AS year
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${org}::uuid AND e.status::text IN ('POSTED', 'REVERSED') AND l.client_id IS NOT NULL
      AND a.subtype = 'OPERATING_REVENUE' AND l.credit > 0 AND e.entry_date <= ${`${year}-12-31`}::date`
  const firstRevenue = new Map<string, number>()
  for (const r of revenueByClient) {
    const index = r.year * 12 + r.month
    if (!firstRevenue.has(r.client_id) || firstRevenue.get(r.client_id)! > index) firstRevenue.set(r.client_id, index)
  }

  // Employees: on the payroll that month (confirmed payslips), else employed that month.
  const payslips = await db.$queryRaw<{ month: number; n: number; gross: string }[]>`
    SELECT p.month::int AS month, count(*)::int AS n, sum(round(i.gross_amount * i.fx_rate_to_base, 8))::text AS gross
    FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id JOIN financial_periods p ON p.id = r.period_id
    WHERE r.organization_id = ${org}::uuid AND p.year = ${year} AND r.status <> 'CANCELLED' AND i.confirmed_at IS NOT NULL
    GROUP BY 1`
  const slips = new Map(payslips.map((p) => [p.month, p]))
  const employees = await db.employee.findMany({ where: { organizationId: org }, select: { hireDate: true, terminationDate: true } })

  // Manual KPIs (organization scope).
  const definitions = await db.kpiDefinition.findMany({ where: { organizationId: org, archivedAt: null, code: { not: "PROFIT" } }, orderBy: { createdAt: "asc" } })
  const actuals = await db.kpiActual.findMany({ where: { organizationId: org, scope: "ORGANIZATION", period: { year } }, include: { period: { select: { month: true } } } })
  const kpi = (definitionId: string, month: number) => actuals.find((a) => a.kpiDefinitionId === definitionId && a.period.month === month)?.actualValue.toString() ?? null

  const months = series.map((s) => {
    const m = s.month
    const end = new Date(Date.UTC(year, m, 0))
    const start = new Date(Date.UTC(year, m - 1, 1))
    const index = year * 12 + m
    const marketing = marketingAccount ? (s.pnl.sections.operatingExpenses.lines.find((l) => l.accountId === marketingAccount)?.amount ?? "0") : "0"
    const slip = slips.get(m)
    const employed = employees.filter((e) => e.hireDate <= end && (!e.terminationDate || e.terminationDate >= start)).length
    return {
      month: m,
      clients: clients.filter((c) => c.createdAt <= end).length,
      newClients: [...firstRevenue.values()].filter((v) => v === index).length,
      activeClients: revenueByClient.filter((r) => r.year === year && r.month === m).length,
      employees: slip?.n ?? employed,
      avgSalary: slip && slip.n > 0 ? new Decimal(slip.gross).div(slip.n).toDecimalPlaces(2).toString() : null,
      revenue: s.pnl.revenue,
      grossProfit: s.pnl.grossProfit,
      payroll: payroll.get(m) ?? "0",
      marketing,
      operatingExpenses: s.pnl.operatingExpenses,
      ebitda: s.pnl.ebitda,
      ebit: s.pnl.ebit,
      netProfit: s.pnl.netProfit,
      netMargin: s.pnl.margins.net,
      totalExpenses: s.pnl.totalExpenses,
      costOfServices: s.pnl.costOfServices,
      cashIn: s.flow.inflow,
      cashOut: s.flow.outflow,
      netCash: s.flow.netChange,
      closingCash: s.flow.closingCash,
      manual: Object.fromEntries(definitions.map((d) => [d.code, kpi(d.id, m)])) as Record<string, MonthValue>,
    }
  })
  return {
    year,
    months,
    definitions: definitions.map((d) => ({ id: d.id, code: d.code, name: d.name, unit: d.unit, system: SYSTEM_KPIS.includes(d.code), aggregation: d.aggregation })),
  }
}

/** Manual monthly value for an organization-level KPI (NPS, client budgets, custom metrics). */
export async function setOrganizationKpi(user: SessionUser, code: string, year: number, month: number, value: Decimal | null, db: Db = prisma) {
  if (!user.permissions.has("kpi:manage")) throw new UserInputError("You do not have permission to enter KPIs.")
  return inTx(db, async (tx) => {
    const definition = await tx.kpiDefinition.findUnique({ where: { organizationId_code: { organizationId: user.organizationId, code } } })
    if (!definition || definition.code === "PROFIT") throw new UserInputError("Unknown metric.")
    const period = await ensurePeriod(tx, user.organizationId, { year, month })
    const key = { kpiDefinitionId_periodId_scopeKey: { kpiDefinitionId: definition.id, periodId: period.id, scopeKey: "ORG" } }
    if (value === null) await tx.kpiActual.deleteMany({ where: { kpiDefinitionId: definition.id, periodId: period.id, scopeKey: "ORG" } })
    else
      await tx.kpiActual.upsert({
        where: key,
        create: { organizationId: user.organizationId, kpiDefinitionId: definition.id, periodId: period.id, scope: "ORGANIZATION", scopeKey: "ORG", actualValue: value.toString(), recordedById: user.id },
        update: { actualValue: value.toString(), recordedById: user.id },
      })
    await audit(tx, user, "kpi.set", "kpi_definition", definition.id, { year, month, value: value?.toString() ?? null })
  })
}

/** Adds a custom monthly metric to the analytics table. */
export async function createCustomMetric(user: SessionUser, input: { name: string; unit: "COUNT" | "CURRENCY" | "PERCENT" | "RATIO" }, db: Db = prisma) {
  if (!user.permissions.has("kpi:manage")) throw new UserInputError("You do not have permission to add metrics.")
  const name = input.name.trim()
  if (!name || name.length > 80) throw new UserInputError("Enter a metric name (max 80 characters).")
  return inTx(db, async (tx) => {
    const count = await tx.kpiDefinition.count({ where: { organizationId: user.organizationId } })
    const definition = await tx.kpiDefinition.create({
      data: { organizationId: user.organizationId, code: `CUSTOM-${count + 1}-${Date.now().toString(36)}`, name, unit: input.unit, currency: input.unit === "CURRENCY" ? user.baseCurrency : null, aggregation: "LAST" },
    })
    await audit(tx, user, "kpi.create", "kpi_definition", definition.id, { name, unit: input.unit })
    return definition
  })
}

/** Revenue, direct costs and contribution per client in a range (from journal-line client dimension). */
export async function clientProfitability(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const rows = await db.$queryRaw<{ client_id: string; name: string; revenue: string; direct: string }[]>`
    SELECT c.id AS client_id, c.name,
      coalesce(sum(CASE WHEN a.subtype = 'OPERATING_REVENUE' THEN l.credit - l.debit END), 0)::text AS revenue,
      coalesce(sum(CASE WHEN a.subtype = 'COST_OF_SALES' THEN l.debit - l.credit END), 0)::text AS direct
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    JOIN clients c ON c.id = l.client_id
    WHERE e.organization_id = ${user.organizationId}::uuid AND e.status::text IN ('POSTED', 'REVERSED')
      AND e.entry_date BETWEEN ${isoDate(r.from)}::date AND ${isoDate(r.to)}::date
    GROUP BY c.id, c.name`
  return rows
    .map((x) => ({ id: x.client_id, name: x.name, revenue: x.revenue, direct: x.direct, profit: new Decimal(x.revenue).sub(x.direct).toString() }))
    .sort((a, b) => Number(b.profit) - Number(a.profit))
}

/** Expense lines (accounts) for a range, largest first: the cost structure. */
export async function expenseStructure(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const pnl = buildPnl(await accountActivity(db, user.organizationId, r.from, r.to))
  return [pnl.sections.costOfServices, pnl.sections.operatingExpenses, pnl.sections.depreciation, pnl.sections.amortization, pnl.sections.otherExpense, pnl.sections.incomeTax]
    .flatMap((s) => s.lines)
    .sort((a, b) => Number(b.amount) - Number(a.amount))
}
