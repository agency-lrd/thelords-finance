import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { budgetForRange } from "@/lib/data/budgets"
import { prisma, type Db } from "@/lib/data/db"
import { Decimal } from "@/lib/money"

import { clientProfitability, expenseStructure } from "./analytics"
import { cashForecast, cashIndicators } from "./cash"
import { balanceSheetReport, departmentPnl, monthlySeries, pnlReport, requireReports } from "./ledger"
import { isoDate, type Range } from "./periods"

export type Risk = { key: string; level: "high" | "medium"; value: string | null; href: string }

/** Everything the executive dashboard shows for a period, from the same report functions as the pages. */
export async function executiveDashboard(user: SessionUser, r: Range, db: Db = prisma) {
  requireReports(user)
  const today = new Date(new Date().toISOString().slice(0, 10))
  const asOf = r.to < today ? r.to : today
  const [pnl, indicators, budget, series, departments, clients, expenses, bs, forecast] = await Promise.all([
    pnlReport(user, r, {}, db),
    cashIndicators(user, asOf, db),
    budgetForRange(user, r, {}, db),
    monthlySeries(user, r.year, {}, db),
    departmentPnl(user, r, db),
    clientProfitability(user, r, db),
    expenseStructure(user, r, db),
    balanceSheetReport(user, asOf, db),
    cashForecast(user, today, 3, db),
  ])

  // Managed client budgets (turnover): manual monthly KPI, summed over the period.
  const managed = await db.kpiActual.findMany({
    where: { organizationId: user.organizationId, scope: "ORGANIZATION", kpiDefinition: { code: "MANAGED_BUDGET" }, period: { startDate: { gte: r.from }, endDate: { lte: r.to } } },
    select: { actualValue: true },
  })
  const managedBudget = managed.length ? managed.reduce((a, m) => a.add(m.actualValue.toString()), new Decimal(0)).toString() : null

  // Upcoming payments: unpaid expenses (by due date), payroll owed, distributions owed.
  const unpaid = await db.transaction.findMany({
    where: { organizationId: user.organizationId, status: "POSTED", settlementStatus: { not: "PAID" }, type: { in: ["OPERATING_EXPENSE", "ASSET_PURCHASE"] } },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { date: "asc" }],
    take: 6,
    select: { id: true, description: true, amount: true, settledAmount: true, fxRateToBase: true, dueDate: true, counterparty: true },
  })
  const unpaidCosts = await db.projectCost.findMany({
    where: { project: { organizationId: user.organizationId }, journalEntryId: { not: null }, status: "INCURRED" },
    orderBy: { incurredDate: "asc" },
    take: 6,
    select: { id: true, description: true, baseAmount: true, incurredDate: true },
  })
  const upcoming = [
    ...(indicators.payrollPayable !== "0" ? [{ key: "payroll", label: "payroll", amount: indicators.payrollPayable, due: null as string | null, href: "/payroll" }] : []),
    ...(indicators.distributionsPayable !== "0" ? [{ key: "distributions", label: "distributions", amount: indicators.distributionsPayable, due: null as string | null, href: "/owners" }] : []),
    ...unpaid.map((t) => ({
      key: t.id,
      label: t.counterparty ? `${t.description} · ${t.counterparty}` : t.description,
      amount: new Decimal(t.amount.toString()).sub(t.settledAmount.toString()).mul(t.fxRateToBase.toString()).toDecimalPlaces(2).toString(),
      due: t.dueDate ? isoDate(t.dueDate) : null,
      href: "/transactions?status=POSTED",
    })),
    ...unpaidCosts.map((c) => ({ key: c.id, label: c.description, amount: c.baseAmount.toString(), due: isoDate(c.incurredDate), href: "/payroll" })),
  ].slice(0, 8)

  // Owners: allocations and payments this year.
  const allocations = user.permissions.has("ownership:read")
    ? await db.distributionAllocation.findMany({
        where: { distribution: { organizationId: user.organizationId, status: { in: ["APPROVED", "PAID"] }, declaredDate: { gte: new Date(Date.UTC(r.year, 0, 1)), lte: new Date(Date.UTC(r.year, 11, 31)) } } },
        include: { shareholder: { select: { name: true } } },
      })
    : []
  const owners = new Map<string, { name: string; allocated: Decimal; paid: Decimal }>()
  for (const a of allocations) {
    const o = owners.get(a.shareholderId) ?? { name: a.shareholder.name, allocated: new Decimal(0), paid: new Decimal(0) }
    o.allocated = o.allocated.add(a.amount.toString())
    if (a.paidAt) o.paid = o.paid.add(a.amount.toString())
    owners.set(a.shareholderId, o)
  }

  const current = pnl.current
  const target = budget.metric("NET_PROFIT")
  const reserve = budget.metric("CASH_RESERVE")
  const opexBudget = budget.metric("OPEX")

  const risks: Risk[] = []
  if (indicators.runwayMonths && Number(indicators.runwayMonths) < 3) risks.push({ key: "runway", level: "high", value: indicators.runwayMonths, href: "/cash-flow" })
  if (reserve && new Decimal(indicators.cash).lt(reserve)) risks.push({ key: "reserve", level: "high", value: new Decimal(indicators.cash).sub(reserve).toString(), href: "/cash-flow" })
  if (forecast.scenarios.BASE.some((m) => new Decimal(m.closing).isNegative())) risks.push({ key: "forecast", level: "high", value: null, href: "/cash-flow" })
  if (new Decimal(current.netProfit).isNegative()) risks.push({ key: "loss", level: "medium", value: current.netProfit, href: "/pnl" })
  if (indicators.overdueReceivables !== "0") risks.push({ key: "overdueReceivables", level: "medium", value: indicators.overdueReceivables, href: "/cash-flow" })
  if (indicators.overduePayables !== "0") risks.push({ key: "overduePayables", level: "medium", value: indicators.overduePayables, href: "/cash-flow" })
  if (opexBudget && new Decimal(current.operatingExpenses).gt(opexBudget)) risks.push({ key: "opexOverBudget", level: "medium", value: new Decimal(current.operatingExpenses).sub(opexBudget).toString(), href: "/budgets" })
  if (!bs.sheet.balanced) risks.push({ key: "unbalanced", level: "high", value: bs.sheet.difference, href: "/balance-sheet" })

  return {
    range: { key: r.key, from: isoDate(r.from), to: isoDate(r.to) },
    pnl: current,
    previous: pnl.previous,
    managedBudget,
    indicators,
    target,
    budget: {
      revenue: budget.metric("REVENUE"),
      directCosts: budget.metric("DIRECT_COSTS"),
      opex: opexBudget,
      ebitda: budget.metric("EBITDA"),
      netProfit: target,
    },
    series: series.map((s) => ({ month: s.month, revenue: s.pnl.revenue, expenses: s.pnl.totalExpenses, ebitda: s.pnl.ebitda, netProfit: s.pnl.netProfit, netCash: s.flow.netChange, closingCash: s.flow.closingCash })),
    departments: departments.map((d) => ({ id: d.id, name: d.name, netProfit: d.pnl.netProfit, revenue: d.pnl.revenue })),
    clients: clients.slice(0, 5),
    expenses: expenses.slice(0, 6),
    upcoming,
    risks,
    owners: [...owners.values()].map((o) => ({ name: o.name, allocated: o.allocated.toString(), paid: o.paid.toString(), outstanding: o.allocated.sub(o.paid).toString() })),
  }
}
