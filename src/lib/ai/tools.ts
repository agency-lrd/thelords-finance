import "server-only"

import type { Permission } from "@/lib/authz/permissions"
import type { SessionUser } from "@/lib/auth/session"
import { listOwners } from "@/lib/data/owners"
import { listTransactions } from "@/lib/data/transactions"
import { prisma } from "@/lib/db"
import { UserInputError } from "@/lib/forms"
import { clientProfitability, expenseStructure, monthlyAnalytics } from "@/lib/reports/analytics"
import { cashForecast } from "@/lib/reports/cash"
import { accountActivity, balanceSheetReport, cashFlowReport, departmentPnl, monthlyActivity, pnlReport } from "@/lib/reports/ledger"
import { currentRange, parseRange } from "@/lib/reports/periods"
import { buildPnl, growth } from "@/lib/reports/statements"

import { detectAnomalies } from "./anomalies"

/*
 * Financial query tools for the AI CFO. Each tool is a deterministic backend call with a JSON schema,
 * a required permission and a handler that returns figures computed by the same report services as
 * the pages. The model may only choose tools and explain their results; it never computes or invents
 * accounting numbers itself, and it can only see what the signed-in user is allowed to see.
 */

type Json = Record<string, unknown>
export type FinancialTool = {
  name: string
  description: string
  permission: Permission
  input_schema: { type: "object"; properties: Record<string, Json>; required?: string[] }
  run: (user: SessionUser, input: Json) => Promise<unknown>
}

const periodProp = { period: { type: "string", description: 'Period: "2026-05" (month), "2026-Q2" (quarter) or "2026" (year). Default: current month.' } }
const period = (input: Json) => parseRange(typeof input.period === "string" ? input.period : null, currentRange("month"))
const uuid = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

export const FINANCIAL_TOOLS: FinancialTool[] = [
  {
    name: "get_profit_and_loss",
    description: "P&L for a period: revenue, cost of services, gross profit, operating expenses, EBITDA, EBIT, profit before tax, net profit, margins, account lines, with previous period and year-ago comparison. Optional department or client filter.",
    permission: "reports:read",
    input_schema: { type: "object", properties: { ...periodProp, department_id: { type: "string" }, client_id: { type: "string" } } },
    run: (user, input) => pnlReport(user, period(input), { departmentId: uuid(input.department_id), clientId: uuid(input.client_id) }),
  },
  {
    name: "get_cash_flow",
    description: "Direct-method cash flow for a period: opening cash, operating/investing/financing lines, net change, closing cash and whether it reconciles with account balances.",
    permission: "reports:read",
    input_schema: { type: "object", properties: periodProp },
    run: (user, input) => cashFlowReport(user, period(input)),
  },
  {
    name: "get_balance_sheet",
    description: "Management balance sheet at a date (YYYY-MM-DD): assets, liabilities, equity, and whether assets = liabilities + equity.",
    permission: "reports:read",
    input_schema: { type: "object", properties: { date: { type: "string" } } },
    run: (user, input) => balanceSheetReport(user, typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? new Date(`${input.date}T00:00:00Z`) : new Date()),
  },
  {
    name: "get_monthly_analytics",
    description: "Monthly analytics for a year: clients, employees, average salary, NPS, managed budgets, revenue, gross profit, payroll, marketing, EBITDA, EBIT, net profit, cash in/out, closing cash.",
    permission: "reports:read",
    input_schema: { type: "object", properties: { year: { type: "integer" } }, required: ["year"] },
    run: (user, input) => monthlyAnalytics(user, Number(input.year) || new Date().getUTCFullYear()),
  },
  {
    name: "get_department_profitability",
    description: "P&L per department for a period (from the department dimension on journal lines).",
    permission: "reports:read",
    input_schema: { type: "object", properties: periodProp },
    run: (user, input) => departmentPnl(user, period(input)),
  },
  {
    name: "get_client_profitability",
    description: "Revenue, direct costs and contribution per client for a period, most profitable first. Negative profit means negative margin.",
    permission: "reports:read",
    input_schema: { type: "object", properties: periodProp },
    run: (user, input) => clientProfitability(user, period(input)),
  },
  {
    name: "get_expense_structure",
    description: "Expense accounts for a period, largest first.",
    permission: "reports:read",
    input_schema: { type: "object", properties: periodProp },
    run: (user, input) => expenseStructure(user, period(input)),
  },
  {
    name: "get_cash_forecast",
    description: "3-month cash forecast in conservative, base and aggressive scenarios (labelled forecast, not actuals), with the assumptions used.",
    permission: "reports:read",
    input_schema: { type: "object", properties: {} },
    run: (user) => cashForecast(user, new Date(), 3),
  },
  {
    name: "get_owners",
    description: "Owners with ownership and profit participation, capital contributed, distributions allocated, paid and outstanding.",
    permission: "ownership:read",
    input_schema: { type: "object", properties: {} },
    run: (user) => listOwners(user),
  },
  {
    name: "list_transactions",
    description: "Manual transactions with optional search text and period (source records for explanations).",
    permission: "ledger:read",
    input_schema: { type: "object", properties: { ...periodProp, search: { type: "string" } } },
    run: (user, input) => {
      const r = period(input)
      return listTransactions(user, { from: r.from, to: r.to, search: typeof input.search === "string" ? input.search.slice(0, 100) : null })
    },
  },
  {
    name: "detect_anomalies",
    description: "Expense and revenue accounts whose amount in the given month deviates strongly from the previous three months.",
    permission: "reports:read",
    input_schema: { type: "object", properties: { year: { type: "integer" }, month: { type: "integer" } }, required: ["year", "month"] },
    run: (user, input) => anomalies(user, Number(input.year), Number(input.month)),
  },
]

/** Runs a tool for a user, enforcing the tool's permission server-side. */
export async function runTool(user: SessionUser, name: string, input: Json) {
  const tool = FINANCIAL_TOOLS.find((t) => t.name === name)
  if (!tool) throw new UserInputError(`Unknown tool ${name}`)
  if (!user.permissions.has(tool.permission)) throw new UserInputError(`Not allowed: ${tool.permission}`)
  return tool.run(user, input ?? {})
}

/** Tools the user may use (what an AI session for this user would be given). */
export function toolsFor(user: SessionUser) {
  return FINANCIAL_TOOLS.filter((t) => user.permissions.has(t.permission))
}

export async function anomalies(user: SessionUser, year: number, month: number) {
  const byMonth = await monthlyActivity(prisma, user.organizationId, year)
  const lines = new Map<string, { key: string; name: string; series: { month: number; value: string }[] }>()
  for (const [m, activity] of byMonth) {
    for (const a of activity.filter((x) => x.type === "EXPENSE" || x.type === "REVENUE")) {
      const line = lines.get(a.accountId) ?? { key: a.accountId, name: `${a.code} ${a.name}`, series: [] }
      const value = a.type === "EXPENSE" ? Number(a.debit) - Number(a.credit) : Number(a.credit) - Number(a.debit)
      line.series.push({ month: m, value: String(value) })
      lines.set(a.accountId, line)
    }
  }
  return detectAnomalies([...lines.values()], month)
}

/**
 * Deterministic month summary (no AI): the facts an AI CFO would explain, as structured items with
 * the numbers already computed.
 */
export async function monthSummary(user: SessionUser) {
  const r = currentRange("month")
  const report = await pnlReport(user, r)
  const p = report.current
  const ytd = buildPnl(await accountActivity(prisma, user.organizationId, new Date(Date.UTC(r.year, 0, 1)), r.to))
  const flow = await cashFlowReport(user, r)
  const found = await anomalies(user, r.year, r.index)
  return {
    period: r.key,
    revenue: p.revenue,
    revenueGrowth: growth(p.revenue, report.previous.revenue),
    ebitda: p.ebitda,
    ebitdaMargin: p.margins.ebitda,
    netProfit: p.netProfit,
    netProfitGrowth: growth(p.netProfit, report.previous.netProfit),
    netProfitYtd: ytd.netProfit,
    closingCash: flow.flow.closingCash,
    netCash: flow.flow.netChange,
    reconciled: flow.reconciled,
    anomalies: found.slice(0, 5),
  }
}
