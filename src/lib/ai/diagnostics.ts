/**
 * Financial alerts for the AI CFO. Pure and deterministic: every alert is a rule over figures that
 * the report services already calculated, with the threshold that fired it. The AI only explains
 * what this returns; it does not decide what is a risk.
 */
import Decimal from "decimal.js"

export type PnlFigures = {
  revenue: string
  costOfServices: string
  grossProfit: string
  operatingExpenses: string
  ebitda: string
  netProfit: string
  margins: { gross: string | null; ebitda: string | null; net: string | null }
}

export type AlertInput = {
  /** Days in the period (for days-sales-outstanding). */
  days: number
  current: PnlFigures
  previous: PnlFigures
  payroll: { current: string; previous: string }
  /** Budget for the same period (BASE scenario); null where no budget is set. */
  budget: { revenue: string | null; directCosts: string | null; opex: string | null; payroll: string | null; ebitda: string | null; netProfit: string | null }
  cash: {
    cash: string
    runwayMonths: string | null
    reserve: string | null
    receivables: string
    overdueReceivables: string
    overduePayables: string
    payables: string
    payrollPayable: string
    taxes: string
    /** First forecast month (base scenario) with negative closing cash, if any. */
    negativeForecastMonth: string | null
  }
  departments: { id: string; name: string; revenue: string; netProfit: string; previousNetProfit: string | null }[]
  clients: { id: string; name: string; revenue: string }[]
  /** Payroll expense per department (ledger totals, never individual pay). */
  payrollByDepartment?: { id: string | null; name: string; current: string; previous: string }[]
  /** False when the comparison period has no posted data: period-over-period rules are skipped. */
  previousHasData?: boolean
}

export type Alert = {
  code:
    | "revenue_decline"
    | "opex_growth"
    | "payroll_growth"
    | "negative_gross_margin"
    | "negative_ebitda"
    | "net_loss"
    | "ebitda_margin_drop"
    | "profit_decline"
    | "budget_revenue_shortfall"
    | "budget_cost_overrun"
    | "budget_payroll_overrun"
    | "low_runway"
    | "below_cash_reserve"
    | "negative_cash_forecast"
    | "obligations_exceed_cash"
    | "unprofitable_department"
    | "department_profit_decline"
    | "overdue_receivables"
    | "high_receivables"
    | "overdue_payables"
    | "client_concentration"
    | "payroll_department_spike"
  severity: "high" | "medium" | "low"
  /** Figures behind the alert (base currency amounts as strings, percentages as numbers). */
  facts: Record<string, string | number | null>
  /** The rule that fired, in plain words (shown to the user next to the alert). */
  rule: string
  /** Department or client the alert is about. */
  subject?: { kind: "department" | "client"; id: string; name: string }
}

const D = (v: Decimal.Value) => new Decimal(v)
const pct = (current: Decimal.Value, previous: Decimal.Value) => {
  const p = D(previous)
  if (p.isZero()) return null
  return D(current).sub(p).div(p.abs()).mul(100).toDecimalPlaces(1).toNumber()
}

export const THRESHOLDS = {
  revenueDecline: { medium: -10, high: -25 },
  opexGrowth: { medium: 15, high: 30 },
  payrollGrowth: 10,
  marginDropPoints: 5,
  profitDecline: -25,
  budgetOverrun: { medium: 5, high: 15 },
  budgetShortfall: { medium: -10, high: -25 },
  runwayMonths: { medium: 6, high: 3 },
  dsoDays: 60,
  departmentPayrollGrowth: 25,
  concentration: { top1Medium: 30, top1High: 50, top3: 70 },
  /** Changes on amounts below this (base currency) are ignored as noise. */
  minAmount: 100,
}

export function financialAlerts(input: AlertInput): Alert[] {
  const T = THRESHOLDS
  const out: Alert[] = []
  const c = input.current
  const p = input.previous
  const material = (a: Decimal.Value, b: Decimal.Value) => D(a).sub(b).abs().gte(T.minAmount)
  // Without posted data in the comparison period, a "change" would be invented: skip those rules.
  const compare = input.previousHasData !== false

  // Revenue
  const revenueChange = compare ? pct(c.revenue, p.revenue) : null
  if (revenueChange !== null && revenueChange <= T.revenueDecline.medium && material(c.revenue, p.revenue)) {
    out.push({
      code: "revenue_decline",
      severity: revenueChange <= T.revenueDecline.high ? "high" : "medium",
      facts: { revenue: c.revenue, previousRevenue: p.revenue, changePct: revenueChange },
      rule: `Revenue fell ${revenueChange}% vs the previous period (alert at ${T.revenueDecline.medium}% or worse).`,
    })
  }

  // Operating expenses growing faster than revenue
  const opexChange = compare ? pct(c.operatingExpenses, p.operatingExpenses) : null
  if (opexChange !== null && opexChange >= T.opexGrowth.medium && opexChange > (revenueChange ?? 0) && material(c.operatingExpenses, p.operatingExpenses)) {
    out.push({
      code: "opex_growth",
      severity: opexChange >= T.opexGrowth.high ? "high" : "medium",
      facts: { operatingExpenses: c.operatingExpenses, previous: p.operatingExpenses, changePct: opexChange, revenueChangePct: revenueChange },
      rule: `Operating expenses grew ${opexChange}%, faster than revenue (alert at +${T.opexGrowth.medium}%).`,
    })
  }

  // Payroll growing faster than revenue
  const payrollChange = compare ? pct(input.payroll.current, input.payroll.previous) : null
  if (payrollChange !== null && payrollChange >= T.payrollGrowth && payrollChange > (revenueChange ?? 0) && material(input.payroll.current, input.payroll.previous)) {
    out.push({
      code: "payroll_growth",
      severity: "medium",
      facts: { payroll: input.payroll.current, previous: input.payroll.previous, changePct: payrollChange, revenueChangePct: revenueChange },
      rule: `Payroll expense grew ${payrollChange}%, faster than revenue (alert at +${T.payrollGrowth}%).`,
    })
  }

  // Margins
  if (D(c.grossProfit).isNegative()) out.push({ code: "negative_gross_margin", severity: "high", facts: { grossProfit: c.grossProfit, grossMarginPct: c.margins.gross }, rule: "Cost of services exceeds revenue (negative gross profit)." })
  if (D(c.ebitda).isNegative()) out.push({ code: "negative_ebitda", severity: "high", facts: { ebitda: c.ebitda, ebitdaMarginPct: c.margins.ebitda }, rule: "EBITDA is negative." })
  else if (D(c.netProfit).isNegative()) out.push({ code: "net_loss", severity: "medium", facts: { netProfit: c.netProfit, netMarginPct: c.margins.net }, rule: "Net result is a loss." })
  if (compare && c.margins.ebitda !== null && p.margins.ebitda !== null) {
    const drop = D(c.margins.ebitda).sub(p.margins.ebitda).toDecimalPlaces(1).toNumber()
    if (drop <= -T.marginDropPoints) {
      out.push({ code: "ebitda_margin_drop", severity: "medium", facts: { ebitdaMarginPct: c.margins.ebitda, previousPct: p.margins.ebitda, changePoints: drop }, rule: `EBITDA margin fell ${Math.abs(drop)} percentage points (alert at ${T.marginDropPoints}).` })
    }
  }
  const profitChange = compare && D(p.netProfit).isPositive() ? pct(c.netProfit, p.netProfit) : null
  if (profitChange !== null && profitChange <= T.profitDecline && material(c.netProfit, p.netProfit) && !D(c.netProfit).isNegative()) {
    out.push({ code: "profit_decline", severity: "medium", facts: { netProfit: c.netProfit, previous: p.netProfit, changePct: profitChange }, rule: `Net profit fell ${profitChange}% vs the previous period (alert at ${T.profitDecline}%).` })
  }

  // Budget variance
  const b = input.budget
  if (b.revenue !== null && D(b.revenue).isPositive()) {
    const v = pct(c.revenue, b.revenue)!
    if (v <= T.budgetShortfall.medium) out.push({ code: "budget_revenue_shortfall", severity: v <= T.budgetShortfall.high ? "high" : "medium", facts: { revenue: c.revenue, budget: b.revenue, variancePct: v }, rule: `Revenue is ${v}% vs budget (alert at ${T.budgetShortfall.medium}%).` })
  }
  for (const [key, actual, budget] of [
    ["operatingExpenses", c.operatingExpenses, b.opex],
    ["costOfServices", c.costOfServices, b.directCosts],
  ] as const) {
    if (budget === null || !D(budget).isPositive()) continue
    const v = pct(actual, budget)!
    if (v >= T.budgetOverrun.medium && material(actual, budget)) {
      out.push({ code: "budget_cost_overrun", severity: v >= T.budgetOverrun.high ? "high" : "medium", facts: { metric: key, actual, budget, variancePct: v, overrun: D(actual).sub(budget).toString() }, rule: `${key} is ${v}% over budget (alert at +${T.budgetOverrun.medium}%).` })
    }
  }
  if (b.payroll !== null && D(b.payroll).isPositive()) {
    const v = pct(input.payroll.current, b.payroll)!
    if (v >= T.budgetOverrun.medium && material(input.payroll.current, b.payroll)) {
      out.push({ code: "budget_payroll_overrun", severity: v >= T.budgetOverrun.high ? "high" : "medium", facts: { payroll: input.payroll.current, budget: b.payroll, variancePct: v }, rule: `Payroll is ${v}% over budget (alert at +${T.budgetOverrun.medium}%).` })
    }
  }

  // Cash
  const k = input.cash
  if (k.runwayMonths !== null && Number(k.runwayMonths) < T.runwayMonths.medium) {
    out.push({ code: "low_runway", severity: Number(k.runwayMonths) < T.runwayMonths.high ? "high" : "medium", facts: { cash: k.cash, runwayMonths: k.runwayMonths }, rule: `Cash covers ${k.runwayMonths} months of the recent average burn (alert below ${T.runwayMonths.medium}).` })
  }
  if (k.reserve !== null && D(k.cash).lt(k.reserve)) out.push({ code: "below_cash_reserve", severity: "high", facts: { cash: k.cash, reserve: k.reserve, shortfall: D(k.reserve).sub(k.cash).toString() }, rule: "Cash is below the budgeted cash reserve." })
  if (k.negativeForecastMonth) out.push({ code: "negative_cash_forecast", severity: "high", facts: { month: k.negativeForecastMonth }, rule: "The base-scenario cash forecast goes negative (forecast, not actual)." })
  const obligations = D(k.payables).add(k.payrollPayable).add(k.taxes)
  if (obligations.gt(k.cash) && obligations.gte(T.minAmount)) out.push({ code: "obligations_exceed_cash", severity: "high", facts: { cash: k.cash, payables: k.payables, payrollPayable: k.payrollPayable, taxes: k.taxes, obligations: obligations.toString() }, rule: "Payables, payroll and taxes owed exceed cash on hand." })

  // Receivables and payables
  if (D(k.overdueReceivables).gte(T.minAmount)) out.push({ code: "overdue_receivables", severity: "medium", facts: { overdueReceivables: k.overdueReceivables, receivables: k.receivables }, rule: "Customers owe amounts past their due date." })
  if (D(c.revenue).isPositive() && D(k.receivables).gte(T.minAmount)) {
    const dso = D(k.receivables).div(c.revenue).mul(input.days).toDecimalPlaces(0).toNumber()
    if (dso > T.dsoDays) out.push({ code: "high_receivables", severity: "low", facts: { receivables: k.receivables, revenue: c.revenue, daysSalesOutstanding: dso }, rule: `Receivables equal ${dso} days of revenue (alert above ${T.dsoDays}).` })
  }
  if (D(k.overduePayables).gte(T.minAmount)) out.push({ code: "overdue_payables", severity: "medium", facts: { overduePayables: k.overduePayables }, rule: "Bills are unpaid past their due date." })

  // Departments
  for (const d of input.departments) {
    const subject = { kind: "department" as const, id: d.id, name: d.name }
    if (D(d.netProfit).isNegative() && D(d.netProfit).abs().gte(T.minAmount)) {
      out.push({ code: "unprofitable_department", severity: "medium", subject, facts: { revenue: d.revenue, netProfit: d.netProfit }, rule: "The department's attributed costs exceed its attributed revenue." })
    } else if (compare && d.previousNetProfit !== null && D(d.previousNetProfit).isPositive()) {
      const change = pct(d.netProfit, d.previousNetProfit)
      if (change !== null && change <= T.profitDecline && material(d.netProfit, d.previousNetProfit)) out.push({ code: "department_profit_decline", severity: "low", subject, facts: { netProfit: d.netProfit, previous: d.previousNetProfit, changePct: change }, rule: `Department profit fell ${change}% (alert at ${T.profitDecline}%).` })
    }
  }

  // Payroll anomalies by department
  if (compare) {
    for (const d of input.payrollByDepartment ?? []) {
      const change = pct(d.current, d.previous)
      if (change !== null && change >= T.departmentPayrollGrowth && D(d.current).sub(d.previous).gte(T.minAmount * 5)) {
        out.push({
          code: "payroll_department_spike",
          severity: "medium",
          ...(d.id ? { subject: { kind: "department" as const, id: d.id, name: d.name } } : {}),
          facts: { payroll: d.current, previous: d.previous, changePct: change, revenueChangePct: revenueChange },
          rule: `Department payroll expense grew ${change}% vs the previous period (alert at +${T.departmentPayrollGrowth}%).`,
        })
      }
    }
  }

  // Client concentration
  const total = D(c.revenue)
  if (total.isPositive()) {
    const sorted = [...input.clients].filter((x) => D(x.revenue).isPositive()).sort((a, b) => D(b.revenue).cmp(a.revenue))
    if (sorted.length) {
      const top1 = D(sorted[0].revenue).div(total).mul(100).toDecimalPlaces(1).toNumber()
      const top3 = sorted.slice(0, 3).reduce((a, x) => a.add(x.revenue), D(0)).div(total).mul(100).toDecimalPlaces(1).toNumber()
      if (top1 >= T.concentration.top1Medium || (sorted.length > 3 && top3 >= T.concentration.top3)) {
        out.push({
          code: "client_concentration",
          severity: top1 >= T.concentration.top1High ? "high" : "medium",
          subject: { kind: "client", id: sorted[0].id, name: sorted[0].name },
          facts: { topClientSharePct: top1, top3SharePct: top3, revenue: c.revenue },
          rule: `The largest client brings ${top1}% of revenue, the top three ${top3}% (alert at ${T.concentration.top1Medium}% / ${T.concentration.top3}%).`,
        })
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// ─── Opportunities ───────────────────────────────────────────────────────────

export type OpportunityInput = {
  revenue: string
  grossMarginPct: string | null
  totalExpenses: string
  /** Expense lines (accounts) with the comparison-period amount. */
  expenses: { accountId: string; account: string; section: string; current: string; previous: string }[]
  clients: { id: string; name: string; revenue: string; contribution: string }[]
  departments: { id: string; name: string; revenue: string; netProfit: string }[]
  previousHasData: boolean
}

export type Opportunity = {
  code: "expense_back_to_previous" | "low_margin_client" | "department_to_breakeven" | "large_cost_line"
  /** Estimated improvement of EBITDA for the period if the action fully succeeds (a calculated scenario, not a fact). */
  estimatedImpact: string
  subject: { kind: "account" | "client" | "department"; id: string; name: string }
  facts: Record<string, string | number | null>
  basis: string
}

export const OPPORTUNITY_RULES = { expenseGrowthPct: 20, minShareOfExpensesPct: 3, clientMinShareOfRevenuePct: 5, largeLineSharePct: 10, largeLineCutPct: 10 }

/**
 * Margin-improvement opportunities, each with a calculated impact and the arithmetic behind it. Only
 * from posted figures; nothing is suggested for lines, clients or departments without data.
 */
export function marginOpportunities(input: OpportunityInput): Opportunity[] {
  const R = OPPORTUNITY_RULES
  const out: Opportunity[] = []
  const total = D(input.totalExpenses)
  const revenue = D(input.revenue)
  const share = (v: Decimal.Value, of: Decimal) => (of.isPositive() ? D(v).div(of).mul(100).toDecimalPlaces(1).toNumber() : 0)

  if (input.previousHasData) {
    for (const e of input.expenses) {
      const growth = pct(e.current, e.previous)
      const diff = D(e.current).sub(e.previous)
      if (growth !== null && growth >= R.expenseGrowthPct && diff.gte(THRESHOLDS.minAmount) && share(e.current, total) >= R.minShareOfExpensesPct) {
        out.push({ code: "expense_back_to_previous", estimatedImpact: diff.toString(), subject: { kind: "account", id: e.accountId, name: e.account }, facts: { current: e.current, previous: e.previous, changePct: growth }, basis: `Returning this line to its previous-period level saves ${diff.toString()}.` })
      }
    }
  }

  if (input.grossMarginPct !== null && revenue.isPositive()) {
    const companyMargin = D(input.grossMarginPct)
    for (const c of input.clients) {
      if (!D(c.revenue).isPositive() || share(c.revenue, revenue) < R.clientMinShareOfRevenuePct) continue
      const margin = D(c.contribution).div(c.revenue).mul(100)
      if (margin.lt(companyMargin.div(2))) {
        const impact = D(c.revenue).mul(companyMargin.sub(margin)).div(100).toDecimalPlaces(2)
        out.push({ code: "low_margin_client", estimatedImpact: impact.toString(), subject: { kind: "client", id: c.id, name: c.name }, facts: { revenue: c.revenue, contribution: c.contribution, contributionMarginPct: margin.toDecimalPlaces(1).toNumber(), companyGrossMarginPct: companyMargin.toNumber() }, basis: `Raising this client's contribution margin to the company gross margin (${companyMargin.toString()}%) adds ${impact.toString()}.` })
      }
    }
  }

  for (const d of input.departments) {
    if (D(d.netProfit).isNegative() && D(d.netProfit).abs().gte(THRESHOLDS.minAmount)) {
      out.push({ code: "department_to_breakeven", estimatedImpact: D(d.netProfit).abs().toString(), subject: { kind: "department", id: d.id, name: d.name }, facts: { revenue: d.revenue, netProfit: d.netProfit }, basis: "Bringing the department to break-even removes its loss from company profit." })
    }
  }

  const large = input.expenses.filter((e) => e.section === "operatingExpenses" && share(e.current, total) >= R.largeLineSharePct).sort((a, b) => D(b.current).cmp(a.current)).slice(0, 3)
  for (const e of large) {
    const impact = D(e.current).mul(R.largeLineCutPct).div(100).toDecimalPlaces(2)
    out.push({ code: "large_cost_line", estimatedImpact: impact.toString(), subject: { kind: "account", id: e.accountId, name: e.account }, facts: { current: e.current, shareOfExpensesPct: share(e.current, total) }, basis: `A ${R.largeLineCutPct}% reduction of one of the largest operating cost lines saves ${impact.toString()}.` })
  }

  return out.sort((a, b) => D(b.estimatedImpact).cmp(a.estimatedImpact))
}
