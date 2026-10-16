import "server-only"

import type { SessionUser } from "@/lib/auth/session"
import { prisma, type Db } from "@/lib/data/db"
import type { Range } from "@/lib/reports/periods"

import type { Alert } from "./diagnostics"
import type { Completeness, SourceRef } from "./envelope"
import type { ForecastResult } from "./forecast"
import { FINANCIAL_TOOLS, runTool } from "./tools"

/*
 * Monthly CFO report: ten sections built only from the deterministic tools (the same numbers as the
 * pages and the AI). Recommended actions are rule-based, derived from the alerts that fired; an
 * optional AI commentary is generated separately and labelled as such.
 */

type Section<T> = { available: true; values: T; sources: SourceRef[]; completeness: Completeness } | { available: false; permission: string }

async function section<T>(user: SessionUser, name: string, input: Record<string, unknown>, db: Db): Promise<Section<T>> {
  const tool = FINANCIAL_TOOLS.find((t) => t.name === name)!
  if (!user.permissions.has(tool.permission)) return { available: false, permission: tool.permission }
  const r = await runTool(user, name, input, db)
  return { available: true, values: r.values as T, sources: r.sources, completeness: r.completeness }
}

type Change = { previous: string; changePct: string | null; difference: string }
type Totals = { revenue: string; costOfServices: string; grossProfit: string; operatingExpenses: string; ebitda: string; depreciationAndAmortization: string; ebit: string; otherIncomeAndExpense: string; profitBeforeTax: string; incomeTax: string; netProfit: string; marginsPct: { gross: string | null; ebitda: string | null; ebit: string | null; net: string | null } }

export type ReportData = Awaited<ReturnType<typeof monthlyReport>>

export async function monthlyReport(user: SessionUser, r: Range, db: Db = prisma) {
  const p = { period: r.key }
  const summary = await section<{ current: Totals; vsPreviousPeriod: Record<string, Change | string>; vsYearAgo: Record<string, Change>; cash: { openingCash: string; closingCash: string; netCashFlow: string; operatingCashFlow: string; reconciledWithAccounts: boolean }; liquidity: { averageMonthlyBurn: string; runwayMonths: string | null; receivables: string; payables: string; payrollPayable: string } }>(user, "getFinancialSummary", p, db)
  const clients = await section<{ totalRevenue: string; clients: { client: string; revenue: string; shareOfRevenuePct: string | null; revenueChangePct: string | null; contribution: string }[]; clientCount: number; concentration: { largestClientSharePct: string | null; top3SharePct: string | null }; lostClients: { client: string; previousRevenue: string }[]; notAttributedToClients: string }>(user, "getRevenueByClient", { ...p, limit: 8 }, db)
  const expenses = await section<{ totalExpenses: string; previousTotalExpenses: string; totalChangePct: string | null; bySection: Record<string, { current: string; previous: string; changePct: string | null }>; lines: { account: string; section: string; amount: string; shareOfExpensesPct: string | null; previous: string; changePct: string | null }[] }>(user, "getExpensesByCategory", p, db)
  const departments = await section<{ departments: { department: string; revenue: string; ebitda: string; netProfit: string; marginsPct: { net: string | null }; previousNetProfit: string | null; netProfitChangePct: string | null }[]; notAttributedToDepartments: { revenue: string; netProfit: string } }>(user, "getDepartmentProfitability", p, db)
  const ebitda = await section<{ ebitda: string; marginPct: string | null; comparison: { period: string; ebitda: string; changePct: string | null; difference: string }; drivers: { account: string; current: string; previous: string; profitEffect: string }[] }>(user, "getEBITDA", p, db)
  const ebit = await section<{ ebit: string; marginPct: string | null; depreciationAndAmortization: string }>(user, "getEBIT", p, db)
  const cash = await section<{ openingCash: string; operating: string; investing: string; financing: string; netChange: string; closingCash: string; inflow: string; outflow: string; reconciledWithAccounts: boolean; lines: Record<string, string>; indicators: { burn: string; runwayMonths: string | null; receivables: string; payables: string; overdueReceivables: string; overduePayables: string } }>(user, "getCashFlow", p, db)
  const alerts = await section<{ alerts: Alert[] }>(user, "getFinancialAlerts", p, db)
  const budget = await section<{ budgetSet: boolean; metrics: { metric: string; actual: string | null; budget: string | null; variance: string | null; variancePct: string | null; favourable: boolean | null }[] }>(user, "getBudgetVariance", p, db)
  const forecast = await section<ForecastResult>(user, "getFinancialForecast", { months: 3 }, db)
  return { period: r.key, from: r.from.toISOString().slice(0, 10), to: r.to.toISOString().slice(0, 10), currency: user.baseCurrency, summary, clients, expenses, departments, ebitda, ebit, cash, alerts, budget, forecast }
}
