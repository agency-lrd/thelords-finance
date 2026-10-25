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
export const HIDDEN_KPIS = ["CLIENT_NPS", "EMPLOYEE_NPS"]
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

  // Employees: DISTINCT people on the month's financial sheet (its roster), by the sheet's own rule:
  // archived people count only in months where they have a payslip. Never all profiles ever created,
  // and never payslips or snapshots counted as separate people.
  const roster = await db.$queryRaw<{ month: number; n: number }[]>`
    SELECT p.month::int AS month, count(DISTINCT m.employee_id)::int AS n
    FROM payroll_month_employees m
    JOIN financial_periods p ON p.id = m.period_id
    JOIN employees e ON e.id = m.employee_id
    WHERE m.organization_id = ${org}::uuid AND p.year = ${year}
      AND (e.archived_at IS NULL OR EXISTS (
        SELECT 1 FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
        WHERE r.period_id = p.id AND r.status <> 'CANCELLED' AND i.employee_id = e.id))
    GROUP BY 1`
  const headcount = new Map(roster.map((r) => [r.month, r.n]))
  const payslips = await db.$queryRaw<{ month: number; n: number; gross: string }[]>`
    SELECT p.month::int AS month, count(DISTINCT i.employee_id)::int AS n, sum(round(i.gross_amount * i.fx_rate_to_base, 8))::text AS gross
    FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id JOIN financial_periods p ON p.id = r.period_id
    WHERE r.organization_id = ${org}::uuid AND p.year = ${year} AND r.status <> 'CANCELLED' AND i.confirmed_at IS NOT NULL
    GROUP BY 1`
  const slips = new Map(payslips.map((p) => [p.month, p]))

  // Manual KPIs (organization scope).
  // NPS scores are no longer shown (no reliable source); their stored values are kept, not deleted.
  const definitions = await db.kpiDefinition.findMany({ where: { organizationId: org, archivedAt: null, code: { notIn: ["PROFIT", ...HIDDEN_KPIS] } }, orderBy: { createdAt: "asc" } })
  const actuals = await db.kpiActual.findMany({ where: { organizationId: org, scope: "ORGANIZATION", period: { year } }, include: { period: { select: { month: true } } } })
  const kpi = (definitionId: string, month: number) => actuals.find((a) => a.kpiDefinitionId === definitionId && a.period.month === month)?.actualValue.toString() ?? null

  const months = series.map((s) => {
    const m = s.month
    const end = new Date(Date.UTC(year, m, 0))
    const index = year * 12 + m
    const marketing = marketingAccount ? (s.pnl.sections.operatingExpenses.lines.find((l) => l.accountId === marketingAccount)?.amount ?? "0") : "0"
    const slip = slips.get(m)
    return {
      month: m,
      clients: clients.filter((c) => c.createdAt <= end).length,
      newClients: [...firstRevenue.values()].filter((v) => v === index).length,
      activeClients: revenueByClient.filter((r) => r.year === year && r.month === m).length,
      employees: headcount.get(m) ?? slip?.n ?? 0,
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

/**
 * One month per department and per team, with the previous month for the change: revenue, direct
 * costs, payroll (approved payroll accrual), gross profit and margin. Department figures come from the
 * ledger (each cost once, on its department); team figures from confirmed team income/costs and the
 * approved payslips of team members, which are part of their department's figures, not extra.
 */
export async function departmentAnalytics(user: SessionUser, m: { year: number; month: number }, db: Db = prisma) {
  requireReports(user)
  const org = user.organizationId
  const prev = m.month === 1 ? { year: m.year - 1, month: 12 } : { year: m.year, month: m.month - 1 }
  const from = `${prev.year}-${String(prev.month).padStart(2, "0")}-01`
  const to = isoDate(new Date(Date.UTC(m.year, m.month, 0)))
  const rows = await db.$queryRaw<{ department_id: string; ym: string; revenue: string; direct: string; payroll: string; opex: string }[]>`
    SELECT l.department_id, to_char(e.entry_date, 'YYYY-MM') AS ym,
      coalesce(sum(CASE WHEN a.subtype = 'OPERATING_REVENUE' THEN l.credit - l.debit END), 0)::text AS revenue,
      coalesce(sum(CASE WHEN a.subtype = 'COST_OF_SALES' THEN l.debit - l.credit END), 0)::text AS direct,
      coalesce(sum(CASE WHEN e.source = 'PAYROLL' AND a.type = 'EXPENSE' THEN l.debit - l.credit END), 0)::text AS payroll,
      coalesce(sum(CASE WHEN a.subtype = 'OPERATING_EXPENSE' THEN l.debit - l.credit END), 0)::text AS opex
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN ledger_accounts a ON a.id = l.ledger_account_id
    WHERE e.organization_id = ${org}::uuid AND e.status::text IN ('POSTED', 'REVERSED') AND l.department_id IS NOT NULL
      AND e.entry_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2`
  const departments = await db.department.findMany({ where: { organizationId: org }, select: { id: true, name: true, archivedAt: true } })
  const key = (x: { year: number; month: number }) => `${x.year}-${String(x.month).padStart(2, "0")}`
  const figures = (id: string, ym: string) => {
    const r = rows.find((x) => x.department_id === id && x.ym === ym)
    const revenue = new Decimal(r?.revenue ?? 0)
    const direct = new Decimal(r?.direct ?? 0)
    const gross = revenue.sub(direct)
    return { revenue: revenue.toString(), direct: direct.toString(), payroll: new Decimal(r?.payroll ?? 0).toString(), opex: new Decimal(r?.opex ?? 0).toString(), gross: gross.toString(), margin: revenue.isZero() ? null : gross.div(revenue).mul(100).toFixed(1) }
  }
  const byDepartment = departments
    .map((d) => ({ id: d.id, name: d.name, current: figures(d.id, key(m)), previous: figures(d.id, key(prev)) }))
    .filter((d) => [d.current, d.previous].some((f) => f.revenue !== "0" || f.direct !== "0" || f.payroll !== "0" || f.opex !== "0"))

  const teams = await db.team.findMany({ where: { department: { organizationId: org } }, include: { department: { select: { name: true } } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
  const teamMonth = async (x: { year: number; month: number }) => {
    const period = { organizationId: org, year: x.year, month: x.month }
    const [income, costs, pay] = [
      await db.projectIncome.groupBy({ by: ["teamId"], where: { period, teamId: { not: null }, journalEntryId: { not: null } }, _sum: { baseAmount: true } }),
      await db.projectCost.groupBy({ by: ["teamId"], where: { period, teamId: { not: null }, journalEntryId: { not: null } }, _sum: { baseAmount: true } }),
      await db.payrollItem.findMany({ where: { teamId: { not: null }, payrollRun: { period, status: { in: ["APPROVED", "PAYING", "PAID"] } } }, select: { teamId: true, baseNetAmount: true } }),
    ]
    return (teamId: string) => {
      const revenue = new Decimal(income.find((i) => i.teamId === teamId)?._sum.baseAmount ?? 0)
      const direct = new Decimal(costs.find((c) => c.teamId === teamId)?._sum.baseAmount ?? 0)
      const payroll = pay.filter((p) => p.teamId === teamId).reduce((a, p) => a.add(new Decimal(p.baseNetAmount)), new Decimal(0))
      const gross = revenue.sub(direct).sub(payroll)
      return { revenue: revenue.toString(), direct: direct.toString(), payroll: payroll.toString(), opex: "0", gross: gross.toString(), margin: revenue.isZero() ? null : gross.div(revenue).mul(100).toFixed(1) }
    }
  }
  const [cur, before] = [await teamMonth(m), await teamMonth(prev)]
  const byTeam = teams
    .map((t) => ({ id: t.id, name: t.name, department: t.department.name, archived: !!t.archivedAt, current: cur(t.id), previous: before(t.id) }))
    .filter((t) => !t.archived || [t.current, t.previous].some((f) => f.revenue !== "0" || f.direct !== "0"))
  return { month: key(m), previous: key(prev), departments: byDepartment, teams: byTeam }
}
